// 挑声音那张表的判据（#1356 A4b，#1372，spec §10 第 95–98 条）：每一行、设置页那一行写什么、
// 试听念哪一句、什么时候不念。手机只画这些。
import { describe, expect, it } from "vitest";
import { ADMIN_VOICE_ID, AGENT_VOICE_CHOICES, agentVoiceId, voiceChoiceOf } from "../../src/shared/agentVoice.js";
import {
  PREVIEW_TIMEOUT_MESSAGE, PREVIEW_TIMEOUT_MS, VOICE_AUTO, VOICE_PICKER_NOTE, VOICE_PICKER_NOTE_QUIET,
  voicePickerFooter, voicePickerRows, voicePreviewError, voicePreviewState, voicePreviewText, voiceRowValue,
} from "../../src/shared/agentVoicePicker.js";
import type { BillingMe } from "../../src/shared/billing.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";

const agents = [
  { agentId: "admin", name: "管理员" },
  { agentId: "a_dev", name: "开发", voice: "gan" },
  { agentId: "a_ops", name: "运维" },
];

describe("voiceRowValue", () => {
  it("没挑过 / 认不出的键写「自动」，挑过的写那一档的名字", () => {
    expect(voiceRowValue(null)).toBe("自动");
    expect(voiceRowValue("zzz")).toBe("自动");
    expect(voiceRowValue("gan")).toBe("干脆");
  });
});

describe("voicePickerRows", () => {
  it("第一行是「自动」，后面六档按 AGENT_VOICE_CHOICES 的顺序；勾跟着表单此刻的选择", () => {
    const rows = voicePickerRows({ agentId: "a_ops", picked: null, agents });
    expect(rows.map((r) => r.key)).toEqual([VOICE_AUTO, ...AGENT_VOICE_CHOICES.map((c) => c.key)]);
    expect(rows.map((r) => r.label)).toEqual(["自动", "清亮", "温和", "沉稳", "干脆", "少年", "播音"]);
    expect(rows.filter((r) => r.checked).map((r) => r.key)).toEqual([VOICE_AUTO]);
    const picked = voicePickerRows({ agentId: "a_ops", picked: "bo", agents });
    expect(picked.filter((r) => r.checked).map((r) => r.key)).toEqual(["bo"]);
  });

  it("认不出的键勾在「自动」上（当没挑过）", () => {
    expect(voicePickerRows({ agentId: "a_ops", picked: "zzz", agents }).filter((r) => r.checked).map((r) => r.key))
      .toEqual([VOICE_AUTO]);
  });

  it("每一档试听念它自己的音色；「自动」念它没挑时会派到的那一个（管理员是固定那一个）", () => {
    const rows = voicePickerRows({ agentId: "a_ops", picked: "bo", agents });
    expect(rows.find((r) => r.key === "bo")!.voiceId).toBe(voiceChoiceOf("bo")!.voiceId);
    expect(rows[0]!.voiceId).toBe(
      agentVoiceId("a_ops", [{ agentId: "admin" }, { agentId: "a_dev", voice: "gan" }, { agentId: "a_ops" }]),
    );
    expect(voicePickerRows({ agentId: "admin", picked: "bo", agents })[0]!.voiceId).toBe(ADMIN_VOICE_ID);
  });

  it("别的哪几只此刻也是这个声音，写在那一行底下；自己不算，「自动」那一行不写", () => {
    const rows = voicePickerRows({ agentId: "a_ops", picked: null, agents });
    expect(rows.find((r) => r.key === "gan")!.also).toBe("「开发」也是这个声音");
    expect(rows[0]!.also).toBeNull();
    const mine = voicePickerRows({ agentId: "a_dev", picked: "gan", agents });
    expect(mine.find((r) => r.key === "gan")!.also).toBeNull();
  });

  it("两只都挑了同一档：那一行写出另一只", () => {
    const rows = voicePickerRows({ agentId: "a_ops", picked: "gan", agents });
    expect(rows.find((r) => r.key === "gan")!.also).toBe("「开发」也是这个声音");
  });

  it("「自动」那一行的副标题：管理员与别的智能体两种说法", () => {
    expect(voicePickerRows({ agentId: "a_ops", picked: null, agents })[0]!.hint)
      .toBe("没挑过就是它：按它自己派一个，和别的几只错开");
    expect(voicePickerRows({ agentId: "admin", picked: null, agents })[0]!.hint)
      .toBe("没挑过时用固定的那一个，到哪儿都听得出是它");
  });

  it("名册里还没有这一只（快照没刷回来）：照样答得出，排在最后", () => {
    const rows = voicePickerRows({ agentId: "a_new", picked: null, agents });
    expect(rows[0]!.voiceId).toBe(agentVoiceId("a_new", [...agents, { agentId: "a_new" }]));
  });
});

describe("voicePreviewText", () => {
  it("「我是{名字}，{职责第一句}。」：取第一句、去掉句尾标点、最多 24 个字", () => {
    expect(voicePreviewText("运维", "部署与监控")).toBe("我是运维，部署与监控。");
    expect(voicePreviewText(" 运维 ", "盯部署。出事先说！")).toBe("我是运维，盯部署。");
    expect(voicePreviewText("运维", "盯部署，")).toBe("我是运维，盯部署。");
    expect(voicePreviewText("运维", "字".repeat(30))).toBe(`我是运维，${"字".repeat(24)}。`);
  });

  it("职责空着就只报名字；名字也空着（正在改）就说一句通用的", () => {
    expect(voicePreviewText("运维", "  ")).toBe("我是运维。");
    expect(voicePreviewText("", "盯部署")).toBe("盯部署。");
    expect(voicePreviewText(" ", "")).toBe("开语音时我就用这个声音。");
  });
});

const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  models: [], imageModels: [], ttsModels: ["speech-2.8-turbo"], modelPlatforms: {}, ...over,
});
const snap = (m: BillingMe | null): BillingSnapshotView => ({ me: m, fetchedAt: 0, exhausted: null });

describe("voicePreviewState / voicePickerFooter", () => {
  it("念得了：有放音的本事、没在听电话、订阅开着且网关供语音", () => {
    const s = voicePreviewState({ native: true, inCall: false, billing: snap(me()) });
    expect(s).toEqual({ can: true });
    expect(voicePickerFooter(s)).toBe(VOICE_PICKER_NOTE);
    expect(VOICE_PICKER_NOTE).toBe("点一下就换成它，并念一句它自己的话。试听和打电话一样，用的是你的订阅额度。");
  });

  it("念不了的几种各说各的；订阅快照还没查到时不说「要订阅」（还没查到 ≠ 没有）", () => {
    expect(voicePreviewState({ native: false, inCall: false, billing: snap(me()) })).toEqual({
      can: false, note: "这个版本的 app 放不出声音（要装带语音的开发版）。挑了照样存，下次打电话就用它。",
    });
    expect(voicePreviewState({ native: true, inCall: true, billing: snap(me()) })).toEqual({
      can: false, note: "正在听电话，挂了再试听。挑了照样存。",
    });
    const checking = voicePreviewState({ native: true, inCall: false, billing: null });
    expect(checking).toEqual({ can: false, note: null });
    expect(voicePickerFooter(checking)).toBe(VOICE_PICKER_NOTE_QUIET);
    expect(VOICE_PICKER_NOTE_QUIET).toBe("点一下就换成它。");
    expect(voicePreviewState({ native: true, inCall: false, billing: snap(me({ status: "past_due" })) })).toEqual({
      can: false, note: "这个账号的订阅扣款没成功，试听念不了（「账号 → 订阅」）。挑了照样存。",
    });
    const noSub = { can: false, note: "试听要订阅 Pro 或 Max（「账号 → 订阅」），和打电话是同一条路。挑了照样存。" };
    expect(voicePreviewState({ native: true, inCall: false, billing: snap(null) })).toEqual(noSub);
    expect(voicePreviewState({ native: true, inCall: false, billing: snap(me({ plan: null })) })).toEqual(noSub);
    expect(voicePreviewState({ native: true, inCall: false, billing: snap(me({ ttsModels: [] })) })).toEqual({
      can: false, note: "试听这一刻念不了：订阅网关暂时不供语音合成。挑了照样存。",
    });
    expect(voicePickerFooter({ can: false, note: "x" })).toBe("x");
  });
});

describe("voicePreviewError", () => {
  it("念不出来：原因原样带上、去掉句尾标点，后面说「挑了照样存」", () => {
    expect(voicePreviewError("网关超时。")).toBe("念不出来：网关超时。挑了照样存。");
    expect(voicePreviewError("  ")).toBe("念不出来。挑了照样存。");
  });

  it("合成等太久（PREVIEW_TIMEOUT_MS）：那一行说「等太久没回应」", () => {
    expect(PREVIEW_TIMEOUT_MS).toBe(15_000);
    expect(voicePreviewError(PREVIEW_TIMEOUT_MESSAGE)).toBe("念不出来：等太久没回应。挑了照样存。");
  });
});
