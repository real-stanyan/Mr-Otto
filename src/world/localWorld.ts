// LocalWorld — ExecutionWorld 的本机实现。
// 整个项目里唯一允许 import node:fs / child_process 的地方（工具层禁入）。
// node-pty 同理：只在这里 import（动态），别处一律经 ExecutionWorld.openTerminal。
// root 选项 = 软沙箱：文件操作圈在工程文件夹内，越界抛错。
// exec 只把 cwd 设为 root（挡不住 `cd ..`，诚实说明）——硬隔离是 v2 Docker world 的活。

import { readFile, writeFile } from "node:fs/promises";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
import type { ExecutionWorld, ExecResult, TerminalSession } from "./executionWorld.js";

const execAsync = promisify(cpExec);

/** 把 path 解析到 root 下并验证没越界；没配 root = 不设防（旧行为） */
function fence(root: string | undefined, path: string): string {
  if (!root) return path;
  const abs = resolve(root, path); // 相对路径落在 root 下，绝对路径原样解析
  const rel = relative(root, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) {
    throw new Error(`路径越出工程文件夹（${root}）: ${path}`);
  }
  return abs;
}

export function createLocalWorld(opts: { root?: string; fetchImpl?: typeof fetch } = {}): ExecutionWorld {
  const { root } = opts;
  return {
    fs: {
      // async 包一层：fence 的同步抛错变成 Promise rejection（接口约定返回 Promise，
      // 同步 throw 会炸在调用点而不是 await 点——工具层的 try/catch 就接不住了）
      read: async (path) => readFile(fence(root, path), "utf8"),
      write: async (path, content) => writeFile(fence(root, path), content, "utf8"),
    },

    async exec(cmd, opts): Promise<ExecResult> {
      try {
        const pending = execAsync(cmd, {
          timeout: 30_000,
          ...(root ? { cwd: root } : {}),
          // child_process 原生认 signal：abort = 给进程组发 SIGTERM
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        // 直播搭车：promisify(exec) 的 promise 挂着 .child，旁听它的输出流。
        // exec 自己的缓冲收集不受影响——data 事件可以多方订阅，
        // 完整结果仍从 await 拿（直播丢一段也不丢事实）
        const onOutput = opts?.onOutput;
        if (onOutput) {
          pending.child.stdout?.setEncoding("utf8");
          pending.child.stderr?.setEncoding("utf8");
          pending.child.stdout?.on("data", (chunk: string) => onOutput(chunk, "stdout"));
          pending.child.stderr?.on("data", (chunk: string) => onOutput(chunk, "stderr"));
        }
        const { stdout, stderr } = await pending;
        return { stdout, stderr, exitCode: 0 };
      } catch (err) {
        // 中断不是命令自己的失败——exitCode ≠ 0 是"世界的正常反馈"（bash 工具
        // 会原样拼给模型），被杀是外力，必须抛出去按 error 结果落盘（ADR-0006）
        if (opts?.signal?.aborted) {
          throw new Error("命令被中断：用户停止了 turn，进程已被终止（SIGTERM）");
        }
        const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? e.message,
          exitCode: e.code ?? 1,
        };
      }
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
        // 剥干净了这个终端就不是"他自己的终端"了
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
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
  };
}
