import { describe, it, expect } from "vitest";
import { cutSpeakerLeak, speakerNamesOf } from "../../src/shared/speakerLeak.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = (seq: number) => ({ seq, sessionId: "s", ts: seq });

/** 群 64997e68 seq 1132（#1483）：答完之后模型自己续写了一行别人的发言，再接一段英文思考，
    最后把答案又写了一遍——全在 content 里 */
const LEAKED =
  "@Stan Yan 那 4 个提交齐了，推之前要你存一下令牌。\n\n" +
  "我这边继续写附件那块，不等令牌。\n\n" +
  "[Otto产品经理]: 刚扫了一眼 #1444 那条复盘...\n\n" +
  "Hmm wait, the message ends with \"[Otto产品经理]: …\" — it's truncated?\n\n" +
  "I'll finalize.@Stan Yan 那 4 个提交齐了。";

describe("cutSpeakerLeak：模型续写别人的说话人行，从那一行起截掉（#1483）", () => {
  const names = new Set(["Stan Yan", "Otto产品经理", "Otto开发", "系统"]);

  it("截图那一条：留下答案，伪造的「[Otto产品经理]: …」连同后面的思考一起进 trimmed", () => {
    const r = cutSpeakerLeak(LEAKED, names, "Otto开发");
    expect(r.content).toBe("@Stan Yan 那 4 个提交齐了，推之前要你存一下令牌。\n\n我这边继续写附件那块，不等令牌。");
    expect(r.trimmed).toMatch(/^\[Otto产品经理\]: 刚扫了一眼/);
    expect(r.trimmed).toContain("I'll finalize.");
  });

  it("没有说话人行的回复原样返回，连 trimmed 这把键都不出现（旧日志 / 正常回复逐字节不变）", () => {
    const text = "行，我去改。\n\n改完叫你。";
    const r = cutSpeakerLeak(text, names, "Otto开发");
    expect(r).toEqual({ content: text });
    expect("trimmed" in r).toBe(false);
  });

  it("不认识的名字不截：方括号开头的行本身不是罪证，判据是「群里真有这个人」", () => {
    const text = "[参考]: 这是我自己列的小标题\n正文";
    expect(cutSpeakerLeak(text, names, "Otto开发")).toEqual({ content: text });
  });

  it("开头是自己的名字只剥前缀——那是把投影格式学了回来，不是在替别人说话", () => {
    const r = cutSpeakerLeak("[Otto开发]: 收到，马上看。", names, "Otto开发");
    expect(r).toEqual({ content: "收到，马上看。" });
  });

  it("第一行就是别人的名字：整条都是编的，content 空、全文进 trimmed（空回复在时间线上不画）", () => {
    const r = cutSpeakerLeak("[Stan Yan]: 来人说话\n\n好的我来。", names, "Otto开发");
    expect(r.content).toBe("");
    expect(r.trimmed).toBe("[Stan Yan]: 来人说话\n\n好的我来。");
  });

  it("代码围栏里的「[名字]: 」不算：那是交付物里的字，不是在说话", () => {
    const text = "日志长这样：\n```\n[Stan Yan]: 来人说话\n```\n看到了吗";
    expect(cutSpeakerLeak(text, names, "Otto开发")).toEqual({ content: text });
  });

  it("名字比对不吃空白与全角：模型写「[Stan  Yan]:」「[Ｏtto产品经理]:」照样认得出", () => {
    expect(cutSpeakerLeak("答案。\n[Stan  Yan]: 嗯", names, "Otto开发").content).toBe("答案。");
    expect(cutSpeakerLeak("答案。\n[Ｏtto产品经理]: 嗯", names, "Otto开发").content).toBe("答案。");
  });

  it("行首的空白与冒号后的空格都宽容：「 [Stan Yan]:嗯」也截", () => {
    expect(cutSpeakerLeak("答案。\n [Stan Yan]:嗯", names, "Otto开发").content).toBe("答案。");
  });

  it("名单为空就什么都不做（本机会话没有说话人行这回事）", () => {
    const text = "[Stan Yan]: 这行留着";
    expect(cutSpeakerLeak(text, new Set(), null)).toEqual({ content: text });
  });
});

describe("speakerNamesOf：从日志里认出群里有谁（名单事件 + 发言标签 + 用户消息前缀）", () => {
  const events: SessionEvent[] = [
    { ...base(1), type: "session_created", workspace: "/w", cloud: { workspaceId: "ws" } },
    { ...base(2), type: "agent_briefed", agentId: "dev", name: "Otto开发", instructions: "写代码", roster: [{ name: "Otto产品经理", description: "管需求" }] },
    { ...base(3), type: "user_message", content: "[Stan Yan]: 来人说话", fromUid: "u1", mentions: ["dev"] },
    { ...base(4), type: "chat_message", fromUid: "u2", label: "Mingxuan Zhang", content: "在", mention: false },
    { ...base(5), type: "user_message", content: "[系统] 「Otto开发」在上一条发言里 @ 了「Otto产品经理」" },
  ];

  it("四个来源都进名单，系统旁白的保留名也在；接力开场白那种没有「]: 」前缀的不算名字", () => {
    const { names, self } = speakerNamesOf(events, "dev");
    expect([...names].sort()).toEqual(["Mingxuan Zhang", "Otto产品经理", "Otto开发", "Stan Yan", "系统"].sort());
    expect(self).toBe("Otto开发");
  });

  it("自己是谁按 agentId 从最新一条 agent_briefed 取；没配 agentId 就是 null", () => {
    expect(speakerNamesOf(events).self).toBeNull();
    expect(speakerNamesOf(events, "pm").self).toBeNull();
  });
});
