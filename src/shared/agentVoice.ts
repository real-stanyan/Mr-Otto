// agentVoice —— 团队 agent 用哪个 MiniMax 音色（#1163）。纯逻辑零 IO，三端共用。
//
// 派生不落库（维护者拍板：音色自动派生）。理由与头像那次（agentAvatarSlot.ts）一样：
// 加列意味着一次要手动跑的 migration + 建/改 agent 的表单多一格 + runtime 的
// create_agent 多一个参数，而派生让**存量 agent 立刻有声音**。哪天要让人自己挑
// （像 #1007 给头像加的 avatar_slot），加一列可空、null 照旧派生，这里的函数不用动。
//
// 判据要稳：群语音里靠声音分人，同一只 agent 在两台机器、两次刷新上必须是同一个
// 声音——所以从 agent_id（改名不变的键）哈希，不从名字、不从名单下标。名单**顺序**
// 只用来解撞（服务端按 created_at 升序给，先来的先占，后来的撞上就往后挪一格）。
// 代价同头像：一只被删之后，曾因撞它挪位的那只会挪回原位（换一次声音）；接受。
//
// 音色表是人手维护的、会过时（MiniMax `get_voice` 接口现查得到全部 303 个系统音色，
// 2026-09-09 取的这十二个都是标准普通话、男女交错、语气各异）。id 写错的后果是
// MiniMax 回非零 status_code → 网关 502 → 通话栏一行红字，不会静默变成别的声音。

import { ADMIN_AGENT_ID } from "./workspaceAgents.js";
import { fnv1a } from "./fnv1a.js";

export interface AgentVoice {
  /** MiniMax 系统音色 id（`voice_setting.voice_id`） */
  id: string;
  /** 官方中文名，给将来的选择器画 */
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

/** 种子管理员固定这一个（沉稳高管）：每个团队都有它，固定一个声音让「管理员」
    跨团队听得出来——同 ADMIN_AVATAR_SLOT 的理由。不进轮换池，别的 agent 派不到它 */
export const ADMIN_VOICE_ID = "Chinese (Mandarin)_Reliable_Executive";

function preferredIndex(agentId: string): number {
  return fnv1a(agentId) % AGENT_VOICES.length;
}

/**
 * 整份名单 → agentId → 音色 id。算法逐字照 agentAvatarSlots：天然位空着就占，
 * 被占了顺着往后找第一个空位；全满（名单超过池子）退回天然位——重复不可避免时，
 * 至少每只自己还是稳定的。名单里重复出现的 id 只算一次。
 */
export function agentVoiceIds(roster: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<number>();
  for (const agentId of roster) {
    if (out.has(agentId)) continue;
    if (agentId === ADMIN_AGENT_ID) {
      out.set(agentId, ADMIN_VOICE_ID);
      continue;
    }
    const want = preferredIndex(agentId);
    let idx = want;
    if (taken.size < AGENT_VOICES.length) {
      while (taken.has(idx)) idx = (idx + 1) % AGENT_VOICES.length;
    }
    taken.add(idx);
    out.set(agentId, AGENT_VOICES[idx]!.id);
  }
  return out;
}

/** 一只 agent 的音色。不在名单里的 id（名单刚变过 / 旧日志里的 agent）也答得出：
    按它自己的天然位派，不解撞——这一刻没有名单可解 */
export function agentVoiceId(agentId: string, roster: readonly string[]): string {
  const hit = agentVoiceIds(roster).get(agentId);
  if (hit !== undefined) return hit;
  if (agentId === ADMIN_AGENT_ID) return ADMIN_VOICE_ID;
  return AGENT_VOICES[preferredIndex(agentId)]!.id;
}
