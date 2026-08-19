import { describe, it, expect } from "vitest";
import { buildToolIndex, groupElapsed } from "../../src/renderer/src/lib/toolIndex.js";
import type { SessionEvent, ToolCallRequest } from "../../src/session/events.js";

let seq = 0;
const env = (ts: number) => ({ seq: seq++, sessionId: "s", ts });

const call = (id: string): ToolCallRequest => ({ id, name: "read_file", args: {} });

const started = (toolCallId: string, ts: number): SessionEvent =>
  ({ ...env(ts), type: "tool_execution_started", toolCallId }) as SessionEvent;

const result = (toolCallId: string, ts: number, status: "ok" | "error" | "denied" = "ok"): SessionEvent =>
  ({ ...env(ts), type: "tool_result", toolCallId, status, output: "out" }) as SessionEvent;

const user = (ts: number): SessionEvent =>
  ({ ...env(ts), type: "user_message", content: "hi" }) as SessionEvent;

describe("buildToolIndex", () => {
  it("空日志出空索引", () => {
    const ix = buildToolIndex([]);
    expect(ix.results.size).toBe(0);
    expect(ix.starts.size).toBe(0);
  });

  it("按 toolCallId 配对结果和开跑标记", () => {
    const ix = buildToolIndex([started("a", 10), result("a", 30), started("b", 40)]);
    expect(ix.results.get("a")?.ts).toBe(30);
    expect(ix.starts.get("a")?.ts).toBe(10);
    expect(ix.starts.get("b")?.ts).toBe(40);
    expect(ix.results.get("b")).toBeUndefined();
  });

  it("无关事件不进索引", () => {
    const ix = buildToolIndex([user(1), user(2)]);
    expect(ix.results.size).toBe(0);
    expect(ix.starts.size).toBe(0);
  });

  it("同一 id 重复落盘时先到的胜出(与旧 ToolRow 的 find 同口径)", () => {
    const ix = buildToolIndex([started("a", 10), started("a", 99), result("a", 20), result("a", 88)]);
    expect(ix.starts.get("a")?.ts).toBe(10);
    expect(ix.results.get("a")?.ts).toBe(20);
  });

  it("状态原样带出来(denied 也查得到)", () => {
    const ix = buildToolIndex([result("a", 5, "denied")]);
    expect(ix.results.get("a")?.status).toBe("denied");
  });
});

describe("groupElapsed", () => {
  it("墙上耗时 = 最后一个结果 − 第一次开跑", () => {
    const ix = buildToolIndex([
      started("a", 100), started("b", 150), result("b", 400), result("a", 300),
    ]);
    expect(groupElapsed([call("a"), call("b")], ix)).toBe(300);
  });

  it("只算组内的调用,组外的 id 不参与", () => {
    const ix = buildToolIndex([
      started("a", 100), result("a", 200), started("z", 1), result("z", 9999),
    ]);
    expect(groupElapsed([call("a")], ix)).toBe(100);
  });

  it("组里有还没出结果的调用,按已落盘的结果算", () => {
    const ix = buildToolIndex([started("a", 100), result("a", 250), started("b", 260)]);
    expect(groupElapsed([call("a"), call("b")], ix)).toBe(150);
  });

  it("一个结果都没有 → null", () => {
    const ix = buildToolIndex([started("a", 100)]);
    expect(groupElapsed([call("a")], ix)).toBeNull();
  });

  it("一次都没开跑(全被拒绝,审批门短路) → null", () => {
    const ix = buildToolIndex([result("a", 100, "denied")]);
    expect(groupElapsed([call("a")], ix)).toBeNull();
  });

  it("空组 → null", () => {
    expect(groupElapsed([], buildToolIndex([]))).toBeNull();
  });

  it("时钟倒着走(结果早于开跑) → null,不出负数", () => {
    const ix = buildToolIndex([started("a", 500), result("a", 100)]);
    expect(groupElapsed([call("a")], ix)).toBeNull();
  });
});
