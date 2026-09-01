// DockerWorld — ExecutionWorld 的容器实现（v2）。
// 工具经 dockerode exec 进工作区容器执行——loop 在宿主，模型 key 永不进容器
// （只有 http 走宿主侧 fetch，能出网的是 loop 进程，不是容器）。
//
// 只实现 ExecutionWorld 的必填能力（fs/exec/http）；execDetached/openTerminal/
// browser/mcp/... 等可选能力一律不实现（YAGNI——bash 工具在无 background
// 参数时不需要它们，见 task-7-brief.md）。
//
// timeout 包裹上限（-k 5）：docker exec 杀不掉已经在容器里启动的进程
// （exec 是 attach 到容器 namespace 里的一次性调用，宿主侧没有那个 pid 可 kill）——
// timeout(1) 是容器内自杀：先 TERM，5 秒宽限后 KILL。exitCode 124 = timeout(1)
// 自己的退出码约定，coreutils 文档保证这个数字。

import { resolve as posixResolve, relative as posixRelative, isAbsolute as posixIsAbsolute } from "node:path/posix";
import { Writable } from "node:stream";
import type { ExecOptions, ExecResult, ExecutionWorld } from "./executionWorld.js";

/** dockerode 的最小可注入面——测试给假货，生产给 new Docker().getContainer(id) 的容器句柄。
    形状对齐 dockerode 的 Container/Exec：exec() 起一次执行、start() 拿到读写流、
    inspect() 读退出码；modem.demuxStream 把 docker 的多路复用流分拆成 stdout/stderr
    两路（docker attach 协议本身就是单条 stream 里交替编码两路输出，demux 是解开它的标准姿势） */
export interface ContainerLike {
  exec(opts: {
    Cmd: string[];
    AttachStdout: boolean;
    AttachStderr: boolean;
    AttachStdin?: boolean;
    WorkingDir?: string;
  }): Promise<{
    start(opts: { hijack?: boolean; stdin?: boolean }): Promise<NodeJS.ReadWriteStream>;
    inspect(): Promise<{ ExitCode: number | null }>;
  }>;
  modem: { demuxStream(stream: NodeJS.ReadableStream, out: NodeJS.WritableStream, err: NodeJS.WritableStream): void };
}

/** 容器里的工作目录。导出是因为 daemon 建云会话时要把它写进
    `session_created.workspace`（投影成 system 消息告诉模型自己在哪，
    issue #833）——两处写死同一个字符串迟早会漂。 */
export const WORKDIR = "/work";

/** 单引号包裹 + `'\''` 转义（POSIX shell 惯用法：先结束单引号、插一个转义单引号、
    再开新的单引号），比双引号更安全——单引号内没有任何字符会被 shell 二次展开 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** 把 path 归一到 /work 下并验证没越出。这一层是礼貌报错不是安全边界——
    真正的硬边界是容器本身（namespace 隔离），这里拦的是"agent 手滑传了 ../"这种
    常规失误，不是恶意逃逸（恶意逃逸要靠 docker 的隔离，不是这行 relative 判断） */
function fenceInContainer(path: string): string {
  const abs = posixResolve(WORKDIR, path);
  const rel = posixRelative(WORKDIR, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !posixIsAbsolute(rel));
  if (!inside) {
    throw new Error(`路径越出沙箱（${WORKDIR}）: ${path}`);
  }
  return abs;
}

/** 把一条已经归一过的容器内绝对路径拆出目录部分（posix 风格，够用即可——
    不需要 node:path 的 dirname，手写避免再拉一个 import） */
function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

/** 中断错误的统一措辞——语义对齐 localWorld.exec（ADR-0006 的「不得把中断
    伪装成命令自己的失败」）：中断永远是外力，必须 reject，不能拼进 ExecResult */
function abortedError(detail: string): Error {
  return new Error(`命令被中断：用户停止了 turn，${detail}`);
}

/** exec.inspect() 有界退避轮询：ExitCode 可能在流刚结束时还没落定
    （dockerode 的 inspect 是另一次 API 往返，跟流结束不是同一次事务）。
    最多问 5 次、每次间隔 40ms；5 次仍是 null 就 throw——宁可报错也不能拿
    `?? 0` 兜底把「问不到」悄悄说成「成功退出」，那是假绿 */
const INSPECT_MAX_ATTEMPTS = 5;
const INSPECT_RETRY_DELAY_MS = 40;

async function inspectExitCode(exec: { inspect(): Promise<{ ExitCode: number | null }> }): Promise<number> {
  for (let attempt = 1; attempt <= INSPECT_MAX_ATTEMPTS; attempt++) {
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== null) return ExitCode;
    if (attempt < INSPECT_MAX_ATTEMPTS) {
      await new Promise((res) => setTimeout(res, INSPECT_RETRY_DELAY_MS));
    }
  }
  throw new Error(`exec 退出码不可得（inspect 连续 ${INSPECT_MAX_ATTEMPTS} 次仍为 null）`);
}

/** timeoutMs 边界归一化：
    - 负数 = 显式非法输入，直接报错（调用方传错了，不该被悄悄纠正成默认值）
    - 0 或非有限数（NaN/Infinity）= 归一成默认 30_000——coreutils `timeout 0`
      的语义是"永不超时"，跟 ExecOptions.timeoutMs 想表达的"给个超时上限"
      正好相反，原样传给 shell 命令会把超时闸门整个拆掉 */
function normalizeTimeoutMs(ms: number | undefined): number {
  if (ms === undefined) return 30_000;
  if (ms < 0) throw new Error(`timeoutMs 不得为负数: ${ms}`);
  if (!Number.isFinite(ms) || ms === 0) return 30_000;
  return ms;
}

async function runExec(
  container: ContainerLike,
  cmdParts: string[],
  opts: { attachStdin?: boolean; stdin?: string; onOutput?: ExecOptions["onOutput"]; signal?: AbortSignal } = {}
): Promise<ExecResult> {
  // 调用时 signal 已经 aborted：同 localWorld.exec 的先例——同步短路，
  // 连 exec 都不起，不然命令会一直跑到自然结束才被动收口
  if (opts.signal?.aborted) {
    throw abortedError("调用时已中止（未起 exec）");
  }

  const exec = await container.exec({
    Cmd: cmdParts,
    AttachStdout: true,
    AttachStderr: true,
    ...(opts.attachStdin ? { AttachStdin: true } : {}),
    WorkingDir: WORKDIR,
  });
  const stream = await exec.start(opts.attachStdin ? { hijack: true, stdin: true } : {});

  let stdout = "";
  let stderr = "";
  const stdoutSink = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString("utf8");
      stdout += s;
      opts.onOutput?.(s, "stdout");
      cb();
    },
  });
  const stderrSink = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString("utf8");
      stderr += s;
      opts.onOutput?.(s, "stderr");
      cb();
    },
  });
  container.modem.demuxStream(stream, stdoutSink, stderrSink);

  // 三个终局来源赛跑：正常结束（'end'）、流出错（'error'——真 docker 断连时
  // 会走这条，不挂监听会直接炸主进程）、外部中断（signal abort）。
  // 谁先到就 cleanup 摘掉另外两个监听器，避免 settle 之后还挂着
  await new Promise<void>((resolveWait, rejectWait) => {
    const onEnd = () => { cleanup(); resolveWait(); };
    const onError = (err: unknown) => {
      cleanup();
      rejectWait(err instanceof Error ? err : new Error(String(err)));
    };
    const onAbort = () => {
      cleanup();
      // 运行中中断：docker exec 没有 kill 原语（exec 是 attach 到容器
      // namespace 里的一次性调用，宿主侧没有可 kill 的 pid）——容器内
      // 进程杀不掉，只能 reject 让调用方立刻收到「中断了」这件事,真正
      // 收口交给已经包在 Cmd 里的 coreutils timeout 自然到期。这是已知
      // 天花板，不是漏做
      rejectWait(abortedError(
        "运行中被中断（docker exec 没有 kill 原语，容器内进程留给 timeout 兜底——已知天花板）"
      ));
    };
    function cleanup() {
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    stream.on("end", onEnd);
    stream.on("error", onError);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (opts.attachStdin) {
      if (opts.stdin !== undefined) stream.write(opts.stdin);
      stream.end();
    }
  });

  const exitCode = await inspectExitCode(exec);

  if (exitCode === 124) {
    stderr = `${stderr}\n命令超时`.trim();
  }

  return { stdout, stderr, exitCode };
}

export function createDockerWorld(opts: {
  container: () => Promise<ContainerLike>; // 惰性取——T8 的 ensureContainer 喂进来
  fetchImpl?: typeof fetch;
}): ExecutionWorld {
  return {
    fs: {
      async read(path) {
        const abs = fenceInContainer(path);
        const container = await opts.container();
        const result = await runExec(container, ["/bin/bash", "-lc", `cat -- ${shellQuote(abs)}`]);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || `读取失败（exitCode ${result.exitCode}）: ${path}`);
        }
        return result.stdout;
      },
      async write(path, content) {
        const abs = fenceInContainer(path);
        const dir = posixDirname(abs);
        const container = await opts.container();
        const q = shellQuote(abs);
        const cmd = `mkdir -p -- ${shellQuote(dir)} && cat > ${q}`;
        const result = await runExec(container, ["/bin/bash", "-lc", cmd], {
          attachStdin: true,
          stdin: content,
        });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || `写入失败（exitCode ${result.exitCode}）: ${path}`);
        }
      },
    },

    async exec(cmd, execOpts): Promise<ExecResult> {
      // 同 runExec 内部那道短路的先例，这里再挡一次：调用时已中止就不该
      // 连惰性 container() 都去取——没有容器可用不是理由，用户已经说了停
      if (execOpts?.signal?.aborted) {
        throw abortedError("调用时已中止（未起 exec）");
      }
      const timeoutMs = normalizeTimeoutMs(execOpts?.timeoutMs);
      const timeoutSec = String(Math.ceil(timeoutMs / 1000));
      const container = await opts.container();
      return runExec(
        container,
        ["/usr/bin/timeout", "-k", "5", timeoutSec, "/bin/bash", "-lc", cmd],
        {
          ...(execOpts?.onOutput ? { onOutput: execOpts.onOutput } : {}),
          ...(execOpts?.signal ? { signal: execOpts.signal } : {}),
        }
      );
    },

    http: {
      async postJson(url, body, o) {
        const fetchImpl = opts.fetchImpl ?? fetch;
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...o?.headers },
          body: JSON.stringify(body),
          ...(o?.signal ? { signal: o.signal } : {}),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        return res.json();
      },
    },
  };
}
