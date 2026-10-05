// 代办（#1563 / #1564，ADR-0363）：好友私聊里对方不在、忙着的时候，TA 的请求先到主人的**管理员**，
// 再由管理员下发给主人指定的代办智能体——朋友那一侧只认管理员这一个入口。
// 这里是纯逻辑：公开车道的名单长什么样、客人点的名怎么改、两种身份在车道里各加哪一段提示词。
import { ADMIN_AGENT_ID } from "./workspaceAgents.js";
import { promptSafe } from "./promptSafe.js";
import { collabRolePrompt } from "./collab.js";

/** 公开出去的车道名单：管理员永远在、排第一；主人选的公开智能体（代办目标）与原名单跟在后面，去重 */
export function delegationRoster(agentIds: readonly string[], publicAgentId?: string | null): string[] {
  const rest = [...new Set([...(publicAgentId ? [publicAgentId] : []), ...agentIds])].filter((id) => id !== ADMIN_AGENT_ID);
  return [ADMIN_AGENT_ID, ...rest];
}

/** 客人在公开车道里点的名：名单里有管理员就一律改成管理员（朋友的请求先到它，再由它下发）；
    没有管理员（老车道，还没补进来）原样——不能让朋友一句话都发不出去 */
export function guestTargetsInLane(targets: readonly string[], rosterIds: readonly string[]): string[] {
  if (targets.length === 0) return [];
  return rosterIds.includes(ADMIN_AGENT_ID) ? [ADMIN_AGENT_ID] : [...targets];
}

/** 公开车道里按身份加的那一段：管理员 = 代办入口（接住、问清、下发、记下等主人）；别的智能体 = 等管理员下发才动 */
export function delegationRolePrompt(o: {
  isAdmin: boolean;
  ownerName: string;
  peerName: string;
  /** 车道此刻的名单（含管理员自己，这里会剔掉） */
  others: readonly { agentId: string; name: string }[];
}): string {
  const w = promptSafe(o.ownerName);
  const p = promptSafe(o.peerName);
  if (!o.isAdmin) {
    return `\n[代办：${p} 的请求一律先到 ${w} 的管理员，管理员 @ 你下发的事才轮到你做；${p} 直接对你说的话别接，交给管理员。]\n`;
  }
  const names = o.others.filter((a) => a.agentId !== ADMIN_AGENT_ID).map((a) => promptSafe(a.name));
  const hand = names.length > 0
    ? `${w} 指定的代办智能体：${names.join("、")}。要动手的事在回复里 @ 它的名字交给它，说清要办什么、什么时候要；`
    : `${w} 没有指定别的代办智能体，`;
  return (
    `\n[代办：你是 ${w} 的管理员，${p} 找 ${w} 找不到时先找你。${p} 的请求你先接住：问清要办什么、什么时候要，答得了的直接答。` +
    // #1620 真机：主人「@雨姐 你说对吗」是让它插一句话，它却当成交办开了张代办卡
    `被 @ 时先分清是**聊天**还是**交办**：「你说对吗」「你怎么看」「帮腔一下」这种是让你插话——读上面的私聊记录，像群里的一个人那样直接接一两句，不问要办什么、不派活、不记代办；真要办事的才派活 / 记下来。` +
    `${hand}办不了、要 ${w} 拍板的记下来，等 ${w} 回来总结给他。别替 ${w} 答应任何事。` +
    // 真机 2026-10-05（#1614）：客人说「告诉他早点吃饭」，管理员追问两遍「他是谁」还嫌客人「说人话」
    `${p} 嘴里的「他 / 她 / 你主人 / 他本人」默认就是 ${w}，别追问；${p} 是客，没听懂就客气地问一句，不许说「说人话」这类话。]\n` +
    // 跨主场协作（#1578）：谁牵头、怎么邀对方的管理员、收到对方的邀请时怎么答
    collabRolePrompt(o.ownerName, o.peerName)
  );
}
