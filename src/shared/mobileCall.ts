// mobileCall —— 手机聊天页「电话」那一格的判据（#1356 A4，spec §5.7）。纯逻辑，ChatScreen / CallBar 只画。

import { callDurationText, type VoiceCallCard } from "./cloudTimeline.js";
import type { BillingSnapshotView } from "./shellBridge.js";
import type { OpenTurn } from "./turnLedger.js";
import { ttsBlocked, ttsHostedOf } from "./ttsRoute.js";
import type { VoiceCallState } from "./voiceCall.js";

/** 输入框空着时右边那颗是不是「开电话」（spec §5.3 一物两用）：这台打得了电话、房间 ready、这条聊天里
    有智能体、还没有通话。任何一条不成立都退回那颗灰的发送钮——说不清就不画（#722）。私聊草稿（第一句还
    没发、还没有会话）里 ready 天然不成立：电话要一条会话才打得了 */
export function phoneOffered(o: { voiceUsable: boolean; ready: boolean; agentIds: readonly string[]; call: VoiceCallState | null }): boolean {
  return o.voiceUsable && o.ready && o.agentIds.length > 0 && o.call === null;
}

export type CallBarMode = "none" | "live" | "idle";

/** 输入框那一格此刻画什么：没有通话 = 输入框；通话开着且这台在听 = 电话那一格（live）；通话开着而这台
    没在听（锁过屏、从名册回来、通话是另一台设备开的）= 「通话还开着」那一格（idle）。判据是日志里的
    通话名单（voiceCallOf），不是「我刚按了」 */
export function callBarMode(o: { call: VoiceCallState | null; listeningHere: boolean }): CallBarMode {
  if (o.call === null) return "none";
  return o.listeningHere ? "live" : "idle";
}

export interface CallFace {
  agentId: string;
  state: "speaking" | "composing" | "queued" | "listening";
}

/** 电话那一格左边那张脸：谁在说画谁（在说）；没人说时画欠着回答的那只（在跑 = 在想、还没轮到 = 排队）；
    都没有画通话里第一只（在听）。只认通话名单里的——名单外那只在干什么，这一格不管 */
export function callFace(o: { call: VoiceCallState; speaking: string | null; open: readonly OpenTurn[] }): CallFace | null {
  const ids = o.call.participants.map((p) => p.agentId);
  if (o.speaking !== null && ids.includes(o.speaking)) return { agentId: o.speaking, state: "speaking" };
  const owed = o.open.find((t) => ids.includes(t.agentId));
  if (owed !== undefined) return { agentId: owed.agentId, state: owed.state === "running" ? "composing" : "queued" };
  const first = ids[0];
  return first === undefined ? null : { agentId: first, state: "listening" };
}

export type WaveMode = "off" | "me" | "agent" | "quiet";

/** 声浪画谁的：它在说排第一（没有回声消除时它的声音会漏进麦克风，按能量画会把它说的画成你说的）；
    关着麦 = 一条灰线；人在说 = 按麦克风能量；都没说 = 一口轻气（不是停住——停住读作坏了） */
export function waveMode(o: { micOn: boolean; micActive: boolean; agentSpeaking: boolean }): WaveMode {
  if (o.agentSpeaking) return "agent";
  if (!o.micOn) return "off";
  return o.micActive ? "me" : "quiet";
}

/** 声浪此刻有多响（0..1）：关着麦 = 0（一条灰线）；都没说 = 一口轻气（0.12——不是停住，停住读作坏了）；
    它在说 = 1（这边量不到它的音量，画的是「有话在说」不是音量）；人在说 = 麦克风能量（钳到 0..1，读不出来当 0）。
    每根条自己的起伏在界面那侧（原生驱动的循环，mobile/src/voice/CallBar.tsx），这里只给整体的响度 */
export function waveAmplitude(mode: WaveMode, level: number): number {
  if (mode === "off") return 0;
  if (mode === "agent") return 1;
  if (mode === "quiet") return 0.12;
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
}

/** 通话卡第二行「聊的什么」最多几个字 */
export const CALL_TOPIC_MAX = 24;

/** 「聊的什么」：我说的第一句；我一句没说就是它说的第一句；都没有 = null（不画那一行）。取第一行、折叠
    空白，超长按码点截断加「…」（不劈开代理对）。demo 那一行是写死的话题，真数据里没有话题这一格 */
export function callTopicText(card: VoiceCallCard): string | null {
  const said = card.lines.filter((l) => l.parts === null && l.text.trim() !== "");
  const pick = said.find((l) => l.mine) ?? said[0];
  if (pick === undefined) return null;
  const firstLine = pick.text.trim().split("\n")[0] ?? "";
  const one = firstLine.replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length <= CALL_TOPIC_MAX ? one : `${chars.slice(0, CALL_TOPIC_MAX).join("")}…`;
}

/** 通话卡上写的时长：还开着写「通话中」（不走表——电话那一格已经有一只表），结束了写 callDurationText
    （桌面同一份：不足一分钟报秒、一小时以上报「小时 + 分」） */
export function callCardDurationText(card: VoiceCallCard): string {
  return card.endedTs === null ? "通话中" : callDurationText(card.endedTs - card.sinceTs);
}

/** 这台此刻为什么接不了（「通话还开着」那一格里「接着听」换成这一句）。null = 接得了。
    没订阅那句不照抄桌面（桌面那句指「设置 → 订阅」，手机上 A5 之前没有那一页）；额度用完 / 网关不供语音
    两句照 ttsBlocked 说 */
export function joinBlockedText(o: { native: boolean; ready: boolean; billing: BillingSnapshotView | null }): string | null {
  if (!o.native) return "这个版本的 app 听不了电话：要装带语音的开发版（Expo Go 不带语音识别）。";
  if (!o.ready) return "正在连上这条聊天…";
  if (o.billing === null) return "正在查订阅…";
  const hosted = ttsHostedOf(o.billing);
  if (hosted === undefined || !hosted.subscribed) return "订阅 Pro 或 Max 之后才打得了电话。";
  return ttsBlocked(hosted);
}
