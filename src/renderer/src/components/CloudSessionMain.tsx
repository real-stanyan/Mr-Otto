// CloudSessionMain —— 云会话在主区的那一屏（issue #919）。
//
// 之前云会话开在右侧抽屉里（WorkspacePage 内切换渲染）。搬进主区是「和本地会话
// 一致」的另一半：本地会话点侧栏一行就在主区打开，云会话既然也列在侧栏里，就该
// 落在同一块地皮上。离开的方式也因此一致——点侧栏里别的一行（newSession/resume
// 都会先 closeCloudSession），不再有一颗返回键。
//
// 这一层只做三件事：把团队快照喂给 CloudSessionPage、补发开局卡上那句话、
// 在快照还没到时说一句人话。滚动归 CloudSessionPage 自己管（#987：时间线滚、
// 输入框钉底），这里只负责把高度交下去。

import { useEffect } from "react";
import { parseMemberMentions } from "../../../shared/remote/agentMention.js";
import { useChat } from "../store.js";
import { CloudSessionPage } from "./CloudSessionPage.js";
import type { ChatView } from "./AgentChatHeader.js";
import { agentNameOf } from "../lib/workspaceView.js";

export function CloudSessionMain({ onManage }: { onManage: (workspaceId: string) => void }) {
  const cs = useChat((s) => s.cloudSession);
  const ws = useChat((s) => s.workspaceGroups.find((g) => g.id === s.cloudSession?.workspaceId) ?? null);
  const selfUid = useChat((s) => s.account.id);
  const pending = useChat((s) => s.cloudPendingFirstMessage);
  const take = useChat((s) => s.takeCloudPendingFirstMessage);
  const seedDraft = useChat((s) => s.seedCloudDraft);
  const cloudSay = useChat((s) => s.cloudSay);
  const refreshGroups = useChat((s) => s.refreshWorkspaceGroups);
  const openAgentSettings = useChat((s) => s.openAgentSettings);
  const openNewGroup = useChat((s) => s.openNewGroup);
  const openGroupSettings = useChat((s) => s.openGroupSettings);
  const updateGroupChat = useChat((s) => s.updateGroupChat);
  // 群名在清单那一行上（title），不在 welcome 里——welcome 只说 kind 与名单
  const chatTitle = useChat((s) =>
    s.cloudSession
      ? s.cloudSessionList[s.cloudSession.workspaceId]?.find((r) => r.id === s.cloudSession?.sessionId)?.title ?? ""
      : ""
  );

  const state = cs?.state ?? null;
  const sessionId = cs?.sessionId ?? null;

  // 进云会话时刷一次快照：agent 名单是别的成员也能改的，而 workspaceGroups
  // 没有推送通道（只在本地改动后重拉）——不刷的话别人新建的那只 @ 不到
  useEffect(() => {
    if (cs?.sessionId) void refreshGroups();
  }, [cs?.sessionId, refreshGroups]);
  // 开局卡上写的那句话，等到连接 ready 才发得出去（主进程的 say() 要求
  // status === "ready"，见 cloudSessionClient 的 requireReady）。
  // **先取后发**：这个 effect 会因为状态变化重跑，take() 把它从 store 里摘掉
  // 之后再 await，才不会发两遍
  //
  // **发失败不吞掉原文**（issue #957 C-I6）：cloudSay 失败时把原文交回给
  // CloudSessionPage（seedCloudDraft → 它挂载时取走）。开局卡这时早已卸载，
  // 不交回去那段文字在任何地方都不再存在——用户只看到一行错误，然后得重打一遍。
  // **两种失败去处不同**（第四批 C2-I4）：确定没发出去（`unsent`）摆回输入框，
  // 从此归 composer 那条既有纪律管（「草稿在发送成功之后才清」）；没收到回执
  // （`unknown`，15s ACK 超时或连接没了）**不能**摆回输入框——输入框里躺着原文
  // 就是「再发一次」这个指令的最强信号，而这句话很可能已经落地了，重发就是
  // 发两遍。那一份走 CloudSessionPage 上方那行带「重新发送」的提示，由人决定。
  // 这块种草稿的兜底与 `say_result` 回执**并存**：回执帧本身也可能在传输中丢，
  // 而那时唯一还剩的救济就是这里（同 ADR-0227 已知代价里"第二批兜底原样保留"）
  useEffect(() => {
    if (pending === null || state !== "ready" || sessionId === null) return;
    const text = take();
    if (text === null) return;
    // 开局卡上写的 @ 也要通知到人（#1064）：这一屏没有选人弹层，但正文里的
    // `@小红` 与 composer 里那一句是同一件事——只在 composer 那一条路上通知，
    // 就是同一个动作按入口不同给两种结果。撞名归 agent 的判据与那边同一份
    // （parseMemberMentions）。`ws` 还没到 = 两份名单都空 = 谁都不通知，
    // 与改动前一样
    const memberMentions = ws
      ? parseMemberMentions(
          text,
          ws.agents.map((a) => ({ agentId: a.agentId, name: a.name })),
          ws.members.map((m) => ({ agentId: m.uid, name: m.label }))
        )
      : [];
    void (async () => {
      // 开局卡那句不 @ 也由名单第一只接（老语义：mentions 缺席）
      const r = await cloudSay(text, undefined, memberMentions);
      if (!r.ok) seedDraft(sessionId, text, r.unknown ? "unknown" : "unsent");
    })();
  }, [pending, state, sessionId, take, cloudSay, seedDraft, ws]);

  if (cs === null) return null;
  if (ws === null) {
    // 团队快照还没拉回来（冷启动时序）——不画半张空页，也不假装出错
    return (
      <div className="flex-1 min-w-0 h-full flex items-center justify-center text-[13px] text-muted-foreground">
        正在读取团队…
      </div>
    );
  }

  // 这一页画的是不是一条聊天（#1280）。名单与现存名册求交集——删一只智能体是三步、
  // 不原子，那一列里可能留着一个已经不存在的 id（同 groupRows 的兜底）。
  // 私聊的标题取那只的名字（清单那一行的 title 恒空），群聊取群名，没起名时用成员名
  const chat: ChatView | undefined = (() => {
    if (cs.chat === null) return undefined;
    const agentIds = ws.agents.map((a) => a.agentId).filter((id) => cs.chat!.agentIds.includes(id));
    const names = agentIds.map((id) => agentNameOf(ws, id));
    if (cs.chat.kind === "dm") {
      // 名单里那只被删掉了：退回团队会话的画法，不画一张没有主人的脸
      if (agentIds[0] === undefined) return undefined;
      return { kind: "dm", agentIds, title: names[0]! };
    }
    return { kind: "group", agentIds, title: chatTitle.trim() !== "" ? chatTitle : names.join("、") };
  })();

  return (
    // 这一层**不滚**（#987）：滚动区在 CloudSessionPage 里面、只包时间线，输入框钉在
    // 它下面——同本地会话（OttoThread 的 viewport 滚，App.tsx 的 footer 不动）。
    // 这里只把高度交下去（h-full + flex 列 + min-h-0，缺一个内层就撑不出滚动条）
    <div className="flex-1 min-w-0 h-full min-h-0 flex flex-col">
      {/* 占满整块主区（#993 第 2 条）：本地会话的 aui viewport 是
          `max-w-(--thread-max-width) px-4`，而那个变量本仓从没定义过 = 无上限，
          所以本地看到的就是「占满 + 左右 16px」。云会话原来那条
          `w-[min(760px,92%)]` 居中量尺在宽屏上左右各留一大条空白，与本地不一样。
          内边距归 CloudSessionPage 自己管（头部/时间线/footer 各自 px-4，头部那条
          border-b 才画得满）。不传 onBack —— 出口是侧栏，同本地会话 */}
      <div className="flex-1 min-h-0 flex flex-col">
        <CloudSessionPage
          ws={ws}
          selfUid={selfUid}
          onSettings={() => onManage(ws.id)}
          onAgentSettings={openAgentSettings}
          {...(chat === undefined ? {} : { chat })}
          {...(chat?.kind === "dm" && chat.agentIds[0] !== undefined
            // 「拉人」**不改这条私聊**，是带着这一只另起一个群（微信同款）：私聊的
            // 名单是库里那条唯一索引钉死的一只，改得了的话它就不再是「和它的那条线」
            ? { onPullAgent: () => openNewGroup([chat.agentIds[0]!]) }
            : {})}
          {...(chat?.kind === "group" && sessionId !== null
            ? {
                onChatRoster: async (agentIds: string[]) => { await updateGroupChat(sessionId, { agentIds }); },
                onGroupSettings: () => openGroupSettings(sessionId),
              }
            : {})}
        />
      </div>
    </div>
  );
}
