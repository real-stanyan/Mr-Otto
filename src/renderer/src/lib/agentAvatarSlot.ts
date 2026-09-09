// agentAvatarSlot —— 团队 agent 用哪张内置头像（#971）。纯逻辑零 IO，图片本身在
// lib/agentAvatar.ts 里 import，这里只算「第几张」。
//
// 为什么不给 workspace_agents 加一列：头像是纯展示，13 张内置像素头像够一个团队
// 用（每团队上限 32 只，ADR-0225；真到那个量级重复也无伤——头像是辅助辨认，
// 名字才是身份）。加列意味着一次要在 Supabase SQL editor 手动执行的 migration
// （0025 到现在还没跑完，#970）+ 建/改 agent 的表单多一格 + runtime 的 create_agent
// 多一个参数。派生比落库便宜一个量级，而且**存量 agent 立刻有头像**，不用等谁去设置页挑。
//
// 判据要稳：同一只 agent 在两台机器、两次刷新上必须长一张脸，否则头像反而添乱——
// 所以从 agent_id（改名不变的那个键，migration 0021 的设计意图）哈希，不从名字、
// 不从在名单里的下标（删掉一只，后面所有人换脸）。名单**顺序**只用来解撞：
// 服务端按 created_at 升序给，先来的先占坑，后来的撞上就往后挪一格。
// 代价写明：一只被删之后，曾经因为撞上它而挪过位的那只会挪回原坑（换一次脸）；
// 接受——只在撞过的那对之间发生，且删 agent 本来就是罕见操作。

import { ADMIN_AGENT_ID } from "../../../shared/workspaceAgents.js";

/** 内置头像张数。与 assets/agent-avatars/ 里的文件数一致，agentAvatar.ts 的
    数组长度由测试钉住 */
export const AGENT_AVATAR_COUNT = 13;

/** 种子管理员固定用这一张（0 起）：每个团队都有它，固定一张脸让「管理员」
    跨团队认得出来——它是唯一一只在所有团队都存在的 agent */
export const ADMIN_AVATAR_SLOT = 6;

/** FNV-1a 32 位。要的只是稳定 + 分布均匀，不需要密码学强度；
    不用 String.prototype.hashCode 那类——JS 没有内置的，各写各的迟早分家 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 一只 agent 的「天然」坑位：管理员固定，其余按 agent_id 哈希 */
function preferredSlot(agentId: string): number {
  if (agentId === ADMIN_AGENT_ID) return ADMIN_AVATAR_SLOT;
  return fnv1a(agentId) % AGENT_AVATAR_COUNT;
}

/**
 * 整份名单 → agentId → 坑位（0..AGENT_AVATAR_COUNT-1）。
 *
 * 按名单顺序分配：天然坑位空着就占；被占了就顺着往后找第一个空坑；
 * 全满（名单超过张数）就回到天然坑位——重复不可避免时，至少每只自己还是稳定的。
 * 名单里重复出现的 agentId 只算一次（同一只不能占两个坑）。
 */
export function agentAvatarSlots(roster: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const agentId of roster) {
    if (out.has(agentId)) continue;
    const want = preferredSlot(agentId);
    let slot = want;
    if (taken.size < AGENT_AVATAR_COUNT) {
      while (taken.has(slot)) slot = (slot + 1) % AGENT_AVATAR_COUNT;
    }
    out.set(agentId, slot);
    taken.add(slot);
  }
  return out;
}

/** 单只查询：不在名单里的（被删的 agent 在旧消息上还得有张脸）按天然坑位画——
    与名单里那只撞脸也无妨，它已经不在群里了 */
export function agentAvatarSlot(agentId: string, roster: readonly string[]): number {
  return agentAvatarSlots(roster).get(agentId) ?? preferredSlot(agentId);
}
