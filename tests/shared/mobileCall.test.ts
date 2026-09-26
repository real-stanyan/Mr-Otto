// mobileCall（#1356 A4，spec §5.7）：手机聊天页「电话」那一格的判据。
import { describe, expect, it } from "vitest";
import type { BillingMe } from "../../src/shared/billing.js";
import type { VoiceCallCard, VoiceCallCardLine } from "../../src/shared/cloudTimeline.js";
import {
  CALL_TOPIC_MAX, callBarMode, callFace, callTopicText, joinBlockedText, phoneOffered, waveAmplitude, waveMode,
} from "../../src/shared/mobileCall.js";
import type { OpenTurn } from "../../src/shared/turnLedger.js";
import type { VoiceCallState } from "../../src/shared/voiceCall.js";

const CALL: VoiceCallState = { participants: [{ agentId: "a", name: "开发" }, { agentId: "b", name: "运维" }], sinceSeq: 3, sinceTs: 1000 };
const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  models: [], imageModels: [], ttsModels: ["speech-2.8-turbo"], modelPlatforms: {}, ...over,
});
const snap = (m: BillingMe | null) => ({ me: m, fetchedAt: 0, exhausted: null });
const line = (o: Partial<VoiceCallCardLine>): VoiceCallCardLine => ({
  seq: 1, parts: null, label: "开发", avatar: null, offsetMs: 0, text: "", mine: false, ...o,
});
const card = (lines: VoiceCallCardLine[]): VoiceCallCard => ({ seq: 1, sinceTs: 0, endedTs: null, utterances: lines.length, parties: [], lines });

describe("phoneOffered：输入框空着时那颗是不是「开电话」", () => {
  const ok = { voiceUsable: true, ready: true, agentIds: ["a"], call: null };
  it("这台打得了、房间 ready、有智能体、还没有通话 → 是", () => {
    expect(phoneOffered(ok)).toBe(true);
  });
  it("任何一条不成立 → 退回灰的发送钮", () => {
    expect(phoneOffered({ ...ok, voiceUsable: false })).toBe(false);
    expect(phoneOffered({ ...ok, ready: false })).toBe(false);
    expect(phoneOffered({ ...ok, agentIds: [] })).toBe(false);
    expect(phoneOffered({ ...ok, call: CALL })).toBe(false);
  });
});

describe("callBarMode", () => {
  it("没有通话 = 输入框；这台在听 = live；通话开着而这台没在听 = idle", () => {
    expect(callBarMode({ call: null, listeningHere: true })).toBe("none");
    expect(callBarMode({ call: CALL, listeningHere: true })).toBe("live");
    expect(callBarMode({ call: CALL, listeningHere: false })).toBe("idle");
  });
});

describe("callFace：电话那一格左边那张脸", () => {
  const open = (agentId: string, state: OpenTurn["state"]): OpenTurn => ({ seq: 9, fromUid: "me", agentId, state });
  it("谁在说画谁", () => {
    expect(callFace({ call: CALL, speaking: "b", open: [] })).toEqual({ agentId: "b", state: "speaking" });
  });
  it("名单外那只在说不算；没人说时画欠着回答的那只（在跑 = 在想、还没轮到 = 排队）", () => {
    expect(callFace({ call: CALL, speaking: "x", open: [open("b", "running")] })).toEqual({ agentId: "b", state: "composing" });
    expect(callFace({ call: CALL, speaking: null, open: [open("a", "queued")] })).toEqual({ agentId: "a", state: "queued" });
  });
  it("都没有 → 通话里第一只，在听", () => {
    expect(callFace({ call: CALL, speaking: null, open: [open("x", "running")] })).toEqual({ agentId: "a", state: "listening" });
  });
});

describe("声浪", () => {
  it("waveMode：它在说排第一；关着麦是 off；人在说是 me；都没说是 quiet", () => {
    expect(waveMode({ micOn: true, micActive: true, agentSpeaking: true })).toBe("agent");
    expect(waveMode({ micOn: false, micActive: false, agentSpeaking: true })).toBe("agent");
    expect(waveMode({ micOn: false, micActive: false, agentSpeaking: false })).toBe("off");
    expect(waveMode({ micOn: true, micActive: true, agentSpeaking: false })).toBe("me");
    expect(waveMode({ micOn: true, micActive: false, agentSpeaking: false })).toBe("quiet");
  });
  it("waveAmplitude：off 为 0（一条灰线）、quiet 一口轻气、agent 满、me 按能量钳到 0..1（读不出来当 0）", () => {
    expect(waveAmplitude("off", 1)).toBe(0);
    expect(waveAmplitude("quiet", 1)).toBe(0.12);
    expect(waveAmplitude("agent", 0)).toBe(1);
    expect(waveAmplitude("me", 0.4)).toBe(0.4);
    expect(waveAmplitude("me", 1.7)).toBe(1);
    expect(waveAmplitude("me", -2)).toBe(0);
    expect(waveAmplitude("me", Number.NaN)).toBe(0);
  });
});

describe("callTopicText：通话卡第二行「聊的什么」", () => {
  it("我说的第一句；名单变更那几行不算", () => {
    const c = card([
      line({ seq: 1, parts: [{ kind: "text", text: "Stan 把「运维」拉进了通话" }] }),
      line({ seq: 2, text: "你好，我是开发。" }),
      line({ seq: 3, text: "帮我查下部署\n顺便看下日志", mine: true }),
    ]);
    expect(callTopicText(c)).toBe("帮我查下部署");
  });
  it("我一句没说 → 它说的第一句；都没有 → null", () => {
    expect(callTopicText(card([line({ text: "  你好，我是开发。 " })]))).toBe("你好，我是开发。");
    expect(callTopicText(card([]))).toBeNull();
    expect(callTopicText(card([line({ parts: [{ kind: "text", text: "结束了语音通话" }] })]))).toBeNull();
  });
  it("超长按码点截断加「…」，不劈开代理对", () => {
    const long = "\u{1F600}".repeat(30);
    const out = callTopicText(card([line({ text: long, mine: true })]));
    expect([...(out ?? "")]).toHaveLength(CALL_TOPIC_MAX + 1);
    expect(out?.endsWith("…")).toBe(true);
    expect(out?.startsWith("\u{1F600}")).toBe(true);
  });
});

describe("joinBlockedText：这台为什么接不了", () => {
  const ok = { native: true, ready: true, billing: snap(me()) };
  it("接得了 → null", () => {
    expect(joinBlockedText(ok)).toBeNull();
  });
  it("没有原生模块（Expo Go）→ 说要开发版", () => {
    expect(joinBlockedText({ ...ok, native: false })).toContain("开发版");
  });
  it("房间没 ready / 订阅还没查到 → 说在等（不说没订阅）", () => {
    expect(joinBlockedText({ ...ok, ready: false })).toContain("连上");
    const pending = joinBlockedText({ ...ok, billing: null });
    expect(pending).toContain("查订阅");
    expect(pending).not.toContain("订阅 Pro");
  });
  it("没订阅 → 手机那句（不指「设置 → 订阅」，手机上没有那一页）；网关不供语音 → 说不供", () => {
    const none = joinBlockedText({ ...ok, billing: snap(me({ status: "none", plan: null })) });
    expect(none).toBe("订阅 Pro 或 Max 之后才打得了电话。");
    const noTts = joinBlockedText({ ...ok, billing: snap(me({ ttsModels: [] })) });
    expect(noTts).toContain("语音");
    expect(noTts).not.toContain("订阅 Pro");
  });
});
