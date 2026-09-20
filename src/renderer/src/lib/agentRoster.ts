// 花名册的纯逻辑（#1280，ADR-0297）。第三栏「智能体」画什么、按什么顺序、此刻进不
// 进得去，全在这里判；组件只管画。判据都挂在快照与云会话清单这两份**已经在手**的
// 数据上，不为画一行多打一次网络。

import { ADMIN_AGENT_ID } from "../../../shared/workspaceAgents.js";
import { isHomeWorkspace, type WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { WorkspaceAccess } from "./workspaceAccess.js";
import type { CloudSessionListRow } from "./workspaceView.js";

export function homeOf(groups: readonly WorkspaceSnapshot[]): WorkspaceSnapshot | null {
  return groups.find(isHomeWorkspace) ?? null;
}

/** 团队那一组。**`kind` 读不到（null）的留在这边**：读不到不许当成主场藏起来——
    那等于让一个团队凭空从侧栏消失，而这一列走的是容错查询（0037 没跑、网络抖一下
    都会读到 null）。最坏结果是主场暂时也列在团队里，那只是多出来一行，不是少一行 */
export function teamsOf(groups: readonly WorkspaceSnapshot[]): WorkspaceSnapshot[] {
  return groups.filter((g) => !isHomeWorkspace(g));
}

export interface AgentRosterRow {
  agentId: string;
  name: string;
  description: string;
  isAdmin: boolean;
  /** 和它的那条私聊。`null` = 还没聊过（点它只开开局卡，什么都不建） */
  sessionId: string | null;
  /** 那条私聊最后一次动的时间；没聊过 = 0（行上那格时间不画） */
  updatedTs: number;
}

/** 顺序 = 名册顺序（`workspace_agents` 按 created_at 升序，管理员恒在最上）。
    **不按最近活动排**：十来只智能体时固定顺序比「刚说话的顶上去」好找——这是通讯录，
    不是会话列表（维护者选的方向 A）。代价是「谁刚回过我」在这一栏上看不出来。 */
export function rosterRows(home: WorkspaceSnapshot, chats: readonly CloudSessionListRow[]): AgentRosterRow[] {
  // 名单恰好一只的私聊才算数：库里那条唯一索引已经保证了这件事，这里是第二道——
  // 一条名单里有两只的 "dm" 是脏数据，认了它会让两只智能体指向同一条线
  const dmOf = new Map(
    chats.filter((c) => c.chatKind === "dm" && c.agentIds.length === 1).map((c) => [c.agentIds[0]!, c]),
  );
  return home.agents.map((a) => {
    const dm = dmOf.get(a.agentId);
    return {
      agentId: a.agentId,
      name: a.name,
      description: a.description,
      isAdmin: a.agentId === ADMIN_AGENT_ID,
      sessionId: dm?.id ?? null,
      updatedTs: dm?.updatedTs ?? 0,
    };
  });
}

export interface GroupChatRow {
  sessionId: string;
  name: string;
  agentIds: string[];
  updatedTs: number;
}

/** 我拉起来的那几个群。按最近活动降序——群是会话不是通讯录，「哪个群刚有动静」
    正是这一段要回答的问题（与 `rosterRows` 的固定顺序故意相反） */
export function groupRows(home: WorkspaceSnapshot, chats: readonly CloudSessionListRow[]): GroupChatRow[] {
  const nameOf = new Map(home.agents.map((a) => [a.agentId, a.name]));
  return chats
    .filter((c) => c.chatKind === "group")
    .map((c) => {
      // 与现存智能体求交集（spec §4）：删一只智能体是三步、不原子，那一列里可能留着
      // 一个已经不存在的 id。**遍历的是名册不是那一列**，所以顺序也跟着名册走——
      // 同一个群在两台设备上不该因为那一列的写入顺序不同而显示两个名字
      const agentIds = home.agents.map((a) => a.agentId).filter((id) => c.agentIds.includes(id));
      return {
        sessionId: c.id,
        name: c.title.trim() !== "" ? c.title : agentIds.map((id) => nameOf.get(id)!).join("、"),
        agentIds,
        updatedTs: c.updatedTs,
      };
    })
    .sort((a, b) => b.updatedTs - a.updatedTs);
}

export type RosterGate =
  /** 还没问到 billing 快照：画骨架，**不劝订阅** */
  | "unknown"
  | "signed_out"
  | "no_subscription"
  | "plan_too_low"
  /** 档位带、主场还没有：这一栏自己去建，建的时候画骨架 */
  | "ensuring"
  /** 建失败：把原因说出来 + 一颗重试钮，**不自己反复重试** */
  | "failed"
  | "ready";

/** **有主场就进得去，不再看档位**：闸卡在「建」主场那一侧（同 ADR-0217：卡创建不卡
    参与），降了档的人不该突然看不见自己的智能体——他的那些聊天记录还在，只是建不了
    新的。这条与 `workspaceAccess` 的四态不是一回事，所以单独一层：那个答的是
    「能不能建」，这个答的是「这一栏此刻画什么」 */
export function rosterGate(o: {
  access: WorkspaceAccess;
  home: WorkspaceSnapshot | null;
  ensure: "idle" | "ensuring" | "failed";
}): RosterGate {
  if (o.home !== null) return "ready";
  if (o.access !== "allowed") return o.access;
  return o.ensure === "failed" ? "failed" : "ensuring";
}
