import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createDockerWorld, type ContainerLike } from "../../src/world/dockerWorld.js";

/** 假的 exec stream：真 EventEmitter（不是手搓的 on() 分发表），这样
    on/removeListener/emit 全部原生可用——审查回来后新增的 'error' 场景
    需要 emit("error", ...)，手搓表只认 "data"/"end" 两个事件名不够用了 */
function createFakeExecStream(script: {
  stdinSink?: (data: string) => void;
  streamError?: Error;
}): NodeJS.ReadWriteStream & { finish(): void } {
  const emitter = new EventEmitter() as unknown as NodeJS.ReadWriteStream & { finish(): void };
  (emitter as unknown as { write: (data: string) => boolean }).write = (data: string) => {
    script.stdinSink?.(data);
    return true;
  };
  (emitter as unknown as { end: () => void }).end = () => {
    // stdin 关闭后，下一个 tick 驱动脚本化的结局（正常 end 或 error）
    setImmediate(() => (emitter as unknown as { finish(): void }).finish());
  };
  (emitter as unknown as { finish: () => void }).finish = () => {
    if (script.streamError) emitter.emit("error", script.streamError);
    else emitter.emit("end");
  };
  return emitter;
}

/** 假 ContainerLike：记录 exec 调用参数，按脚本回放 stdout/stderr/exitCode。
    demuxStream 由脚本驱动——把脚本化 chunk 按 stream 标注写进对应的 Writable，
    模拟 dockerode 的 modem.demuxStream 真实行为（分路而不是拼接） */
function createFakeContainer(script: {
  chunks?: Array<{ stream: "stdout" | "stderr"; data: string }>;
  exitCode: number | null;
  stdinSink?: (data: string) => void;
  /** 设置后：exec 的 stream 在该 emit 的那一刻走 'error' 而不是 'end' */
  streamError?: Error;
  /** 设置后：inspect() 永远回 { ExitCode: null }（模拟 docker 那边一直不给退出码） */
  alwaysNullExitCode?: boolean;
}) {
  const calls: Array<{
    Cmd: string[];
    AttachStdout: boolean;
    AttachStderr: boolean;
    AttachStdin?: boolean;
    WorkingDir?: string;
  }> = [];

  const container: ContainerLike = {
    async exec(opts) {
      calls.push(opts);
      const fakeStream = createFakeExecStream({
        ...(script.stdinSink ? { stdinSink: script.stdinSink } : {}),
        ...(script.streamError ? { streamError: script.streamError } : {}),
      });

      return {
        async start(startOpts) {
          // 没有 stdin 参与时（纯 exec/read），start 后驱动脚本；有 stdin 参与时
          // （fs.write）交给 stream.end() 去驱动，避免这里再抢一次触发
          if (!startOpts?.stdin) {
            setImmediate(() => fakeStream.finish());
          }
          return fakeStream;
        },
        async inspect() {
          if (script.alwaysNullExitCode) return { ExitCode: null };
          return { ExitCode: script.exitCode };
        },
      };
    },
    modem: {
      demuxStream(_stream, out, err) {
        for (const c of script.chunks ?? []) {
          if (c.stream === "stdout") out.write(c.data);
          else err.write(c.data);
        }
      },
    },
  };

  return { container, calls };
}

describe("DockerWorld", () => {
  it("① exec(\"echo hi\") 的 Cmd 形状（timeout 包裹 + bash -lc）与 WorkingDir=/work", async () => {
    const { container, calls } = createFakeContainer({
      chunks: [{ stream: "stdout", data: "hi\n" }],
      exitCode: 0,
    });
    const world = createDockerWorld({ container: async () => container });
    const result = await world.exec("echo hi");
    expect(calls[0]!.Cmd).toEqual([
      "/usr/bin/timeout", "-k", "5", "30", "/bin/bash", "-lc", "echo hi",
    ]);
    expect(calls[0]!.WorkingDir).toBe("/work");
    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(0);
  });

  it("② exitCode 124 → stderr 带「命令超时」", async () => {
    const { container } = createFakeContainer({
      chunks: [{ stream: "stderr", data: "some output\n" }],
      exitCode: 124,
    });
    const world = createDockerWorld({ container: async () => container });
    const result = await world.exec("sleep 100");
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("命令超时");
  });

  it("③ fs.write(\"a/b.txt\", \"x\") 的 Cmd 含 mkdir -p 且 stdin 收到 \"x\"", async () => {
    let received = "";
    const { container, calls } = createFakeContainer({
      exitCode: 0,
      stdinSink: (data) => { received += data; },
    });
    const world = createDockerWorld({ container: async () => container });
    await world.fs.write("a/b.txt", "x");
    expect(calls[0]!.AttachStdin).toBe(true);
    const cmd = calls[0]!.Cmd.join(" ");
    expect(cmd).toContain("mkdir -p");
    expect(received).toBe("x");
  });

  it("④ fs.read(\"../etc/passwd\") 抛「路径越出沙箱」", async () => {
    const { container } = createFakeContainer({ exitCode: 0 });
    const world = createDockerWorld({ container: async () => container });
    await expect(world.fs.read("../etc/passwd")).rejects.toThrow(/路径越出沙箱/);
  });

  it("⑤ onOutput 收到 demux 的分路 chunk", async () => {
    const { container } = createFakeContainer({
      chunks: [
        { stream: "stdout", data: "out1" },
        { stream: "stderr", data: "err1" },
      ],
      exitCode: 0,
    });
    const world = createDockerWorld({ container: async () => container });
    const seen: Array<{ chunk: string; stream: "stdout" | "stderr" }> = [];
    await world.exec("echo x", { onOutput: (chunk, stream) => seen.push({ chunk, stream }) });
    expect(seen).toContainEqual({ chunk: "out1", stream: "stdout" });
    expect(seen).toContainEqual({ chunk: "err1", stream: "stderr" });
  });

  it("fs.read 跑 cat -- <shellQuote(path)>，exitCode 非 0 抛 stderr", async () => {
    const { container } = createFakeContainer({
      chunks: [{ stream: "stderr", data: "cat: no such file" }],
      exitCode: 1,
    });
    const world = createDockerWorld({ container: async () => container });
    await expect(world.fs.read("missing.txt")).rejects.toThrow(/no such file/);
  });

  it("http.postJson 走宿主侧 fetchImpl", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
    const { container } = createFakeContainer({ exitCode: 0 });
    const world = createDockerWorld({ container: async () => container, fetchImpl });
    const result = await world.http.postJson("https://example.com", { a: 1 });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalled();
  });

  // ---- 复审四条 findings 的回归测试 ----

  it("① stream emit 'error' → exec reject 不炸主进程", async () => {
    const { container } = createFakeContainer({
      exitCode: 0,
      streamError: new Error("stream broke"),
    });
    const world = createDockerWorld({ container: async () => container });
    await expect(world.exec("echo x")).rejects.toThrow(/stream broke/);
  });

  it("② inspect 一直回 null → throw「退出码不可得」而不是假成功", async () => {
    const { container } = createFakeContainer({
      exitCode: null,
      alwaysNullExitCode: true,
    });
    const world = createDockerWorld({ container: async () => container });
    await expect(world.exec("echo x")).rejects.toThrow(/退出码不可得/);
  });

  it("③ 已 aborted 的 signal → reject 且 container.exec 未被调", async () => {
    const { container, calls } = createFakeContainer({ exitCode: 0 });
    const world = createDockerWorld({ container: async () => container });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(world.exec("echo x", { signal: ctrl.signal })).rejects.toThrow(/命令被中断/);
    expect(calls.length).toBe(0);
  });

  it("运行中 abort → reject（容器内进程留给 timeout 兜底，已知天花板）", async () => {
    const { container } = createFakeContainer({
      exitCode: 0,
      // stream 永不 'end'——只有 abort 能让这次 exec 收口
      chunks: [],
    });
    // 覆盖假货的 start()，让它压根不驱动脚本，逼 exec 只能靠 abort 收场
    const neverEndingContainer: ContainerLike = {
      ...container,
      async exec(opts) {
        const inner = await container.exec(opts);
        return { ...inner, start: async () => new EventEmitter() as unknown as NodeJS.ReadWriteStream };
      },
    };
    const world = createDockerWorld({ container: async () => neverEndingContainer });
    const ctrl = new AbortController();
    const running = world.exec("sleep 100", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(running).rejects.toThrow(/命令被中断/);
  });

  it("④ timeoutMs: 0 → Cmd 里秒数是 30 不是 0（coreutils timeout 0 = 永不超时，语义反了）", async () => {
    const { container, calls } = createFakeContainer({ exitCode: 0 });
    const world = createDockerWorld({ container: async () => container });
    await world.exec("echo x", { timeoutMs: 0 });
    expect(calls[0]!.Cmd).toContain("30");
    expect(calls[0]!.Cmd).not.toContain("0");
  });

  it("timeoutMs 为负数 → 直接报错（不是悄悄纠正成默认值）", async () => {
    const { container } = createFakeContainer({ exitCode: 0 });
    const world = createDockerWorld({ container: async () => container });
    await expect(world.exec("echo x", { timeoutMs: -5 })).rejects.toThrow(/timeoutMs 不得为负数/);
  });
});
