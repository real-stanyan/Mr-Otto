import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  createWaitTaskTool,
  formatWaitOutcome,
  type BackgroundWaitOutcome,
  type BackgroundWaiter,
} from "../../src/tools/waitTask.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

// wait_task（issue #871 / ADR-0205）：模型在同一 turn 里等后台任务出结果。

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

function fakeWaiter(outcome: BackgroundWaitOutcome, armed = true) {
  const calls: Array<{ id: string; timeoutMs: number; signal: AbortSignal | undefined }> = [];
  const waiter: BackgroundWaiter = {
    armed,
    async wait(id, timeoutMs, signal) {
      calls.push({ id, timeoutMs, signal });
      return outcome;
    },
  };
  return { waiter, calls };
}

describe("wait_task 工具", () => {
  it("默认等 DEFAULT_WAIT_SECONDS，id 与中断信号原样递给底座", async () => {
    const { waiter, calls } = fakeWaiter({
      kind: "done",
      id: "bg-3",
      cmd: "npm test",
      result: { stdout: "ok\n", stderr: "", exitCode: 0 },
    });
    const ac = new AbortController();
    const out = await createWaitTaskTool(waiter).run({ task_id: "bg-3" }, world, {
      toolCallId: "c1",
      signal: ac.signal,
    });
    expect(calls).toEqual([{ id: "bg-3", timeoutMs: DEFAULT_WAIT_SECONDS * 1000, signal: ac.signal }]);
    expect(out).toContain("[后台任务 bg-3 完成] npm test");
    expect(out).toContain("exit code: 0");
    expect(out).toContain("stdout:\nok");
  });

  it("timeout_seconds 封顶在 MAX_WAIT_SECONDS——等得比任务活得还久没有意义", async () => {
    const { waiter, calls } = fakeWaiter({ kind: "unknown", id: "bg-1" });
    await createWaitTaskTool(waiter).run({ task_id: "bg-1", timeout_seconds: 99_999 }, world);
    expect(calls[0]!.timeoutMs).toBe(MAX_WAIT_SECONDS * 1000);
  });

  it("参数形状：task_id 必须是 bg-N；timeout_seconds 必须是正数", async () => {
    const { waiter, calls } = fakeWaiter({ kind: "unknown", id: "x" });
    const tool = createWaitTaskTool(waiter);
    await expect(tool.run({ task_id: "build" }, world)).rejects.toThrow(/bg-N/);
    await expect(tool.run({}, world)).rejects.toThrow(/bg-N/);
    await expect(tool.run({ task_id: "bg-1", timeout_seconds: -1 }, world)).rejects.toThrow(/正数/);
    expect(calls).toEqual([]);
  });

  it("available 跟着 armed 走：没接回注的装配从声明表里消失", () => {
    expect(createWaitTaskTool(fakeWaiter({ kind: "unknown", id: "bg-1" }, true).waiter).available?.()).toBe(true);
    expect(createWaitTaskTool(fakeWaiter({ kind: "unknown", id: "bg-1" }, false).waiter).available?.()).toBe(false);
  });
});

describe("formatWaitOutcome", () => {
  it("timeout：带命令与输出尾巴，说清任务还在跑、可以再等", () => {
    const text = formatWaitOutcome({ kind: "timeout", id: "bg-2", cmd: "npm run build", tail: "compiling…" });
    expect(text).toContain("bg-2 还在跑");
    expect(text).toContain("compiling…");
    expect(text).toContain("再 wait_task 一次");
  });

  it("timeout 没输出：不画一个空盒子", () => {
    expect(formatWaitOutcome({ kind: "timeout", id: "bg-2", cmd: "x", tail: "" })).toContain("还没有输出");
  });

  it("unknown：说清两种可能（id 打错 / 上一次启动留下的）", () => {
    const text = formatWaitOutcome({ kind: "unknown", id: "bg-7" });
    expect(text).toContain("bg-7");
    expect(text).toContain("上一次启动");
  });

  it("done 超长输出中间截断，头尾都在", () => {
    const text = formatWaitOutcome({
      kind: "done",
      id: "bg-1",
      cmd: "cat big",
      result: { stdout: "HEAD" + "x".repeat(20_000) + "TAIL", stderr: "", exitCode: 0 },
    });
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("HEAD");
    expect(text).toContain("TAIL");
    expect(text).toContain("中间省略");
  });
});
