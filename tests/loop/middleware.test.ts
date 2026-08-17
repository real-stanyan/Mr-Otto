import { describe, it, expect } from "vitest";
import { runPipeline } from "../../src/loop/middleware.js";
import type { ToolCallContext, ToolMiddleware, ToolOutcome } from "../../src/loop/middleware.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const fakeWorld: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

function ctx(): ToolCallContext {
  return {
    call: { id: "c1", name: "noop", args: {} },
    tool: undefined,
    world: fakeWorld,
    sessionId: "s1",
  };
}

const okExecutor = async (): Promise<ToolOutcome> => ({ status: "ok", output: "done" });

describe("runPipeline", () => {
  it("空管线 → 直达执行器", async () => {
    const outcome = await runPipeline([], okExecutor, ctx());
    expect(outcome).toEqual({ status: "ok", output: "done" });
  });

  it("洋葱顺序：pre 从外到内，post 从内到外", async () => {
    const trace: string[] = [];
    const mw = (tag: string): ToolMiddleware => async (_ctx, next) => {
      trace.push(`${tag}:pre`);
      const outcome = await next();
      trace.push(`${tag}:post`);
      return outcome;
    };

    await runPipeline([mw("A"), mw("B")], async () => {
      trace.push("exec");
      return { status: "ok", output: "" };
    }, ctx());

    expect(trace).toEqual(["A:pre", "B:pre", "exec", "B:post", "A:post"]);
  });

  it("中间件短路 → 执行器根本不跑", async () => {
    let executed = false;
    const block: ToolMiddleware = async () => ({ status: "denied", output: "不行" });

    const outcome = await runPipeline([block], async () => {
      executed = true;
      return { status: "ok", output: "" };
    }, ctx());

    expect(outcome).toEqual({ status: "denied", output: "不行" });
    expect(executed).toBe(false);
  });

  it("post-execute 可以改写结果（脱敏场景的地基）", async () => {
    const redact: ToolMiddleware = async (_ctx, next) => {
      const outcome = await next();
      return { ...outcome, output: outcome.output.replace(/sk-\w+/g, "sk-***") };
    };

    const outcome = await runPipeline([redact], async () => ({
      status: "ok",
      output: "key 是 sk-abc123",
    }), ctx());

    expect(outcome.output).toBe("key 是 sk-***");
  });

  it("同一中间件调 next 两次 → 报错而不是双跑工具", async () => {
    const doubleNext: ToolMiddleware = async (_ctx, next) => {
      await next();
      return next();
    };
    await expect(runPipeline([doubleNext], okExecutor, ctx())).rejects.toThrow(/两次/);
  });
});
