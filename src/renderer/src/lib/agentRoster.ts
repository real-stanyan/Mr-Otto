// 花名册的纯逻辑（#1280，ADR-0297）。第三栏「智能体」画什么、按什么顺序、此刻进不
// 进得去，全在这里判；组件只管画。判据都挂在快照与云会话清单这两份**已经在手**的
// 数据上，不为画一行多打一次网络。

import { chatRosterNow, narrowRoster } from "../../../shared/chatRoster.js";
import type { SessionEvent } from "../../../session/events.js";
import type { CsChatInfo, CsChatSpec } from "../../../shared/remote/cloudSession.js";
import { ADMIN_AGENT_ID } from "../../../shared/workspaceAgents.js";
import { isHomeWorkspace, type WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { ChatView } from "../components/AgentChatHeader.js";
import type { WorkspaceAccess } from "./workspaceAccess.js";
import { agentNameOf, type CloudSessionListRow } from "./workspaceView.js";

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

/** 打开一条云会话时先给 `cloudSession.chat` 种下去的那一格（#1301）。

    这一格是**三态**（同 `CloudSessionState.chat`）：`undefined` = 还不知道 /
    `null` = 团队会话 / 值 = 一条聊天。种子存在的全部理由是：权威那份只随 `welcome`
    到达，真机上那是**十秒以上**的窗口，而在它到之前 `null` 被读成「团队会话」，
    于是主场里的聊天头几秒画的是团队壳——露出一颗点了不生效的「免审批」开关
    （ADR-0298：主场一次都不查那一列），也就是 #722 那颗撒谎的勾。

    三条判据：

    - **正在建的那一条按我们自己递的 spec 算**（`sessionId === null`）：那不是一次读，
      是我们刚刚要求的东西；spec 缺席 = 我们要的就是一条团队会话。
    - **已有的那一条查清单行**（`workspace_sessions.chat_kind / agent_ids` 的投影，
      ADR-0297 明写它就是给「没开着这条聊天」的桌面看的）。
    - **清单里没有这一行 = `undefined`**，不猜成团队会话——那正是这条 bug 的形状。

    `chatKind === null` 在这里当团队会话用是安全的，虽然那一格同时也是「这两列读不到」
    （`fetchCloudChats` 容错回空 Map）：读不到时整份 map 是空的，于是 `rosterRows` 的
    私聊全成「没聊过」、`groupRows` 一个群都不列——**一条聊天都点不进来**，走不到这里。

    名单只当种子用，welcome 一到就换人，之后由日志接管（`chatViewOf`）：这一列是投影、
    可能比日志旧（runtime 写库失败时不回滚、等启动对账）。 */
export function chatSeedOf(o: {
  /** 正在建的那一条要的是什么；`undefined` = 不是在建，或者建的是团队会话 */
  spec: CsChatSpec | undefined;
  /** `null` = 正在建一条新的 */
  sessionId: string | null;
  chats: readonly CloudSessionListRow[];
}): CsChatInfo | null | undefined {
  if (o.sessionId === null) {
    if (o.spec === undefined) return null;
    return o.spec.kind === "dm"
      ? { kind: "dm", agentIds: [o.spec.agentId] }
      : { kind: "group", agentIds: [...o.spec.agentIds] };
  }
  const row = o.chats.find((c) => c.id === o.sessionId);
  if (row === undefined) return undefined;
  return row.chatKind === null ? null : { kind: row.chatKind, agentIds: [...row.agentIds] };
}

/** 头部那一行画什么（#1302）。`null` = 退回团队壳（私聊里那只已经被删了，
    不画一张没有主人的脸——同改动前）。

    **名单从日志推导**（`chatRosterNow`），不从 `cs.chat.agentIds` 那份 welcome 快照：
    硬规则写着「任何投影必须可从日志推导」，而名单正是日志事实（`chat_roster_changed`），
    桌面也**已经收到**那条事件——时间线上「你把「客服」移出了群聊」那一行就是从它画的，
    只是头部没去读它。照快照画的后果是改完名单头部还是旧名单，而「添加智能体」会按不动
    并说一句假话（「名册里的智能体都在群里了」——名册里明明有一只不在），于是移出去的
    那一只**加不回来**，除非离开这条聊天再进来。

    群名仍从清单那一行来（`groupTitle`）：群名不是日志事实，改名走的是库。头部这一行
    因此有两个来源——**这正是 #1302 的形状**（新标题配旧名单），所以名单那一半必须跟着
    最新的那份事实走，不能两半各自陈旧一半。 */
export function chatViewOf(
  ws: WorkspaceSnapshot,
  chat: CsChatInfo,
  events: readonly SessionEvent[],
  groupTitle: string,
): ChatView | null {
  // 与现存名册求交集：删一只智能体是三步、不原子，名单里可能留着一个不存在的 id
  // （同 groupRows 的兜底）。顺序跟名册走，不跟名单里的写入顺序走
  const agentIds = narrowRoster(ws.agents, chatRosterNow(events, chat.agentIds)).map((a) => a.agentId);
  const names = agentIds.map((id) => agentNameOf(ws, id));
  if (chat.kind === "dm") {
    if (agentIds[0] === undefined) return null;
    return { kind: "dm", agentIds, title: names[0]! };
  }
  return { kind: "group", agentIds, title: groupTitle.trim() !== "" ? groupTitle : names.join("、") };
}
