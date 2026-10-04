// 共有的智能体（#1545）：名片接受出来的那只与原来那只是两只（ADR-0354：复制定义），但两个人都要看得出「这只我们俩都有」。
// 事实在 0059 的 agent_shares 表里（接受方在接受那一刻写一行：分享方 + 原 id + 接受方 + 新 id + 名字快照），两边都读得到自己参与的行。
// 这里是纯逻辑：行怎么认、某一只在我屏幕上该标什么。
export interface AgentShare {
  ownerUid: string;
  agentId: string;
  withUid: string;
  copyAgentId: string;
  name: string;
}

export function parseAgentShareRow(raw: unknown): AgentShare | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.owner_uid !== "string" || typeof r.agent_id !== "string" || typeof r.with_uid !== "string" || typeof r.copy_agent_id !== "string") return null;
  return { ownerUid: r.owner_uid, agentId: r.agent_id, withUid: r.with_uid, copyAgentId: r.copy_agent_id, name: typeof r.name === "string" ? r.name : "" };
}

/** 这只在**我**的名册里该标什么：
    · 我是接受方、这只是复制出来的那只 → 「共有 · 来自 X」；
    · 我是分享方、这只被几位朋友接受过 → 「共有 · X 也有一只」/「共有 · X、Y 也有一只」；
    · 都不是 → null（不标）。`nameOf` 把 uid 翻成名字（查不到给 uid 前 8 位） */
export function agentShareBadge(
  agentId: string,
  shares: readonly AgentShare[],
  selfUid: string,
  nameOf: (uid: string) => string,
): string | null {
  const from = shares.find((s) => s.withUid === selfUid && s.copyAgentId === agentId);
  if (from !== undefined) return `共有 · 来自 ${nameOf(from.ownerUid)}`;
  const withs = shares.filter((s) => s.ownerUid === selfUid && s.agentId === agentId).map((s) => nameOf(s.withUid));
  if (withs.length === 0) return null;
  const shown = withs.slice(0, 3).join("、");
  return `共有 · ${shown}${withs.length > 3 ? ` 等 ${withs.length} 人` : ""}也有一只`;
}

/** 接受名片之后往这条私聊里发的那句（分享方那边据此知道「TA 接受了」，不用另开 RPC） */
export function acceptedShareText(agentName: string): string {
  return `我接受了你分享的智能体「${agentName}」，现在我们俩都有这只。`;
}
