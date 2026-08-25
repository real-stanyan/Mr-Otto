import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../../src/session/events.js";
import { projectTimelineForMobile } from "../../../src/shared/remote/timeline.js";

/** 只填投影关心的字段;其余用 as 补齐 —— 这些测试钉的是"什么出机器",不是事件构造 */
function ev(e: Partial<SessionEvent> & { type: SessionEvent["type"] }): SessionEvent {
  return { sessionId: "s1", seq: 1, ts: 0, ...e } as SessionEvent;
}

describe("projectTimelineForMobile", () => {
  it("只放行 user / assistant / tool_result 三种,其余一律不出机器", () => {
    const out = projectTimelineForMobile([
      ev({ type: "user_message", content: "帮我看看" }),
      ev({ type: "model_changed", provider: "deepseek", model: "v4" }),
      ev({ type: "assistant_message", content: "好", model: "v4" }),
      ev({ type: "session_renamed", title: "改个名" }),
    ]);
    expect(out).toEqual([
      { role: "user", text: "帮我看看" },
      { role: "assistant", text: "好" },
    ]);
  });

  it("assistant 的 reasoning 一个字都不发", () => {
    const out = projectTimelineForMobile([
      ev({ type: "assistant_message", content: "结论", model: "v4", reasoning: "机密的思考过程" }),
    ]);
    expect(JSON.stringify(out)).not.toContain("机密");
  });

  it("纯工具调用那条 content 是空串,不发空气泡", () => {
    const out = projectTimelineForMobile([
      ev({
        type: "assistant_message", content: "", model: "v4",
        toolCalls: [{ id: "c1", name: "bash", args: {} }],
      }),
    ]);
    expect(out).toEqual([]);
  });

  it("工具结果带上发起它的工具名(名字在 assistant 的 toolCalls 里,不在结果上)", () => {
    const out = projectTimelineForMobile([
      ev({
        type: "assistant_message", content: "", model: "v4",
        toolCalls: [{ id: "c1", name: "read_file", args: {} }],
      }),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "文件内容" }),
    ]);
    expect(out).toEqual([{ role: "tool", text: "read_file\n文件内容" }]);
  });

  it("失败/被拒的工具把状态写进正文", () => {
    const out = projectTimelineForMobile([
      ev({
        type: "assistant_message", content: "", model: "v4",
        toolCalls: [{ id: "c1", name: "bash", args: {} }],
      }),
      ev({ type: "tool_result", toolCallId: "c1", status: "denied", output: "你拒绝了" }),
    ]);
    expect(out[0]?.text).toBe("bash(denied)\n你拒绝了");
  });

  it("认不出工具名时不丢结果,兜底成「工具」", () => {
    const out = projectTimelineForMobile([
      ev({ type: "tool_result", toolCallId: "野的", status: "ok", output: "x" }),
    ]);
    expect(out[0]?.text).toBe("工具\nx");
  });

  it("截断在这一侧做,并且打 truncated 标记", () => {
    const out = projectTimelineForMobile(
      [ev({ type: "user_message", content: "abcdef" })],
      { maxChars: 3 },
    );
    expect(out).toEqual([{ role: "user", text: "abc", truncated: true }]);
  });

  it("工具输出压得比正文狠 —— 它最长、最不适合在手机上读", () => {
    const out = projectTimelineForMobile(
      [
        ev({ type: "user_message", content: "12345" }),
        ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "12345" }),
      ],
      { maxChars: 100, maxToolChars: 8 },
    );
    expect(out[0]?.truncated).toBeUndefined();
    // "工具\n12345" = 8 字符,正好不截;再长一个字符就截
    expect(out[1]?.truncated).toBeUndefined();
  });

  it("只留最后 N 条 —— 手机上没人往上翻两千条", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      ev({ type: "user_message", content: `第${i}条` }));
    const out = projectTimelineForMobile(many, { maxMessages: 3 });
    expect(out.map((m) => m.text)).toEqual(["第7条", "第8条", "第9条"]);
  });
});
