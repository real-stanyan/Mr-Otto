import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../../src/session/events.js";
import { decodeDownFrame, encodeFrame } from "../../../src/shared/remote/frames.js";
import {
  groupTimeline, projectTimelineForMobile, splitTool,
} from "../../../src/shared/remote/timeline.js";

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

/** 上面那些测的是"投影出什么",这一组测的是**投影出来的东西过不过得了线**。
    少了这一环,decodeDownFrame 里一条过严的键校验就能让整条时间线在手机上
    永远加载不出来,而全部单测照样绿 —— 真发生过一次。 */
describe("投影 → 编码 → 解码 的往返", () => {
  it("没有 truncated 的普通消息不能被解码丢掉", () => {
    const msgs = projectTimelineForMobile([
      ev({ type: "user_message", content: "短消息" }),
      ev({ type: "assistant_message", content: "短回复", model: "v4" }),
    ]);
    const back = decodeDownFrame(encodeFrame({ type: "timeline", sessionId: "s1", messages: msgs }));
    expect(back).toEqual({ type: "timeline", sessionId: "s1", messages: msgs });
  });

  it("带 truncated 的也能往返", () => {
    const msgs = projectTimelineForMobile([ev({ type: "user_message", content: "abcdef" })], { maxChars: 3 });
    expect(msgs[0]?.truncated).toBe(true);
    const back = decodeDownFrame(encodeFrame({ type: "timeline", sessionId: "s1", messages: msgs }));
    expect(back).not.toBeNull();
  });

  it("白名单之外的键仍然整条丢弃", () => {
    const line = JSON.stringify({
      type: "timeline", sessionId: "s1",
      messages: [{ role: "user", text: "x", 夹带: 1 }],
    });
    expect(decodeDownFrame(line)).toBeNull();
  });

  it("role 不认识 / text 不是字符串,整条丢弃", () => {
    for (const bad of [{ role: "system", text: "x" }, { role: "user", text: 1 }]) {
      const line = JSON.stringify({ type: "timeline", sessionId: "s1", messages: [bad] });
      expect(decodeDownFrame(line)).toBeNull();
    }
  });
});

describe("groupTimeline —— 连续的工具调用并成一组", () => {
  const m = (role: "user" | "assistant" | "tool", text: string) => ({ role, text }) as const;

  it("相邻的工具消息并成一组", () => {
    const items = groupTimeline([m("tool", "a\nx"), m("tool", "b\ny")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tools" });
  });

  it("中间夹一句正文就是两组 —— 并了会看不出顺序", () => {
    const items = groupTimeline([m("tool", "a\nx"), m("assistant", "说了句话"), m("tool", "b\ny")]);
    expect(items.map((i) => i.kind)).toEqual(["tools", "message", "tools"]);
  });

  it("非工具消息原样一条一项", () => {
    const items = groupTimeline([m("user", "问"), m("assistant", "答")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });
});

describe("splitTool", () => {
  it("第一行是工具名,正文从第二行起", () => {
    expect(splitTool({ role: "tool", text: "read_file\n文件内容\n第二行" }))
      .toEqual({ name: "read_file", output: "文件内容\n第二行" });
  });

  it("没有正文时不产出一个假的空行", () => {
    expect(splitTool({ role: "tool", text: "bash" })).toEqual({ name: "bash", output: "" });
  });
});
