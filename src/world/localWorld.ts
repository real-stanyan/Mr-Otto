// LocalWorld — ExecutionWorld 的本机实现。
// 整个项目里唯一允许 import node:fs / child_process 的地方（工具层禁入）。
// node-pty 同理：只在这里 import（动态），别处一律经 ExecutionWorld.openTerminal。
// root 选项 = 软沙箱：文件操作圈在工程文件夹内，越界抛错。
// exec 只把 cwd 设为 root（挡不住 `cd ..`，诚实说明）——硬隔离是 v2 Docker world 的活。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import type { ExecutionWorld, ExecResult, TerminalSession } from "./executionWorld.js";
import type { LiveGroupRegistry } from "./liveGroups.js";
import { stripSecretEnv } from "../shared/secretEnv.js";
import { loginShellPath } from "./loginShellEnv.js";
import { HeadTailBuffer } from "../shared/headTail.js";

/** exec 输出的内存上限（字符，每条流各一份，头尾各半）——三层截断的第一层
    （issue #343）。与 IPC 限流（shared/execStream.ts）、模型可见预算（tools/bash.ts）
    **分开配置**：这个数管的是主进程内存和日志体量，调小模型预算不该让日志变瞎。
    旧实现是 execAsync 默认 maxBuffer=1MiB **超限直接杀进程**——命令没跑完、
    尾部（往往是最终结果）全丢；HeadTail 让进程跑到自然结束，只丢中段 */
const EXEC_BUFFER_CAP = 1_000_000;

/** 杀整个进程组（负 pid）。组已死是常态不是错误（issue #759）。
    detached:true 起的子进程是组长（pgid = child.pid），全组连坐堵住
    「SIGTERM 只打 shell、`&` 起的孙进程被 reparent 到 launchd 逃逸」的洞 */
export function killGroup(pgid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try { process.kill(-pgid, signal); } catch { /* 组已死 */ }
}

/** SIGTERM 后的宽限：组里还有硬骨头就 SIGKILL 补刀 */
const KILL_GRACE_MS = 5_000;

/** 探组存活：EPERM 也算活着（有进程但无权限，本 app 起的组不该出现） */
export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** 后台执行的超时（issue #389）：无限 = 泄漏出走的进程，30 秒 = 后台没意义。
    30 分钟够全量构建/测试跑完 */
const DETACHED_TIMEOUT_MS = 1_800_000;

/** 把 path 解析到 root 下并验证没越界；没配 root = 不设防（旧行为）。
    what：错误文案里叫什么围栏——fs 用「工程文件夹」，config 用「配置目录」 */
function fence(root: string | undefined, path: string, what = "工程文件夹"): string {
  if (!root) return path;
  const abs = resolve(root, path); // 相对路径落在 root 下，绝对路径原样解析
  const rel = relative(root, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) {
    throw new Error(`路径越出${what}（${root}）: ${path}`);
  }
  return abs;
}

export function createLocalWorld(
  opts: {
    root?: string;
    fetchImpl?: typeof fetch;
    /** 起子进程前现问一次：哪些 process.env 变量是 otter 注入的凭据（issue #153）。
        缺省 = 全局登记处（keyVault.applyToEnv 写进去的那些）。可注入是为了测试
        不必碰全局状态。返回空数组 = 什么都不摘（旧行为） */
    secretEnvNames?: () => readonly string[];
    /** 用户级配置目录（如 ~/.mr-otto）。给了才挂 config 能力——记忆文件跨
        workspace 共享，圈在这里而不是 root（工程文件夹）内 */
    configRoot?: string;
    /** 子进程该用的 PATH（issue #453）。缺省 = 全局登记处（启动时 prime 过的
        登录 shell PATH）；返回 null = 维持原样继承。可注入是为了测试不碰全局态 */
    loginPath?: () => string | null;
    /** 进程组登记表（issue #759）。给了才登记活组、探活逃逸组。缺省 = 不登记 */
    liveGroups?: LiveGroupRegistry;
  } = {}
): ExecutionWorld {
  const { root } = opts;
  const liveGroups = opts.liveGroups;
  // 每次起子进程都现算一遍：名单会随用户在设置页存/清 key 而变，
  // 装配时抓一次快照就会留下一个"配 key 之前建的会话永远不设防"的窟窿。
  // PATH 同理现问：prime 是异步的，装配时快照会把「还没取到」定格成永远没有
  const childEnv = (extra: Record<string, string> = {}): Record<string, string> => {
    const path = (opts.loginPath ?? loginShellPath)();
    return {
      ...stripSecretEnv(process.env, opts.secretEnvNames?.()),
      // Dock 起的 app 只有 launchd 的最小 PATH，npm/node 全 127（issue #453）；
      // 登录 shell 那份才是用户心里的"我的 PATH"。exec / execDetached / 终端
      // 三个出口同源，都从这儿走
      ...(path ? { PATH: path } : {}),
      ...extra,
    };
  };
  return {
    fs: {
      // async 包一层：fence 的同步抛错变成 Promise rejection（接口约定返回 Promise，
      // 同步 throw 会炸在调用点而不是 await 点——工具层的 try/catch 就接不住了）
      read: async (path) => readFile(fence(root, path), "utf8"),
      write: async (path, content) => writeFile(fence(root, path), content, "utf8"),
    },

    exec(cmd, opts): Promise<ExecResult> {
      // spawn + HeadTail 而不是 execAsync（issue #343）：exec 的 maxBuffer 超限
      // 会直接杀进程（默认 1MiB），死循环打印的命令拿不到任何结果；HeadTail
      // 内存有界且**读到 EOF**——不停读，管道不会 back-pressure 卡死子进程
      const timeoutMs = opts?.timeoutMs ?? 30_000;
      return new Promise<ExecResult>((done, fail) => {
        // 调用时 signal 已经 aborted：AbortSignal 不会向事后注册的 listener 重放
        // 已发生的 abort，"abort" 事件永远不会触发，killGroup 也就永远不会被调用
        // ——旧的原生 signal 选项会在 spawn 时就直接判一次，这里补回同等语义：
        // 同步短路、连子进程都不起，不然命令会一直跑到 timeoutMs 才被动收口
        if (opts?.signal?.aborted) {
          fail(new Error("命令被中断：用户停止了 turn，调用时已中止（未起进程）"));
          return;
        }
        const child = spawn(cmd, {
          shell: true,
          detached: true,            // 独立进程组，组长 pgid = child.pid
          // timeout / killSignal / signal 三个原生选项全部移除——它们只打直接子进程，
          // 改为下面自管：到点/中断 killGroup 全组连坐
          // 凭据不跟着子进程出去：bash 工具和终端是同一个向量,一句 echo 就够
          // （issue #153）。其余原样继承——PATH/nvm/语言设置都在里面
          env: childEnv(),
          ...(root ? { cwd: root } : {}),
        });
        const pgid = child.pid;      // detached 下 spawn 同步拿到组长 pid
        if (pgid) liveGroups?.register(pgid, cmd, "exec");
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (pgid) {
            killGroup(pgid, "SIGTERM");
            setTimeout(() => { if (groupAlive(pgid)) killGroup(pgid, "SIGKILL"); }, KILL_GRACE_MS).unref();
          }
        }, timeoutMs);
        const onAbort = () => { if (pgid) killGroup(pgid, "SIGTERM"); };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        // stdin（issue #395 用户钩子）：给了就写完即关；EPIPE（命令不读就退出）
        // 是常态不是错误，吞掉——裁决看 exit code 和输出，不看喂没喂进去
        if (opts?.stdin !== undefined) {
          child.stdin?.on("error", () => {});
          child.stdin?.write(opts.stdin);
          child.stdin?.end();
        }
        const out = new HeadTailBuffer(EXEC_BUFFER_CAP);
        const err = new HeadTailBuffer(EXEC_BUFFER_CAP);
        const onOutput = opts?.onOutput;
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        // 直播与缓冲同源旁听:data 事件可多方订阅,直播丢一段也不丢事实
        child.stdout?.on("data", (chunk: string) => {
          out.push(chunk);
          onOutput?.(chunk, "stdout");
        });
        child.stderr?.on("data", (chunk: string) => {
          err.push(chunk);
          onOutput?.(chunk, "stderr");
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", onAbort);
          // 中断不是命令自己的失败——被杀是外力，必须抛出去按 error 结果落盘（ADR-0006）
          if (opts?.signal?.aborted) {
            fail(new Error("命令被中断：用户停止了 turn，进程已被终止（SIGTERM）"));
            return;
          }
          // 起不来（shell 不存在等）:按"世界的正常反馈"返回,和旧 execAsync 一致
          done({ stdout: out.text(), stderr: e.message, exitCode: 1 });
        });
        child.on("close", (code, signal) => {
          if (pgid) liveGroups?.noteClosed(pgid);
          clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", onAbort);
          if (opts?.signal?.aborted) {
            fail(new Error("命令被中断：用户停止了 turn，进程已被终止（SIGTERM）"));
            return;
          }
          if (timedOut || signal !== null) {
            // 不是用户中断却挨了信号 = 超时被 killGroup 终止（或外力 kill）。
            // 按世界反馈返回:HeadTail 里已经攒下的输出照给,模型能看到跑到哪了
            done({
              stdout: out.text(),
              stderr: `${err.text()}\n[进程被 ${signal} 终止（超时 ${Math.round(timeoutMs / 1000)}s 或外部 kill）]`.trim(),
              exitCode: 124,
            });
            return;
          }
          done({ stdout: out.text(), stderr: err.text(), exitCode: code ?? 1 });
        });
      });
    },

    // 后台执行（issue #389）：exec 的孪生减配版——不绑 turn 信号（跨 turn 存活
    // 是它存在的意义）、不接直播、超时放宽到 30 分钟（无限 = 泄漏出走的进程；
    // 30 分钟够全量构建/测试，真要更久的活该上 CI）。同款 HeadTail 有界缓冲、
    // 同款"被信号杀 = exitCode 124 + stderr 标注"语义。
    // detached:true 同 exec（issue #759）：不然命令里 `&` 起的孙进程在超时时
    // 只会看着 shell 死掉、自己被 reparent 到 launchd 逃逸——这正是 exec 要堵的洞，
    // execDetached 没理由留着。app 退出时孤儿风险与 exec 相同，接受它换全组硬杀
    execDetached(cmd: string): Promise<ExecResult> {
      return new Promise<ExecResult>((done) => {
        const child = spawn(cmd, {
          shell: true,
          detached: true,          // 独立进程组，组长 pgid = child.pid
          env: childEnv(),
          ...(root ? { cwd: root } : {}),
        });
        const pgid = child.pid;
        if (pgid) liveGroups?.register(pgid, cmd, "detached");
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (pgid) {
            killGroup(pgid, "SIGTERM");
            setTimeout(() => { if (groupAlive(pgid)) killGroup(pgid, "SIGKILL"); }, KILL_GRACE_MS).unref();
          }
        }, DETACHED_TIMEOUT_MS);
        const out = new HeadTailBuffer(EXEC_BUFFER_CAP);
        const err = new HeadTailBuffer(EXEC_BUFFER_CAP);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => out.push(chunk));
        child.stderr?.on("data", (chunk: string) => err.push(chunk));
        child.on("error", (e) => {
          clearTimeout(timer);
          done({ stdout: out.text(), stderr: e.message, exitCode: 1 });
        });
        child.on("close", (code, signal) => {
          if (pgid) liveGroups?.noteClosed(pgid);
          clearTimeout(timer);
          if (timedOut || signal !== null) {
            done({
              stdout: out.text(),
              stderr: `${err.text()}\n[进程被 ${signal} 终止（后台超时 30 分钟或外部 kill）]`.trim(),
              exitCode: 124,
            });
            return;
          }
          done({ stdout: out.text(), stderr: err.text(), exitCode: code ?? 1 });
        });
      });
    },

    http: {
      async postJson(url, body, o) {
        const fetchImpl = opts.fetchImpl ?? fetch;
        // 30s 超时与外部中断信号合并;两者都能掐死请求
        const timeout = AbortSignal.timeout(30_000);
        const signal = o?.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
        let res: Response;
        try {
          res = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...o?.headers },
            body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          // 中断是外力,不是请求自身失败——语义对齐 exec(ADR-0006)
          if (o?.signal?.aborted) throw new Error("请求被中断：用户停止了 turn");
          throw err;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        return res.json();
      },

      async getJson(url, o) {
        const fetchImpl = opts.fetchImpl ?? fetch;
        // 30s 超时与外部中断信号合并;两者都能掐死请求（同 postJson）
        const timeout = AbortSignal.timeout(30_000);
        const signal = o?.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
        let res: Response;
        try {
          res = await fetchImpl(url, { method: "GET", headers: { ...o?.headers }, signal });
        } catch (err) {
          // 中断是外力,不是请求自身失败——语义对齐 exec(ADR-0006)
          if (o?.signal?.aborted) throw new Error("请求被中断：用户停止了 turn");
          throw err;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        return res.json();
      },
    },

    async openTerminal(o): Promise<TerminalSession> {
      // 动态 import:node-pty 是原生模块,顶层 import 会让每个碰到 localWorld 的
      // 测试都必须能在当前 ABI 下加载它(electron-rebuild 之后就加载不了)。
      // 终端是低频入口,晚一点加载零代价。
      const pty = await import("node-pty");
      const spawn = (pty as unknown as { default?: typeof pty }).default?.spawn ?? pty.spawn;
      const shell = o.shell ?? process.env.SHELL ?? "/bin/zsh";
      const child = spawn(shell, [], {
        name: "xterm-256color",
        cols: o.cols,
        rows: o.rows,
        ...(root ? { cwd: root } : {}),
        // TERM 让 CLI 上色;其余原样继承——用户的 PATH/nvm/别名都在里面,
        // 剥干净了这个终端就不是"他自己的终端"了。
        // 唯一的例外是 otter 自己注入的那几把 API key（issue #153）：它们不属于
        // 用户的 shell 环境,是 keyVault 明文写进 process.env 的,留着等于让
        // agent 的一句 `echo $DEEPSEEK_API_KEY` 读到明文。用户自己 profile 里
        // 真有同名变量的话,shell 起来后会自己 source 回去——摘掉的只是注入的那份
        env: childEnv({ TERM: "xterm-256color" }),
      });
      return {
        write: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
        // 已经死掉的进程再 kill 会抛;终端关闭路径上这是常态,不是错误
        kill: () => { try { child.kill(); } catch { /* 已经死了 */ } },
        onData: (cb) => { const d = child.onData(cb); return () => d.dispose(); },
        onExit: (cb) => { const d = child.onExit(({ exitCode }) => cb(exitCode)); return () => d.dispose(); },
      };
    },

    ...(opts.configRoot
      ? {
          config: {
            read: async (rel: string) => {
              try {
                return await readFile(fence(opts.configRoot, rel, "配置目录"), "utf8");
              } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw err;
              }
            },
            write: async (rel: string, content: string) => {
              const abs = fence(opts.configRoot, rel, "配置目录");
              await mkdir(dirname(abs), { recursive: true });
              await writeFile(abs, content, "utf8");
            },
          },
        }
      : {}),
  };
}
