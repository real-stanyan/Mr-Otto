// WorkspacePage —— 团队详情页。**七格从分段控件换成推入式导航**（#1120）。
//
// 页而不是弹窗（照 McpConnectorPage 的换页惯例，ADR-0185）：几张表加起来随时超过一屏，
// 弹窗只会滚动条套滚动条。
//
// ## 为什么不再是七个 tab
//
// 抽屉宽 `w-[min(420px,92vw)]`（`App.tsx`），里面原来塞着七个 `TabsTrigger`：真机上
// 「智能体」「连接器」已经挤到快认不出，再加一格就得开始截断。换成目录 + 推入页之后：
// 每一格有多宽由它自己说了算、目录那层能给每行写一句「里面有什么」（tab 只有两个字）、
// 二级页有完整一屏，于是那几个原来必须开弹窗的编辑器可以直接摊开。代价是换一格从一次
// 点击变成两次——设置面是低频、且人来这儿通常只为改一件事，这个代价换上面三条划算；
// 哪天这一页变成每天要在几格之间来回跳的东西，这个判断就该重判。
//
// ## 「解散团队」从页头搬到最底下
//
// 原来它是页头右上角一颗红色实心按钮——**整页视觉上最响的元素，是最危险、最少用的
// 那一个**。搬进最后一组、红字、单独一行，二次确认照旧。
//
// 那句二次确认 #1127 已经从原生 `confirm()` 换成 `useConfirm()`（`ui/confirm-dialog`）：
// 本文件原来写着「不新造一套 AlertDialog 视觉语言」，而那套语言早就在仓库里
// （三个登录弹窗在用），保留原生的代价才是真的——系统脸、英文按钮、问题与后果挤成
// 一块文字。
//
// 没有推送通道（workspaceList 无 onChanged）：每次改动成功后 store 那十一个 action 都会
// 自己重拉一次整份快照，这一页只管拿最新的 ws 传进来的那份画，不自己维护本地缓存。

import type { ReactNode } from "react";
import { ArrowLeft, Bot, FolderOpen, Gauge, MessagesSquare, Plug, Sparkles, Users } from "lucide-react";
import { InsetGroup, InsetIcon, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { NavStack, useNav, type NavScreen } from "@/components/ui/nav-stack.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { useChat } from "../store.js";
import { WorkspaceAgentsTab } from "./WorkspaceAgentsTab.js";
import { WorkspaceUsageTab } from "./WorkspaceUsageTab.js";
import { WorkspaceFilesTab } from "./WorkspaceFilesTab.js";
import { WorkspaceWikiTab } from "./WorkspaceWikiTab.js";
import { WorkspaceSessionsTab } from "./WorkspaceSessionsTab.js";
import { WorkspaceConnectorsTab } from "./WorkspaceConnectorsTab.js";
import { WorkspaceMembersTab } from "./WorkspaceMembersTab.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

interface Section {
  id: string;
  label: string;
  icon: ReactNode;
  /** 目录行上那句「里面有什么」。**只从已经在手的 `ws` 推**——为了给目录写一个数就
      多打一次网络，等于让「打开抽屉」这个动作变贵；而这句话的活是「让人知道该点哪一格」，
      不是报数。顺带它也堵掉「同一个事实两份写法」那一类洞（#1120 那次漏的正是这个）。 */
  hint: (ws: WorkspaceSnapshot) => string;
  render: (ws: WorkspaceSnapshot, selfUid: string) => ReactNode;
}

const SECTIONS: readonly Section[] = [
  {
    id: "sessions", label: "会话", icon: <MessagesSquare />,
    hint: (ws) => (ws.sessions.length > 0 ? `云会话 · ${ws.sessions.length} 条已发布` : "这个团队里的会话"),
    render: (ws, selfUid) => <WorkspaceSessionsTab ws={ws} selfUid={selfUid} />,
  },
  {
    id: "agents", label: "智能体", icon: <Bot />,
    // 智能体排在会话之后、连接器之前——它是用得最多的一页，连接器/成员是配一次的东西
    hint: (ws) => (ws.agents.length > 0 ? ws.agents.map((a) => a.name).slice(0, 3).join("、") : "群里 @ 得着的那几只"),
    render: (ws, selfUid) => <WorkspaceAgentsTab ws={ws} selfUid={selfUid} />,
  },
  {
    id: "files", label: "文件", icon: <FolderOpen />,
    // 「文件」不叫「仓库」：主语是「水獭在哪儿干活」，Git 只是往里装东西的一种方式（ADR-0251）
    hint: () => "智能体干活的那个共用文件夹",
    render: (ws) => <WorkspaceFilesTab key={ws.id} ws={ws} />,
  },
  {
    id: "connectors", label: "连接器", icon: <Plug />,
    hint: (ws) => (ws.connectors.length > 0 ? `${ws.connectors.length} 台 MCP 服务` : "还没有人贡献"),
    render: (ws, selfUid) => <WorkspaceConnectorsTab ws={ws} selfUid={selfUid} />,
  },
  {
    id: "members", label: "成员", icon: <Users />,
    hint: (ws) => `${ws.members.length} 人`,
    render: (ws, selfUid) => <WorkspaceMembersTab ws={ws} selfUid={selfUid} />,
  },
  {
    id: "usage", label: "用量", icon: <Gauge />,
    hint: () => "各智能体占了多少额度",
    render: (ws) => <WorkspaceUsageTab ws={ws} />,
  },
  {
    id: "memory", label: "记忆", icon: <Sparkles />,
    hint: () => "团队的 wiki：口径、客户、分工",
    render: (ws) => <WorkspaceWikiTab key={ws.id} ws={ws} />,
  },
];

export function WorkspacePage({
  ws,
  selfUid,
  onBack,
}: {
  ws: WorkspaceSnapshot;
  selfUid: string;
  onBack: () => void;
}) {
  const root: NavScreen = {
    // key 带上 ws.id：换团队时整棵栈重挂，上一个团队的二级页不会多活一帧
    key: `ws-root:${ws.id}`,
    title: ws.name,
    largeTitle: {
      title: ws.name,
      subtitle: `${ws.members.length} 人 · ${ws.ownerUid === selfUid ? "你是所有者" : "成员"}`,
    },
    leading: (
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-8 items-center gap-[3px] rounded-[9px] pr-2 pl-1 text-[14px] tracking-[-0.01em] text-brand transition-[transform,background-color] duration-150 active:scale-[0.96] active:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      >
        <ArrowLeft className="size-[17px]" aria-hidden />
        团队
      </button>
    ),
    render: () => <RootBody ws={ws} selfUid={selfUid} onLeftWorkspace={onBack} />,
  };

  return <NavStack root={root} />;
}

/** 根页正文。单独一个组件是因为它要 `useNav()`——那个上下文只在 `<NavStack>` 里面才有 */
function RootBody({
  ws, selfUid, onLeftWorkspace,
}: {
  ws: WorkspaceSnapshot;
  selfUid: string;
  onLeftWorkspace: () => void;
}) {
  const nav = useNav();
  const confirm = useConfirm();
  const deleteGroup = useChat((s) => s.deleteWorkspaceGroup);
  const leaveGroup = useChat((s) => s.leaveWorkspaceGroup);
  const error = useChat((s) => s.workspaceGroupsError);
  const isOwner = ws.ownerUid === selfUid;

  const onDelete = async (): Promise<void> => {
    const ok = await confirm({
      title: `解散团队「${ws.name}」？`,
      description: "全体成员的连接器授权与已发布会话会立即失效，且不可撤销。",
      confirmLabel: "解散",
      tone: "danger",
    });
    if (!ok) return;
    if (await deleteGroup(ws.id)) onLeftWorkspace();
  };

  const onLeave = async (): Promise<void> => {
    const ok = await confirm({
      title: `退出团队「${ws.name}」？`,
      description: "你贡献的连接器授权会立即失效。",
      confirmLabel: "退出",
      tone: "danger",
    });
    if (!ok) return;
    if (await leaveGroup(ws.id)) onLeftWorkspace();
  };

  return (
    <div className="flex flex-col">
      {error && <p className="px-1 pb-2 text-xs text-err">{error}</p>}
      <InsetGroup sepInset={51}>
        {SECTIONS.map((s) => (
          <InsetRow
            key={s.id}
            leading={<InsetIcon>{s.icon}</InsetIcon>}
            title={s.label}
            subtitle={s.hint(ws)}
            chevron
            onClick={() =>
              nav.push({
                key: `ws-${s.id}:${ws.id}`,
                title: s.label,
                // 返回钮上写**上一页叫什么**。团队名字长起来会顶到中间那行标题，
                // 那时退回「返回」——一个截断的名字比一个通用词更难认
                backLabel: ws.name.length > 6 ? "返回" : ws.name,
                largeTitle: { title: s.label },
                render: () => s.render(ws, selfUid),
              })
            }
          />
        ))}
      </InsetGroup>

      {/* 危险动作住在最底下、红字、单独一组——不是页头那颗最响的实心按钮 */}
      <div className="pt-[22px]">
        <InsetGroup>
          <InsetRow
            tone="danger"
            title={isOwner ? "解散团队" : "退出团队"}
            onClick={() => void (isOwner ? onDelete() : onLeave())}
          />
        </InsetGroup>
      </div>
      <InsetNote>
        {isOwner
          ? "解散会让全体成员的连接器授权与已发布会话立即失效，且不可撤销。"
          : "退出后你贡献的连接器授权会立即失效。"}
      </InsetNote>
    </div>
  );
}
