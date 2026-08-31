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

const WORKDIR = "/work";

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

async function runExec(
  container: ContainerLike,
  cmdParts: string[],
  opts: { attachStdin?: boolean; stdin?: string; onOutput?: ExecOptions["onOutput"] } = {}
): Promise<ExecResult> {
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

  const ended = new Promise<void>((res) => stream.on("end", res));

  if (opts.attachStdin) {
    if (opts.stdin !== undefined) stream.write(opts.stdin);
    stream.end();
  }

  await ended;

  // ExitCode 可能在流刚结束时还没落定（dockerode 的 inspect 是另一次 API 往返）；
  // 一次拿不到就再问一次——brief 说明的"可能要轮询"落地成"最多再问一次"
  let inspected = await exec.inspect();
  if (inspected.ExitCode === null) {
    inspected = await exec.inspect();
  }
  const exitCode = inspected.ExitCode ?? 0;

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
      const timeoutMs = execOpts?.timeoutMs ?? 30_000;
      const timeoutSec = String(Math.ceil(timeoutMs / 1000));
      const container = await opts.container();
      return runExec(
        container,
        ["/usr/bin/timeout", "-k", "5", timeoutSec, "/bin/bash", "-lc", cmd],
        { onOutput: execOpts?.onOutput }
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
