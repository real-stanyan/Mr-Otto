import { describe, expect, it } from "vitest";
import { deriveMessages, DEFAULT_COMPRESSION } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 新鲜区工具输出折叠（issue #383，hermes spillover 对照的投影级实现）：
// 老区折到 maxOld（原有行为），新鲜区折到 maxFresh（宽得多）。
// 日志存全文不动——折叠只住在投影层，确定性纯函数。

function turnWithToolOutput(seqBase: number, output: string): SessionEvent[] {
  return [
    { sessionId: "s", seq: seqBase, ts: 1, type: "user_message", content: `问 ${seqBase}` },
    {
      sessionId: "s", seq: seqBase + 1, ts: 2, type: "assistant_message", model: "m",
      content: "", toolCalls: [{ id: `c${seqBase}`, name: "read_file", args: { path: "/big" } }],
    },
    { sessionId: "s", seq: seqBase + 2, ts: 3, type: "tool_result", toolCallId: `c${seqBase}`, status: "ok", output },
    { sessionId: "s", seq: seqBase + 3, ts: 4, type: "assistant_message", model: "m", content: "看完了" },
    { sessionId: "s", seq: seqBase + 4, ts: 5, type: "turn_ended", outcome: "completed" },
  ];
}

describe("新鲜区工具输出折叠（issue #383）", () => {
  const OPTS = { keepRecentTurns: 2, maxOldToolOutputChars: 50, maxOldToolArgChars: 60, maxFreshToolOutputChars: 200 };

  it("新鲜区超限输出折到 maxFresh，标记带原始长度", () => {
    const big = "x".repeat(500);
    const msgs = deriveMessages(turnWithToolOutput(0, big), OPTS);
    const tool = msgs.find((m) => m.role === "tool")!;
    expect(tool.content.length).toBeLessThan(big.length);
    expect(tool.content).toContain("原 500 字符");
    expect(tool.content.startsWith("x".repeat(200))).toBe(true);
  });

  it("新鲜区未超限：逐字节原样", () => {
    const ok = "y".repeat(150);
    const msgs = deriveMessages(turnWithToolOutput(0, ok), OPTS);
    expect(msgs.find((m) => m.role === "tool")!.content).toBe(ok);
  });

  it("maxFresh 缺席：新鲜区不折叠（旧行为逐字节一致）", () => {
    const big = "z".repeat(500);
    const legacy = { keepRecentTurns: 2, maxOldToolOutputChars: 50, maxOldToolArgChars: 60 };
    const msgs = deriveMessages(turnWithToolOutput(0, big), legacy);
    expect(msgs.find((m) => m.role === "tool")!.content).toBe(big);
  });

  it("老区仍按 maxOld 折（比 maxFresh 严得多），两把尺子各管各区", () => {
    // 三个 turn：第一个滑出保真区（keepRecentTurns: 2）
    const events = [
      ...turnWithToolOutput(0, "a".repeat(500)),
      ...turnWithToolOutput(10, "b".repeat(500)),
      ...turnWithToolOutput(20, "c".repeat(500)),
    ];
    const msgs = deriveMessages(events, OPTS);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools[0]!.content).toContain("仅保留前 50 字符");   // 老区
    expect(tools[1]!.content).toContain("仅保留前 200 字符"); // 新鲜区
    expect(tools[2]!.content).toContain("仅保留前 200 字符"); // 新鲜区
  });

  it("DEFAULT_COMPRESSION 带 maxFresh（值本身是行为的一部分）", () => {
    expect(DEFAULT_COMPRESSION.maxFreshToolOutputChars).toBe(50_000);
  });
});
