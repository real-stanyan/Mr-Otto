// voiceMic —— 群语音里「人说话」那一半的渲染层纯逻辑（#1176，ADR-0273）：helper 的事件
// → 麦克风状态（开着 / 半双工暂停 / 没权限 / 出错 / 实时字幕），final 交给调用方发出去
// （不 @ = 走 ADR-0270 的派活）。零 DOM、零 IPC；store 的接线不在这里。
//
// 半双工（维护者拍板：常开麦）：agent 在说、或队列里还排着要说的段 → 闭麦。不闭的话
// 扬声器里它自己的话会被麦克风录回去、当成人说的再发出去——一个自激的回路。判据看
// `queued` 而不只看 `speaking`：段与段之间 speaking 会闪一下 null（预取好的下一段紧接着起播），
// 只看它会在每两段之间开一次麦、再关一次。
//
// **有回声消除就不半双工**（#1184，ADR-0277）：helper 报 `status.aec === true` = 系统级 AEC 开着，
// 扬声器里 agent 的话已经从麦克风输入里减掉了（真机探针：`say` 放的一句一个字都没被录回去），
// 麦可以一直开着——人在 agent 说话时开口就是**插话**（bargeInOn）：停播放、这只这一轮剩下的话
// 不读。开不了 AEC（老机器 / 接口抛错）或旧 helper 没报这一格 → 照旧半双工。
// 打断的门槛两道：够长（≥ 3 个 token，咳嗽 / 应声不算）+ 不像它自己的话被录回来（与正在读的那段
// token 重叠 < 70%，AEC 的兜底——同 dryrun 的 echoFilter）。

import type { SpeechEvent } from "../../../shared/shellBridge.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

export type MicStatus = "off" | "starting" | "listening" | "paused" | "denied" | "error";

export interface MicState {
  status: MicStatus;
  /** 正在说的这一句（识别器的实时快照）；一句收口即清 */
  transcript: string;
  /** 给人看的一句：没权限去哪儿勾 / 识别出错 / 发不出去 */
  error: string | null;
  /** 这台机器能不能本机识别（status 事件报的；null = 还不知道） */
  onDevice: boolean | null;
  /** 系统回声消除开没开（status 事件报的；null = 还不知道 / 旧 helper）——决定要不要半双工 */
  aec: boolean | null;
  /** 麦克风此刻的能量 0..1（画声浪用） */
  level: number;
  /** 能量门判「有人在说话」 */
  active: boolean;
}

export const MIC_OFF: MicState = { status: "off", transcript: "", error: null, onDevice: null, aec: null, level: 0, active: false };

/** 识别语言。先钉 zh-CN（维护者与团队都说中文）；换语言是设置项那一层的事 */
export const SPEECH_LOCALE = "zh-CN";

function permissionHelp(which: "麦克风" | "语音识别"): string {
  return `没有「${which}」权限：系统设置 → 隐私与安全性 → ${which}，勾上 Mr Otto（开发时是 Electron / MrOttoSpeech），然后重新开麦。`;
}

/** 一条 helper 事件进来。`final` 在场 = 这一句说完了，调用方拿去发；空串不交出 */
export function applySpeechEvent(state: MicState, ev: SpeechEvent): { state: MicState; final?: string } {
  switch (ev.type) {
    case "status": {
      const denied =
        ev.speech === "denied" || ev.speech === "restricted" ? "语音识别"
        : ev.mic === "denied" || ev.mic === "restricted" ? "麦克风"
        : null;
      if (denied !== null) return { state: { ...state, status: "denied", error: permissionHelp(denied), onDevice: ev.onDevice, aec: ev.aec } };
      return { state: { ...state, onDevice: ev.onDevice, aec: ev.aec } };
    }
    case "listening":
      return ev.on
        ? { state: { ...state, status: "listening", error: null } }
        : { state: { ...state, status: "off", transcript: "", level: 0, active: false } };
    case "level":
      return { state: { ...state, level: ev.value, active: ev.active } };
    case "played":
    case "playError":
      return { state }; // 播放回执归 helperAudio，不是麦克风的状态
    case "paused":
      return { state: { ...state, status: "paused" } };
    case "resumed":
      return { state: { ...state, status: "listening" } };
    case "partial":
      return { state: { ...state, status: "listening", transcript: ev.text, error: null } };
    case "final": {
      const text = ev.text.trim();
      return { state: { ...state, status: "listening", transcript: "", error: null }, ...(text !== "" ? { final: text } : {}) };
    }
    case "error":
      // 没权限那句（status 说的）比 helper 紧接着报的 error 更有用：前者说去哪儿勾
      if (state.status === "denied") return { state };
      return { state: { ...state, status: "error", error: ev.message } };
  }
}

/** 半双工：此刻该不该闭麦。回声消除开着就永远不闭（人可以插话） */
export function micShouldPause(p: { speaking: string | null; queued: number; aec: boolean | null }): boolean {
  if (p.aec === true) return false;
  return p.speaking !== null || p.queued > 0;
}

/** 汉字逐字一个 token，其余按空白切词；标点不算。与 dryrun 的 echoFilter 同一个定义 */
export function speechTokens(s: string): string[] {
  return s
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff]/g, " $& ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** 识别出来的这句像不像扬声器里那段话被录回来：这句的 token 有 ≥ threshold 落在那段话里。
    回声消除的兜底——AEC 偶尔漏一点，漏出来的正是 agent 自己的话 */
export function isSelfEcho(text: string, spoken: string, threshold = 0.7): boolean {
  if (spoken === "") return false;
  const tokens = speechTokens(text);
  if (tokens.length === 0) return false;
  const set = new Set(speechTokens(spoken));
  return tokens.filter((t) => set.has(t)).length / tokens.length >= threshold;
}

/** 插话的最短长度：三个 token。「嗯」「好的」是应声不是插话，「等一下」才是 */
export const BARGE_IN_MIN_TOKENS = 3;

/** 人开口了（一片 partial 到了）：要不要打断 agent 的播放。没东西可停 → 否 */
export function bargeInOn(partial: string, playing: { speaking: string | null; queued: number }, spoken: string): boolean {
  if (playing.speaking === null && playing.queued === 0) return false;
  if (speechTokens(partial).length < BARGE_IN_MIN_TOKENS) return false;
  return !isSelfEcho(partial, spoken);
}

/** 喂给识别器的上下文词表最多几条（SFSpeech 的 contextualStrings 建议不超过百来条） */
export const SPEECH_HINTS_MAX = 100;

/** 开发者群里常说、本机 zh-CN 识别器却往拼音上靠的英文词（真机：「push 到 GitHub 的 main」听成
    「p到get up的密封值」，#1196）。人手维护、会过时；团队自己的名字（agent / 成员 / 团队名）排在前面 */
export const SPEECH_HINTS_DEV: readonly string[] = [
  "GitHub", "push", "pull", "merge", "PR", "main", "master", "commit", "branch", "checkout", "rebase",
  "deploy", "release", "build", "bug", "fix", "feature", "issue", "review", "API", "SDK", "CLI",
  "Docker", "VPS", "Supabase", "Stripe", "Cloudflare", "Electron", "React", "TypeScript", "Swift",
  "Python", "Node", "npm", "Git", "token", "JWT", "OAuth", "MCP", "Otto", "Mr Otto",
  // 中文这边也有识别器常听岔的产品词（真机「侧栏」→「下册栏」）
  "侧栏", "浮窗", "弹窗", "按钮", "页面", "首页", "网页版", "手机版", "桌面端", "仓库", "分支", "提交", "合并", "部署", "上线", "测试", "接口", "数据库",
];

/** 这个团队开麦时的词表：agent 名 + 成员名 + 团队名在前，开发常用词在后；空串丢、去重、封顶 */
export function speechHints(ws: WorkspaceSnapshot | null): string[] {
  const own = ws === null ? [] : [...ws.agents.map((a) => a.name), ...ws.members.map((m) => m.label), ws.name];
  const out: string[] = [];
  for (const h of [...own, ...SPEECH_HINTS_DEV]) {
    const t = h.trim();
    if (t === "" || out.includes(t)) continue;
    out.push(t);
    if (out.length >= SPEECH_HINTS_MAX) break;
  }
  return out;
}
