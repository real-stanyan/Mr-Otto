// 「delta 不落盘 + 终态覆盖」契约（issue #340，codex 三段式的后半）。
//
// 前半（delta 永不进 append-only 日志）由 persistencePolicy 锁住（issue #339）：
// delta 压根不在 SessionEvent union 里，EventStore.append 还有运行时闸。
// 这里锁后半：终态事件落地时，UI 必须整体作废 delta 拼出的临时状态——
// 事实覆盖预览，不信任拼接结果。于是对话/轨迹两个 tab（同一日志的两种投影）
// 无论直播时 delta 乱序/丢失成什么样，终态后内容必然一致。

import { describe, expect, it } from "vitest";
import { absorbEvent } from "../../src/renderer/src/store.js";
import { toThreadMessages } from "../../src/renderer/src/aui/toThreadMessages.js";
import { buildTrajectory } from "../../src/renderer/src/replay/trajectory.js";
import type { SessionEvent } from "../../src/session/events.js";

const S = "sess-1";
const base = (seq: number) => ({ seq, sessionId: S, ts: 1000 + seq });

function stateWith(over: Partial<Parameters<typeof absorbEvent>[0]> = {}) {
  return {
    sessionId: S,
    events: [] as SessionEvent[],
    streamingBySession: {},
    toolOutputByCall: {},
    runningToolCallBySession: {},
    approvals: {},
    ...over,
  };
}

describe("终态覆盖契约（absorbEvent）", () => {
  it("assistant_message 落地：直播缓冲整体作废，乱序/丢失的 delta 拼接不进任何投影", () => {
    // 模拟 delta 乱序 + 丢失后的缓冲：内容是坏的
    const garbage = "wolrd Hel（乱序丢包的拼接）";
    const s = stateWith({
      streamingBySession: { [S]: { content: garbage, reasoning: "半截思考" } },
      events: [{ ...base(0), type: "user_message", content: "问题" } as SessionEvent],
    });
    const final: SessionEvent = {
      ...base(1),
      type: "assistant_message",
      content: "Hello world（完整事实）",
      model: "m1",
    };

    const next = absorbEvent(s, final);

    // 缓冲被整体清掉——不是"用缓冲兜底"，是"事实覆盖预览"
    expect(next.streamingBySession).toEqual({});
    if (!("events" in next)) throw new Error("当前会话的终态必须并入 events");
    const events = next.events;

    // 对话视图投影：只见事实，不见拼接残骸
    const chat = JSON.stringify(toThreadMessages(events));
    expect(chat).toContain("Hello world（完整事实）");
    expect(chat).not.toContain("wolrd");

    // 轨迹视图投影：同一份日志，同一个事实
    const traj = buildTrajectory(events);
    const row = traj.rows.find((r) => r.kind === "assistant");
    expect(row).toBeDefined();
    expect(row!.ev).toBe(final);
    expect(JSON.stringify(traj)).not.toContain("wolrd");
  });

  it("tool_result 落地：该调用的输出缓冲与 running 标记一并作废", () => {
    const s = stateWith({
      toolOutputByCall: { c1: "…chunk3chunk1（丢了 chunk2）" },
      runningToolCallBySession: { [S]: "c1" },
    });
    const next = absorbEvent(s, {
      ...base(2),
      type: "tool_result",
      toolCallId: "c1",
      status: "ok",
      output: "完整输出",
    });
    expect(next.toolOutputByCall).toEqual({});
    expect(next.runningToolCallBySession).toEqual({});
  });

  it("后台会话的终态同样清缓冲（events 不并入，DB 是缓冲区）", () => {
    const s = stateWith({
      sessionId: "另一个会话",
      streamingBySession: { [S]: { content: "后台残留", reasoning: "" } },
    });
    const next = absorbEvent(s, {
      ...base(3),
      type: "assistant_message",
      content: "完整",
      model: "m1",
    });
    expect(next.streamingBySession).toEqual({});
    expect("events" in next).toBe(false);
  });

  it("非终态事件不动缓冲（只有事实才有覆盖权）", () => {
    const buf = { [S]: { content: "直播中", reasoning: "" } };
    const next = absorbEvent(stateWith({ streamingBySession: buf }), {
      ...base(4),
      type: "model_changed",
      provider: "deepseek",
      model: "m2",
    });
    expect(next.streamingBySession).toBe(buf);
  });
});
