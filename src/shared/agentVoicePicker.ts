// agentVoicePicker —— 挑「说话的声音」那张表的判据（#1356 A4b，#1372，spec §10 第 95–98 条）。纯逻辑零 IO；
// 手机的 VoicePickerSheet 只画这些。哪天桌面也要这一格，同一份拿去用（维护者 2026-09-27 定桌面先只读）。
//
// 表是「自动」+ 六档：「自动」= 没挑过 = 按 agentId 派生；点一行就换成它并念一句它自己的话。
// 每一行底下写出别的哪几只此刻也是这个声音（同一场电话里撞声音由人自己决定）；试听那一句从表单此刻的
// 名字与职责来；念不了的时候说清为什么，挑照样能挑、能存。

import {
  AGENT_VOICE_CHOICES, agentVoiceId, agentVoiceIds, voiceChoiceOf, type VoiceRosterEntry,
} from "./agentVoice.js";
import type { BillingSnapshotView } from "./shellBridge.js";
import { ttsBlocked, ttsHostedOf } from "./ttsRoute.js";
import { ADMIN_AGENT_ID } from "./workspaceAgents.js";

/** 表里「自动」那一行的键（不会与六档撞：那六个是拼音缩写） */
export const VOICE_AUTO = "auto";

const AUTO_HINT = "没挑过就是它：按它自己派一个，和别的几只错开";
const ADMIN_AUTO_HINT = "没挑过时用固定的那一个，到哪儿都听得出是它";

export interface VoicePickerRow {
  /** VOICE_AUTO 或那一档的键 */
  key: string;
  label: string;
  hint: string;
  /** 这一行此刻被勾着（表单此刻的选择） */
  checked: boolean;
  /** 试听这一行念的音色：一档就是它自己的；「自动」是这一只没挑时会派到的那一个 */
  voiceId: string;
  /** 「「开发」也是这个声音」；没有别的智能体是这个声音 → null（「自动」那一行恒为 null） */
  also: string | null;
}

/** 设置页那一行右边写什么：挑过的写那一档的名字，没挑过 / 认不出的键写「自动」 */
export function voiceRowValue(voice: string | null): string {
  return voiceChoiceOf(voice)?.label ?? "自动";
}

/**
 * 表的七行。`agents` 是名册（顺序 = 派生解撞的顺序），带各自**存下来**的那一格；这一只按表单此刻的
 * `picked` 算（还没存），所以「谁也是这个声音」说的是「照你此刻的选择，存下去之后」的样子。
 * 名册里还没有这一只（快照没刷回来）也答得出：它排在最后。
 */
export function voicePickerRows(o: {
  agentId: string;
  picked: string | null;
  agents: readonly { agentId: string; name: string; voice?: string }[];
}): VoicePickerRow[] {
  const entryOf = (agentId: string, voice: string | null | undefined): VoiceRosterEntry =>
    typeof voice === "string" ? { agentId, voice } : { agentId };
  const rosterWith = (voice: string | null): VoiceRosterEntry[] => {
    const rest = o.agents.map((a) => (a.agentId === o.agentId ? entryOf(o.agentId, voice) : entryOf(a.agentId, a.voice)));
    return o.agents.some((a) => a.agentId === o.agentId) ? rest : [...rest, entryOf(o.agentId, voice)];
  };
  const chosen = voiceChoiceOf(o.picked);
  const now = agentVoiceIds(rosterWith(chosen === null ? null : chosen.key));
  const others = o.agents.filter((a) => a.agentId !== o.agentId);
  const alsoOf = (voiceId: string): string | null => {
    const names = others.filter((a) => now.get(a.agentId) === voiceId).map((a) => `「${a.name}」`);
    return names.length === 0 ? null : `${names.join("")}也是这个声音`;
  };
  return [
    {
      key: VOICE_AUTO,
      label: "自动",
      hint: o.agentId === ADMIN_AGENT_ID ? ADMIN_AUTO_HINT : AUTO_HINT,
      checked: chosen === null,
      voiceId: agentVoiceId(o.agentId, rosterWith(null)),
      also: null,
    },
    ...AGENT_VOICE_CHOICES.map((c) => ({
      key: c.key,
      label: c.label,
      hint: c.hint,
      checked: chosen?.key === c.key,
      voiceId: c.voiceId,
      also: alsoOf(c.voiceId),
    })),
  ];
}

/** 试听那一句里职责最多几个字：一句的钱与等待都跟字数走 */
export const PREVIEW_ROLE_MAX = 24;

/** 试听念的那一句：「我是{名字}，{职责第一句}。」。名字与职责取表单此刻的样子（还没存也算）；
    职责只取第一行第一句、去掉句尾的逗号冒号、最多 PREVIEW_ROLE_MAX 个字 */
export function voicePreviewText(name: string, description: string): string {
  const who = name.trim();
  const firstLine = description.split(/\r?\n/)[0] ?? "";
  const firstSentence = (firstLine.split(/[。！？!?；;]/)[0] ?? "").trim().replace(/[，,、：:\s]+$/u, "");
  const role = [...firstSentence].slice(0, PREVIEW_ROLE_MAX).join("");
  if (who !== "" && role !== "") return `我是${who}，${role}。`;
  if (who !== "") return `我是${who}。`;
  if (role !== "") return `${role}。`;
  return "开语音时我就用这个声音。";
}

/** 这一刻念不念得了；念不了时页脚那一句（null = 订阅快照还没查到，不下结论） */
export type VoicePreviewState = { can: true } | { can: false; note: string | null };

const trimEnd = (s: string): string => s.trim().replace(/[。.！!？?\s]+$/u, "");

/** 顺序同 mobileCall.joinBlockedText：先看这台有没有放音的本事，再看此刻在不在听电话（同一个
    音频引擎），最后看订阅——扣款没成功不是没订阅（ADR-0240），两句分开说 */
export function voicePreviewState(o: {
  native: boolean;
  inCall: boolean;
  billing: BillingSnapshotView | null;
}): VoicePreviewState {
  if (!o.native) return { can: false, note: "这个版本的 app 放不出声音（要装带语音的开发版）。挑了照样存，下次打电话就用它。" };
  if (o.inCall) return { can: false, note: "正在听电话，挂了再试听。挑了照样存。" };
  if (o.billing === null) return { can: false, note: null };
  if (o.billing.me?.status === "past_due") {
    return { can: false, note: "这个账号的订阅扣款没成功，试听念不了（「账号 → 订阅」）。挑了照样存。" };
  }
  const hosted = ttsHostedOf(o.billing);
  if (hosted === undefined || !hosted.subscribed) {
    return { can: false, note: "试听要订阅 Pro 或 Max（「账号 → 订阅」），和打电话是同一条路。挑了照样存。" };
  }
  const blocked = ttsBlocked(hosted);
  if (blocked !== null) return { can: false, note: `试听这一刻念不了：${trimEnd(blocked)}。挑了照样存。` };
  return { can: true };
}

export const VOICE_PICKER_NOTE = "点一下就换成它，并念一句它自己的话。试听和打电话一样，用的是你的订阅额度。";
export const VOICE_PICKER_NOTE_QUIET = "点一下就换成它。";

/** 表底下那一句：念得了说规矩（含「用你的额度」），念不了说为什么，还没查到只说怎么挑 */
export function voicePickerFooter(s: VoicePreviewState): string {
  if (s.can) return VOICE_PICKER_NOTE;
  return s.note ?? VOICE_PICKER_NOTE_QUIET;
}

/** 念不出来（合成失败 / 放不出来）时那一行的红字 */
export function voicePreviewError(message: string): string {
  const m = trimEnd(message);
  return m === "" ? "念不出来。挑了照样存。" : `念不出来：${m}。挑了照样存。`;
}
