// 好友私聊里双方公开的智能体互相说话（#1542，ADR-0358）：A 的智能体从 A 主场的共享车道里，经 runtime 把一句话落进
// B 主场里公开给 A 的那条车道（以 A——那条车道的客人——的身份 `say`，点 B 的那只）；B 的那只要回话就走同一条路回来。
// 两条车道都画在同一页私聊里，两个人都看得到两边的每一句。
//
// 这是 AGENTS.md 开篇「不做通用多 agent 编排」之下开的第二条窄口（第一条是工作区群聊里的接力，ADR-0223）。
// 口子窄在：① 只在两边都公开的车道之间；② 每一棒都是日志里一条带 `relay` 的 user_message，深度跨车道累加、到顶硬停
// （与接力同一个数）；③ 每对车道每小时封顶；④ 对面那一轮是客人点起的——动手要对面的主人批（ADR-0325 第 7 条），
// 这把刀本身只说话、不动任何人的东西。
// 这个文件是纯逻辑（工具叫什么、说话人怎么标、谁收、封顶怎么算）；找车道、落话在 runtime 的 laneBridge.ts。

export const MESSAGE_FRIEND_AGENT_TOOL_NAME = "message_friend_agent";
/** 一句话的上限：这是对话不是文档 */
export const BRIDGE_TEXT_MAX = 2000;
/** 每对车道（A→B 一个方向算一对）每小时最多几棒 */
export const BRIDGE_PER_HOUR_MAX = 30;
export const BRIDGE_WINDOW_MS = 60 * 60_000;

/** 落进对面车道时的说话人标签：「X（A 的智能体）」——对面的智能体与两个人都要一眼看出这不是人说的 */
export function bridgeSpeakerLabel(agentName: string, ownerName: string): string {
  return `${agentName.trim() === "" ? "智能体" : agentName.trim()}（${ownerName.trim() === "" ? "朋友" : ownerName.trim()} 的智能体）`;
}

/** 滑动窗口里还剩多少棒：`sent` 是这一对最近几次的时间戳（调用方持有、剪过旧的） */
export function bridgeWindowAllows(sent: readonly number[], now: number, max: number = BRIDGE_PER_HOUR_MAX): boolean {
  return sent.filter((t) => now - t < BRIDGE_WINDOW_MS).length < max;
}
export function pruneBridgeWindow(sent: readonly number[], now: number): number[] {
  return sent.filter((t) => now - t < BRIDGE_WINDOW_MS);
}

export type BridgeTarget =
  | { kind: "one"; agentId: string; name: string }
  | { kind: "none"; names: string[] }
  | { kind: "many"; count: number };

/** 对面车道里点谁：给了名字按名字（精确）；没给、而对面只有一只就是它；没给、有好几只 → many（让模型说名字） */
export function resolveBridgeTarget(roster: readonly { agentId: string; name: string }[], wanted: string | undefined): BridgeTarget {
  if (roster.length === 0) return { kind: "none", names: [] };
  const w = (wanted ?? "").trim();
  if (w === "") return roster.length === 1 ? { kind: "one", agentId: roster[0]!.agentId, name: roster[0]!.name } : { kind: "many", count: roster.length };
  const hits = roster.filter((a) => a.name.trim() === w || a.agentId === w);
  if (hits.length === 1) return { kind: "one", agentId: hits[0]!.agentId, name: hits[0]!.name };
  if (hits.length > 1) return { kind: "many", count: hits.length };
  return { kind: "none", names: roster.map((a) => a.name) };
}

/** 发出去之后回给模型的那句话（它要据此告诉主人发生了什么） */
export function bridgeSentText(targetName: string, peerName: string): string {
  return `已经把这句话发给 ${peerName} 的智能体「${targetName}」了。它要是回话，会出现在这条私聊里（你们俩都看得到）。先回主人一句，别等。`;
}
