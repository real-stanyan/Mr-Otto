// agentVoice —— 智能体用哪个 MiniMax 音色（#1163）。纯逻辑零 IO，三端共用。
//
// 缺省按 agent_id 派生（维护者 2026-09-09 拍板：音色自动派生），理由与头像那次（agentAvatarSlot.ts）
// 一样：存量智能体立刻有声音，不用等谁去设置页挑。#1372（#1356 A4b，2026-09-27）起**可以挑**：
// `workspace_agents.voice` 存一个我们自己的键（`AGENT_VOICE_CHOICES` 那六档之一），null / 缺席 /
// 认不出的键都照旧派生——同 #1007 给头像加的 avatar_slot。**存键不存 MiniMax 的音色 id**：换一档
// 背后的音色只改这张表，不用跑库；DB 约束也只管形状（VOICE_KEY_RE），不写死这六个。
//
// 判据要稳：群语音里靠声音分人，同一只在两台机器、两次刷新上必须是同一个声音——所以从
// agent_id（改名不变的键）哈希，不从名字、不从名单下标。名单**顺序**只用来解撞（服务端按
// created_at 升序给，先来的先占，后来的撞上就往后挪一格）。**挑过的先占**：它们的声音是人定的，
// 派生的让开（spec §10 第 96 条）。代价同头像：一只被删、或者别人挑走了它正在用的那一档之后，
// 曾因撞它挪位的那只会换一次声音；接受。
//
// 音色表是人手维护的、会过时（MiniMax `get_voice` 接口现查得到全部 303 个系统音色，
// 2026-09-09 取的这十二个都是标准普通话、男女交错、语气各异）。id 写错的后果是
// MiniMax 回非零 status_code → 网关 502 → 通话栏一行红字，不会静默变成别的声音。

import { ADMIN_AGENT_ID } from "./workspaceAgents.js";
import { fnv1a } from "./fnv1a.js";

export interface AgentVoice {
  /** MiniMax 系统音色 id（`voice_setting.voice_id`） */
  id: string;
  /** 官方中文名 */
  label: string;
}

/** 轮换池：男女交错，让相邻派生到的两只听起来不像同一个人 */
export const AGENT_VOICES: readonly AgentVoice[] = [
  { id: "Chinese (Mandarin)_Gentleman", label: "温润男声" },
  { id: "Chinese (Mandarin)_Warm_Bestie", label: "温暖闺蜜" },
  { id: "male-qn-jingying", label: "精英青年" },
  { id: "female-yujie", label: "御姐" },
  { id: "Chinese (Mandarin)_Radio_Host", label: "电台男主播" },
  { id: "Chinese (Mandarin)_Sweet_Lady", label: "甜美女声" },
  { id: "Chinese (Mandarin)_Unrestrained_Young_Man", label: "不羁青年" },
  { id: "Chinese (Mandarin)_Gentle_Senior", label: "温柔学姐" },
  { id: "male-qn-daxuesheng", label: "青年大学生" },
  { id: "Chinese (Mandarin)_Crisp_Girl", label: "清脆少女" },
  { id: "Chinese (Mandarin)_Lyrical_Voice", label: "抒情男声" },
  { id: "female-chengshu", label: "成熟女性" },
];

/** 种子管理员没挑过时固定这一个（沉稳高管）：每个团队都有它，固定一个声音让「管理员」
    跨团队听得出来——同 ADMIN_AVATAR_SLOT 的理由。不进轮换池，别的智能体派不到它，也不进六档 */
export const ADMIN_VOICE_ID = "Chinese (Mandarin)_Reliable_Executive";

/** 能挑的一档：`key` 存进 `workspace_agents.voice`；`voiceId` 必须在 AGENT_VOICES 里——挑过的要在
    派生池里占位，派生的才让得开（测试钉着） */
export interface AgentVoiceChoice {
  key: string;
  label: string;
  hint: string;
  voiceId: string;
}

/** 六档（名字与描述照 #1321 的 demo）对到派生池里的哪一个：维护者 2026-09-27 定用默认对应——
    13 个候选各念同一句话量出来的（同一句 98–271 Hz、每秒 3.2–4.9 字）：「干脆」给最快的那个，
    「少年」给男声里最高的那个，「沉稳」给低音、且不抢管理员固定的那一个（spec §10 第 94 条） */
export const AGENT_VOICE_CHOICES: readonly AgentVoiceChoice[] = [
  { key: "qing", label: "清亮", hint: "语速偏快，句尾上扬", voiceId: "Chinese (Mandarin)_Warm_Bestie" },
  { key: "wen", label: "温和", hint: "慢一点，话尾收得稳", voiceId: "female-chengshu" },
  { key: "chen", label: "沉稳", hint: "低音多，适合长段汇报", voiceId: "Chinese (Mandarin)_Gentleman" },
  { key: "gan", label: "干脆", hint: "短句、不拖音", voiceId: "male-qn-jingying" },
  { key: "shao", label: "少年", hint: "偏亮偏年轻", voiceId: "male-qn-daxuesheng" },
  { key: "bo", label: "播音", hint: "字正腔圆，念数字清楚", voiceId: "Chinese (Mandarin)_Radio_Host" },
];

/** `workspace_agents.voice` 的形状（0042 的 CHECK 同一条）：小写字母 1–16 个 */
export const VOICE_KEY_RE = /^[a-z]{1,16}$/;

/** 键 → 那一档；null / 缺席 / 认不出（旧客户端读到新版才有的键）都回 null = 没挑过 */
export function voiceChoiceOf(key: string | null | undefined): AgentVoiceChoice | null {
  if (typeof key !== "string") return null;
  return AGENT_VOICE_CHOICES.find((c) => c.key === key) ?? null;
}

/** 名册里的一只：id + 它存下来的那一格（缺席 = 没挑过）。WorkspaceAgentRow 结构上就是它 */
export interface VoiceRosterEntry {
  agentId: string;
  voice?: string;
}

/** 名册：只有 id 的旧写法照收（= 谁都没挑过） */
export type VoiceRoster = readonly (string | VoiceRosterEntry)[];

const entryOf = (e: string | VoiceRosterEntry): VoiceRosterEntry => (typeof e === "string" ? { agentId: e } : e);

function preferredIndex(agentId: string): number {
  return fnv1a(agentId) % AGENT_VOICES.length;
}

/**
 * 整份名单 → agentId → 音色 id。先放挑过的（它们在池子里占位）；再按名单顺序派没挑过的：
 * 管理员固定，其余天然位空着就占，被占了顺着往后找第一个空位；全满（名单超过池子）退回天然位——
 * 重复不可避免时，至少每只自己还是稳定的。名单里重复出现的 id 只认第一次。
 */
export function agentVoiceIds(roster: VoiceRoster): Map<string, string> {
  const entries = roster.map(entryOf);
  const out = new Map<string, string>();
  const taken = new Set<number>();
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.agentId)) continue;
    seen.add(e.agentId);
    const choice = voiceChoiceOf(e.voice);
    if (choice === null) continue;
    out.set(e.agentId, choice.voiceId);
    const idx = AGENT_VOICES.findIndex((v) => v.id === choice.voiceId);
    if (idx >= 0) taken.add(idx);
  }
  for (const { agentId } of entries) {
    if (out.has(agentId)) continue;
    if (agentId === ADMIN_AGENT_ID) {
      out.set(agentId, ADMIN_VOICE_ID);
      continue;
    }
    let idx = preferredIndex(agentId);
    if (taken.size < AGENT_VOICES.length) {
      while (taken.has(idx)) idx = (idx + 1) % AGENT_VOICES.length;
    }
    taken.add(idx);
    out.set(agentId, AGENT_VOICES[idx]!.id);
  }
  return out;
}

/** 一只智能体的音色。不在名单里的 id（名单刚变过 / 旧日志里的智能体）也答得出：
    按它自己的天然位派，不解撞——这一刻没有名单可解 */
export function agentVoiceId(agentId: string, roster: VoiceRoster): string {
  const hit = agentVoiceIds(roster).get(agentId);
  if (hit !== undefined) return hit;
  if (agentId === ADMIN_AGENT_ID) return ADMIN_VOICE_ID;
  return AGENT_VOICES[preferredIndex(agentId)]!.id;
}
