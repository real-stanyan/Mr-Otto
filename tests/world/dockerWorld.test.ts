import { describe, it, expect, vi } from "vitest";
import { createDockerWorld, type ContainerLike } from "../../src/world/dockerWorld.js";

/** 假 ContainerLike：记录 exec 调用参数，按脚本回放 stdout/stderr/exitCode。
    demuxStream 由脚本驱动——把脚本化 chunk 按 stream 标注写进对应的 Writable，
    模拟 dockerode 的 modem.demuxStream 真实行为（分路而不是拼接） */
function createFakeContainer(script: {
  chunks?: Array<{ stream: "stdout" | "stderr"; data: string }>;
  exitCode: number | null;
  stdinSink?: (data: string) => void;
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
      const streamListeners: Array<(chunk: unknown) => void> = [];
      const endListeners: Array<() => void> = [];
      const fakeStream = {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "data") streamListeners.push(cb as (chunk: unknown) => void);
          if (event === "end") endListeners.push(cb as () => void);
          return fakeStream;
        },
        write(data: string) {
          script.stdinSink?.(data);
        },
        end() {
          // stdin 关闭后驱动脚本化输出走一遍，再宣告流结束
          queueMicrotask(() => {
            for (const l of endListeners) l();
          });
        },
      } as unknown as NodeJS.ReadWriteStream;

      return {
        async start() {
          // 没有 stdin 参与时（纯 exec/read），start 后驱动脚本。用 setImmediate
          // 而不是 queueMicrotask：调用方要等 await start() 恢复后才会注册
          // "end" 监听器，queueMicrotask 会抢在那之前触发、监听器永远收不到
          setImmediate(() => {
            for (const l of endListeners) l();
          });
          return fakeStream;
        },
        async inspect() {
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
});
