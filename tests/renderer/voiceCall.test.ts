// 渲染层语音引擎的纯逻辑（#1163）：语音钮画不画、一段文字读出来之前剥什么、
// 流式预览里哪几段已经完成可以合成、终态落下来时还有哪几段没读。
import { describe, expect, it } from "vitest";
import {
  EMPTY_VOICE_FEED, feedDelta, feedEvent, markInterrupted, splitSpoken, spokenText, voiceCallAvailable, type VoiceFeedState,
} from "../../src/renderer/src/lib/voiceCall.js";
import type { BillingMe } from "../../src/shared/billing.js";
import type { SessionEvent } from "../../src/session/events.js";

const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  models: [], imageModels: [], ttsModels: ["speech-2.8-turbo"], modelPlatforms: {}, ...over,
});
const snap = (m: BillingMe | null) => ({ me: m, fetchedAt: 0, exhausted: null });

describe("voiceCallAvailable：语音钮画不画", () => {
  it("订阅活跃 + 网关供语音 → true", () => {
    expect(voiceCallAvailable(snap(me()))).toBe(true);
  });
  it("还没查到 / 没订阅 / 网关不供语音 → 都不画（同一个答案：空，同 modelMenu 对 hosted 的处置）", () => {
    expect(voiceCallAvailable(null)).toBe(false);
    expect(voiceCallAvailable(snap(null))).toBe(false);
    expect(voiceCallAvailable(snap(me({ status: "none", plan: null })))).toBe(false);
    expect(voiceCallAvailable(snap(me({ status: "past_due" })))).toBe(false);
    expect(voiceCallAvailable(snap(me({ ttsModels: [] })))).toBe(false);
  });
});

describe("spokenText：读出来之前剥什么", () => {
  it("剥 [名字]: 前缀、加粗 / 标题 / 列表记号、链接只留文字、行内反引号只留内容", () => {
    expect(spokenText("[运营]: **结论**：先看 `sales.csv`")).toBe("结论：先看 sales.csv");
    expect(spokenText("# 标题\n- 第一件\n1. 第二件\n* 第三件")).toBe("标题\n第一件\n第二件\n第三件");
    expect(spokenText("看[这份报表](https://x.y/z)和 ![图](https://x.y/a.png)")).toBe("看这份报表和 图");
  });
  it("代码围栏整段不念；只剩围栏的一段读出来是空串", () => {
    expect(spokenText("跑这个：\n```sh\nnpm test\n```\n然后看结果")).toBe("跑这个：\n然后看结果");
    expect(spokenText("```\nx\n```")).toBe("");
    // 没关上的围栏（流式里还没写完）：从围栏起全部不念
    expect(spokenText("先说结论\n```js\nconst a = 1")).toBe("先说结论");
  });
  it("首尾空白剥掉；空行折成一行", () => {
    expect(spokenText("  你好 \n\n\n世界  ")).toBe("你好\n世界");
  });
});

const P = new Set(["a", "b"]);
const chat = (agentId: string, seq: number, content: string): SessionEvent =>
  ({ sessionId: "s", ts: 0, seq, type: "assistant_message", content, model: "m", agentId });

describe("feedDelta：流式预览里完成的段立刻出声", () => {
  it("快照「a\\n\\nb\\n\\nc（未完）」出 a、b；再来「a\\n\\nb\\n\\nc\\n\\nd」只出 c；不在名单的一段都不出", () => {
    let s: VoiceFeedState = EMPTY_VOICE_FEED;
    let r = feedDelta(s, P, "a", "第一段\n\n第二段\n\n第三");
    expect(r.out).toEqual([{ agentId: "a", text: "第一段" }, { agentId: "a", text: "第二段" }]);
    s = r.state;
    r = feedDelta(s, P, "a", "第一段\n\n第二段\n\n第三段\n\n第四");
    expect(r.out).toEqual([{ agentId: "a", text: "第三段" }]);
    s = r.state;
    // 同一份快照再来一遍（中继重发）：一段都不重读
    r = feedDelta(s, P, "a", "第一段\n\n第二段\n\n第三段\n\n第四");
    expect(r.out).toEqual([]);
    expect(r.state).toBe(s); // 没变就是同一个对象（调用方据此跳过一次 set）
    expect(feedDelta(s, P, "z", "别人\n\n说的").out).toEqual([]);
  });

  it("只有一段（还没空行）：什么都不出——那一段可能没写完", () => {
    expect(feedDelta(EMPTY_VOICE_FEED, P, "a", "还在写").out).toEqual([]);
  });

  it("完成的段剥完是空的（纯代码围栏）：跳过但记成已读", () => {
    const r = feedDelta(EMPTY_VOICE_FEED, P, "a", "```\nx\n```\n\n然后\n\n再");
    expect(r.out).toEqual([{ agentId: "a", text: "然后" }]);
    expect(r.state.spoken.a).toEqual(["```\nx\n```", "然后"]);
  });
});

describe("feedEvent：终态落下来补读没读过的段，然后清这只的记号", () => {
  it("a、b 已读后终态「a\\n\\nb\\n\\nc」只出 c；之后这只的记号清空", () => {
    const s = feedDelta(EMPTY_VOICE_FEED, P, "a", "第一段\n\n第二段\n\n第三").state;
    const r = feedEvent(s, P, 0, chat("a", 5, "第一段\n\n第二段\n\n第三段"));
    expect(r.out).toEqual([{ agentId: "a", text: "第三段" }]);
    expect(r.state.spoken.a).toBeUndefined();
  });

  it("seq ≤ 加入那一刻的日志尾 = 历史，不读；工具步（content 空）不读；turn_ended 清记号；无关事件原样返回", () => {
    expect(feedEvent(EMPTY_VOICE_FEED, P, 10, chat("a", 5, "旧话")).out).toEqual([]);
    expect(feedEvent(EMPTY_VOICE_FEED, P, 0, chat("a", 5, "")).out).toEqual([]);
    const s = feedDelta(EMPTY_VOICE_FEED, P, "a", "x\n\ny\n\n").state;
    const ended: SessionEvent = { sessionId: "s", ts: 0, seq: 6, type: "turn_ended", outcome: "aborted", agentId: "a" };
    expect(feedEvent(s, P, 0, ended).state.spoken.a).toBeUndefined();
    const other: SessionEvent = { sessionId: "s", ts: 0, seq: 7, type: "user_message", content: "hi" };
    expect(feedEvent(s, P, 0, other).state).toBe(s);
  });

  it("没走过流式（旧 runtime / 掉帧）：终态整条按段全读", () => {
    const r = feedEvent(EMPTY_VOICE_FEED, P, 0, chat("b", 5, "一\n\n二"));
    expect(r.out).toEqual([{ agentId: "b", text: "一" }, { agentId: "b", text: "二" }]);
  });

  it("不在名单里的 agent 终态：不读，也不动状态", () => {
    expect(feedEvent(EMPTY_VOICE_FEED, P, 0, chat("z", 5, "一\n\n二")).out).toEqual([]);
  });
});

// 按句出声（#1184）：一段（气泡）里第一句写完就合成，不等整段——首句出声从「整段写完 + 合成」
// 缩到「第一句写完 + 合成」。切句的判据与气泡切段叠着用：先按空行切段，段内再按句末标点切。
describe("splitSpoken：段内按句切", () => {
  it("中文句末标点（。！？）每个后面都切；逗号不切；最后一句没标点也留着", () => {
    expect(splitSpoken("一句。两句！三句？四")).toEqual(["一句。", "两句！", "三句？", "四"]);
    expect(splitSpoken("好的，我看一下。")).toEqual(["好的，我看一下。"]);
  });
  it("西文句末（.?!）后面要跟空白才切：2.0 / Dr. 不切；省略号连成一串", () => {
    expect(splitSpoken("Hello there. How are you? Fine")).toEqual(["Hello there.", "How are you?", "Fine"]);
    expect(splitSpoken("v2.0 is out. Wait... what")).toEqual(["v2.0 is out.", "Wait...", "what"]);
  });
  it("空行仍然是段界；代码围栏整块一个单位不切句", () => {
    expect(splitSpoken("第一段。还有\n\n第二段")).toEqual(["第一段。", "还有", "第二段"]);
    expect(splitSpoken("```\na. b.\n```\n\n然后。")).toEqual(["```\na. b.\n```", "然后。"]);
  });
});

describe("feedDelta 按句：一段里写完的句子立刻出声", () => {
  it("「好的，我看一下。还在写」出第一句；下一片补上后一句；终态一句都不重读", () => {
    let r = feedDelta(EMPTY_VOICE_FEED, P, "a", "好的，我看一下。还在写");
    expect(r.out).toEqual([{ agentId: "a", text: "好的，我看一下。" }]);
    r = feedDelta(r.state, P, "a", "好的，我看一下。还在写的这句也完了。");
    expect(r.out).toEqual([{ agentId: "a", text: "还在写的这句也完了。" }]);
    const fin = feedEvent(r.state, P, 0, chat("a", 5, "好的，我看一下。还在写的这句也完了。\n\n第二段"));
    expect(fin.out).toEqual([{ agentId: "a", text: "第二段" }]);
  });
  it("最后一句以西文句号收尾时不算完（可能是 2. 这种半截）；中文句号算完", () => {
    expect(feedDelta(EMPTY_VOICE_FEED, P, "a", "Version 2.").out).toEqual([]);
    expect(feedDelta(EMPTY_VOICE_FEED, P, "a", "好。").out).toEqual([{ agentId: "a", text: "好。" }]);
  });
});

describe("打断（#1184）：人插话之后这只这一轮剩下的话不读", () => {
  it("markInterrupted 之后的快照与终态都不出声（但记成已读）；turn_ended 清掉之后下一轮照读", () => {
    let s = feedDelta(EMPTY_VOICE_FEED, P, "a", "第一句。第二").state;
    s = markInterrupted(s, "a");
    let r = feedDelta(s, P, "a", "第一句。第二句。第三");
    expect(r.out).toEqual([]);
    r = feedEvent(r.state, P, 0, chat("a", 5, "第一句。第二句。第三句。"));
    expect(r.out).toEqual([]);
    const ended: SessionEvent = { sessionId: "s", ts: 0, seq: 6, type: "turn_ended", outcome: "completed", agentId: "a" };
    s = feedEvent(r.state, P, 0, ended).state;
    expect(s.interrupted).toEqual([]);
    expect(feedDelta(s, P, "a", "新一轮。还在").out).toEqual([{ agentId: "a", text: "新一轮。" }]);
    // 别的那只不受影响
    expect(feedDelta(markInterrupted(EMPTY_VOICE_FEED, "a"), P, "b", "我照说。还在").out).toEqual([{ agentId: "b", text: "我照说。" }]);
  });
});
