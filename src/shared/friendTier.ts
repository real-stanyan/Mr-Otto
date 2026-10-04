// 好友三档权限（#1494，ADR-0350）：仅聊天 / 可带智能体 / 全部开放。**每人一边、生效取两边的最小值**（维护者拍板）：
// 我给 TA 开到哪一档、TA 给我开到哪一档各管各的，关系上真正生效的是低的那一档——谁都没法单方面让对方的智能体来找自己。
//
// 落在 friendships 的两列 `requester_tier` / `addressee_tier`（0054）：哪一列是「我给 TA 的」取决于这一行里我是请求方
// 还是被请求方（tiersOf）。老行（0054 之前已接受的）两列默认 'agents'（第 2 档），不打断已经在用私密车道 / 来电的人；
// 新请求的发起方默认选 'chat'，接受方接受时选自己那一边。
//
// 三道闸都读 effectiveTier：带智能体进私聊（runtime 的 pairCreateProblem，≥ agents）、对方智能体直接发消息 / 打电话
// （runtime 的 outreachHub，= full）、手机端藏入口只是体验。纯文件，手机端直接 import。
export type FriendTier = "chat" | "agents" | "full";

export const FRIEND_TIERS: readonly FriendTier[] = ["chat", "agents", "full"];
const RANK: Record<FriendTier, number> = { chat: 0, agents: 1, full: 2 };

/** 0054 之前的老行、以及老客户端插进来的新行，都按这一档算 */
export const DEFAULT_TIER: FriendTier = "agents";
/** 新客户端发请求时选档的默认值 */
export const REQUEST_DEFAULT_TIER: FriendTier = "chat";

export const TIER_LABEL: Record<FriendTier, string> = { chat: "仅聊天", agents: "可带智能体", full: "全部开放" };
export const TIER_DESC: Record<FriendTier, string> = {
  chat: "只能你们俩聊天，双方都不能把智能体带进这条私聊。",
  agents: "可以把各自的智能体带进私聊（只有带的人看得到它说什么）。",
  full: "对方的智能体可以直接给你发消息、打电话。",
};

export function isFriendTier(v: unknown): v is FriendTier {
  return v === "chat" || v === "agents" || v === "full";
}

export function normalizeTier(v: unknown, fallback: FriendTier = DEFAULT_TIER): FriendTier {
  return isFriendTier(v) ? v : fallback;
}

/** 两边取低的那一档 */
export function effectiveTier(mine: FriendTier, theirs: FriendTier): FriendTier {
  return RANK[mine] <= RANK[theirs] ? mine : theirs;
}

export function allowsPair(t: FriendTier): boolean {
  return RANK[t] >= RANK.agents;
}

export function allowsOutreach(t: FriendTier): boolean {
  return t === "full";
}

export interface FriendTierRow {
  requester: string;
  addressee: string;
  requester_tier?: unknown;
  addressee_tier?: unknown;
}

/** 一行 friendships 从「我」看：我给 TA 的、TA 给我的、生效的 */
export function tiersOf(row: FriendTierRow, me: string): { mine: FriendTier; theirs: FriendTier; effective: FriendTier } {
  const req = normalizeTier(row.requester_tier);
  const add = normalizeTier(row.addressee_tier);
  const mine = row.requester === me ? req : add;
  const theirs = row.requester === me ? add : req;
  return { mine, theirs, effective: effectiveTier(mine, theirs) };
}

/** 这一行里「我给 TA 的」是哪一列 */
export function myTierColumn(row: { requester: string }, me: string): "requester_tier" | "addressee_tier" {
  return row.requester === me ? "requester_tier" : "addressee_tier";
}

/** 带智能体进私聊被档位拦下时说给人听的那句（null = 不拦） */
export function pairTierProblem(effective: FriendTier): string | null {
  if (allowsPair(effective)) return null;
  return "你们的好友权限是「仅聊天」，带不了智能体。去 TA 的资料页把你给 TA 的权限开到「可带智能体」，也要 TA 给你开到那一档。";
}

/** 智能体要直接打给这位朋友、被档位拦下时说给模型听的那句（null = 不拦） */
export function outreachTierProblem(effective: FriendTier, peerName: string): string | null {
  if (allowsOutreach(effective)) return null;
  return `${peerName} 没有把好友权限开到「全部开放」，智能体不能直接给 ${peerName} 打电话或发消息。告诉他可以在 ${peerName} 的资料页里改，也要 ${peerName} 那边给他开到同一档。`;
}
