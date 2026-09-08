// WorkspacesSidebarSection —— 侧栏「项目」栏顶部的工作区一节（issue #917 搬进来，
// issue #919 长成工程组的样子）。
//
// 前身是 WorkspacesPanel：收在 footer icon 的右侧抽屉里，列表和详情页两层都归它管
// （ADR-0198 切片 3）。搬进侧栏是因为工作区和本地工程是同一个问题的两个答案
// （「我在哪儿干活」）；**长成工程组的样子**是因为在那儿干活的方式也该是同一个
// （#919：「工作区创建会话方式应该和用户本地会话一致」）。所以这里的每一个工作区
// 都是一个 SidebarGroup，和下面的本地工程组用同一副骨架：可折叠的组头 + 组头右边
// 一颗 ＋ + 组内一列会话行挂在同一道竖脊上。
//
// 组头右边**两颗**动作，本地工程组只有一颗：
// · ＋ = 在这个工作区里开新会话（走 startCloudDraft → 主区开局卡，同本地的
//   newSession → Welcome；这一步不建任何东西）
// · ⚙ = 打开工作区详情（连接器 / 成员 / 已发布会话 / 已归档的云会话）。本地工程
//   没有「管理」这回事，工作区有——它是一群人的东西，得有地方拉人和撤授权
//
// **和本地工程分开显示**（#917 规则三）：段尾一道内缩的细线。内缩而不是通栏——
// 通栏的横线读作「界面构件之间的分隔」（工具栏/页脚那种），内缩的才读作「同一份
// 清单里的两组」。
//
// 归档的云会话不进这份清单（同本地：归档的会话在「已归档会话」那一屏，不在工程组里），
// 它们在 ⚙ 那一页的底部。
//
// 拉取不在这一层：工作区快照挂在 AppSidebar 上（一条都没有时这个组件 return null，
// effect 写在这儿就永远等不到第一次拉取）；云会话清单倒是在这一层拉，因为它按
// 工作区分，而这一层才知道有哪几个工作区。

import { useEffect, useMemo } from "react";
import { ChevronRight, Ellipsis, Plus, Settings2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useChat } from "../store.js";
import { cloudSessionRows } from "../lib/workspaceView.js";
import type { CloudSessionListRow } from "../lib/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { unreadMentionCounts } from "../../../shared/workspaceMentions.js";
import {
  SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarMenuAction,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar.js";

// 没拉过时的兜底：模块级常量而非每次渲染 `?? []`，保证 selector 每次返回同一
// 引用，不触发 zustand 无谓重渲（仓库 selector 约定，同 WorkspacePage 的 EMPTY）
const EMPTY_CLOUD_SESSIONS: CloudSessionListRow[] = [];

export function WorkspacesSidebarSection({
  collapsed,
  onToggle,
  onManage,
}: {
  /** 收起来的工作区 id 集合。和本地工程组共用同一套收放机制，只是另存一个键 */
  collapsed: ReadonlySet<string>;
  onToggle: (workspaceId: string) => void;
  /** 打开工作区详情（抽屉）。这一层不认识抽屉，只报「谁被点了管理」 */
  onManage: (workspaceId: string) => void;
}) {
  const groups = useChat((s) => s.workspaceGroups);
  const error = useChat((s) => s.workspaceGroupsError);
  const refreshCloud = useChat((s) => s.refreshCloudSessions);
  // 未读点名（#1064）。**在这一层算一次往下传**，不在每个组里各 select 一次：
  // `unreadMentionCounts` 每次都造新对象，直接写进 selector 就是每次渲染都
  // "变了" —— zustand 走 useSyncExternalStore，那是一个真的死循环（不是慢，
  // 是 Maximum update depth exceeded）。依赖取那个数组本身，它只在三条写入
  // 路径上换引用
  const mentionRows = useChat((s) => s.workspaceMentions);
  const unread = useMemo(() => unreadMentionCounts(mentionRows), [mentionRows]);

  // 每个工作区各拉一次云会话清单（没有推送通道，同 workspaceGroups 的待遇）。
  // 依赖是 id 拼成的串而不是 groups 本身：快照每次重拉都是新数组，用它当依赖
  // 会让这个 effect 跟着每一次刷新重跑一轮网络请求
  // 读不到的那几格（loadError，#843 ②）不去拉云会话清单：快照都拉不下来，
  // 这一趟多半也挂，白记一条错
  const ids = groups.filter((g) => g.loadError === undefined).map((g) => g.id).join(",");
  useEffect(() => {
    for (const id of ids === "" ? [] : ids.split(",")) void refreshCloud(id);
  }, [ids, refreshCloud]);

  // 一条都没有就整节不出：**不画空态**。项目栏底下已经有一段「还没有项目」的
  // 空态文案，顶上再压一句「还没有工作区」，第一次进来的人要读两段才走到列表。
  // 发现入口是侧栏头部那颗常驻的「新工作区」，空态本来就是它的活。
  // 拉取失败时也要出（groups 为空 + 有错 = 「读不到」，不是「没有」）
  if (groups.length === 0 && error === null) return null;

  return (
    <>
      {error && <p className="px-[10px] pb-1 text-[11px] text-err break-words">{error}</p>}
      {groups.map((ws) => (
        <WorkspaceGroup
          key={ws.id}
          ws={ws}
          collapsed={collapsed.has(ws.id)}
          onToggle={onToggle}
          onManage={onManage}
          unread={unread}
        />
      ))}
      {/* 分组线内缩（左右各让出 14px = 组的 8px 内边距再多 6px）。通栏的横线读作
          「界面构件之间的分隔」，内缩的才读作「同一份清单里的两组」 */}
      <div className="mx-[14px] mb-1 border-b border-sidebar-border" aria-hidden />
    </>
  );
}

/** 一个工作区 = 一个组。骨架逐处对齐 App.tsx 里的本地工程组（同一个 SidebarGroup +
    可折叠 SidebarGroupLabel + SidebarGroupAction + 带竖脊的组内列表），改的只有
    「组里装的是云会话」和「多一颗 ⚙」。 */
/** 未读点名的角标。**两处都画**（组头 + 会话行）：收起来的时候会话行根本
    不在屏幕上，只有组头那一格能说话；展开之后又必须指出是**哪一条**会话，
    否则人得一条条点开找。
    颜色取 `--brand` 不取 `--warn`：被 @ 不是「出事了」，而本仓 warn 这个语义
    是留给出事的（ADR-0240 那笔账已经让 Max 徽章借走一次形，不能再借第二次）。
    **不做入场动效**：它是个挂着的状态记号不是一次事件（同 ADR-0255） */
function MentionBadge({ count, title }: { count: number; title: string }) {
  if (count <= 0) return null;
  return (
    <span
      className="shrink-0 min-w-[16px] h-4 px-[5px] rounded-full bg-brand text-white
                 text-[10px] leading-4 text-center font-medium tabular-nums"
      title={title}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function WorkspaceGroup({
  ws,
  collapsed,
  onToggle,
  onManage,
  unread,
}: {
  ws: WorkspaceSnapshot;
  collapsed: boolean;
  onToggle: (workspaceId: string) => void;
  onManage: (workspaceId: string) => void;
  unread: ReturnType<typeof unreadMentionCounts>;
}) {
  const list = useChat((s) => s.cloudSessionList[ws.id]) ?? EMPTY_CLOUD_SESSIONS;
  const openCloud = useChat((s) => s.openCloudSession);
  const startDraft = useChat((s) => s.startCloudDraft);
  const openSessionId = useChat((s) => s.cloudSession?.sessionId ?? null);
  const archiveCloud = useChat((s) => s.cloudArchive);
  const deleteCloud = useChat((s) => s.cloudDelete);
  const selfUid = useChat((s) => s.account.id);
  const draftWorkspaceId = useChat((s) => s.cloudDraftWorkspaceId);

  // 归档的不进侧栏（同本地：归档的会话在「已归档会话」那一屏）
  const rows = cloudSessionRows(list, ws).filter((r) => !r.archived);

  // 这一格暂时读不到（#843 ②）：画组头 + 一句原因，**不给动作**——⚙ 打开的
  // 设置页会拿空名册当事实（「成员：0 人」），＋ 开出来的会话没有 agent 可 @。
  // 它和「建群失败」长得不一样（有名字、有原因），和「真的空」也不一样（红字）
  if (ws.loadError !== undefined) {
    return (
      <SidebarGroup className="py-1">
        <SidebarGroupLabel className="gap-1" title={ws.loadError}>
          <span className="min-w-0 truncate">{ws.name}</span>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <p className="px-2 pt-[2px] text-[11px] text-err break-words">暂时读不到这个工作区：{ws.loadError}</p>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return (
    <SidebarGroup className="py-1">
      <SidebarGroupLabel asChild>
        {/* pr-14 给右边两颗动作让位（本地工程组只有一颗，那边是 pr-7） */}
        <button
          className="w-full gap-1 pr-14 hover:text-sidebar-foreground"
          onClick={() => onToggle(ws.id)}
          title={`${ws.name} · ${ws.members.length} 人`}
        >
          {/* 折叠只切显隐（列表结构变化，不做高度动画）；箭头转 = 状态反馈 */}
          <ChevronRight
            className={`w-[13px] h-[13px] shrink-0 transition-transform duration-150 ease-out ${collapsed ? "" : "rotate-90"}`}
          />
          <span className="min-w-0 truncate">{ws.name}</span>
          {/* 收起来了才报条数：展开时数得出来，标签栏别添噪（同本地工程组） */}
          {collapsed && rows.length > 0 && (
            <span className="shrink-0 font-mono text-[10px] opacity-70">{rows.length}</span>
          )}
          {/* 角标**收不收起来都画**（#1064）：条数展开就数得出来，所以收起来才报；
              未读数展开也数不出来——它不是这份列表的函数 */}
          <MentionBadge
            count={unread.byWorkspace[ws.id] ?? 0}
            title={`这个工作区里有 ${unread.byWorkspace[ws.id] ?? 0} 条 @ 你的消息没看`}
          />
        </button>
      </SidebarGroupLabel>
      {/* ⚙ 排在 ＋ 左边。工作区独有的那一颗：它是一群人的东西，得有地方拉人、
          调授权、撤回已发布的会话 —— 本地工程没有这回事 */}
      <SidebarGroupAction
        className="right-8 text-muted-foreground"
        title={`${ws.name} 的设置：智能体、成员、连接器、已发布`}
        onClick={() => onManage(ws.id)}
      >
        <Settings2 />
      </SidebarGroupAction>
      <SidebarGroupAction
        title={`在 ${ws.name} 里开新会话`}
        // 这一步不建任何东西，只把主区换成开局卡 —— 同本地工程组那颗 ＋
        onClick={() => startDraft(ws.id)}
      >
        <Plus />
      </SidebarGroupAction>
      {!collapsed && (
        <SidebarGroupContent>
          {rows.length === 0 ? (
            // 组头那颗 ＋ 就在正上方，这句话只需要说「这里是空的」
            <p className="px-2 pt-[2px] text-[11px] text-muted-foreground">
              还没有会话，点右上角 ＋ 开一个。
            </p>
          ) : (
            // 一道竖脊 + 缩进：一眼看出这些会话挂在上面那个工作区下（逐字同本地工程组）
            <SidebarMenu className="border-l border-sidebar-border ml-[11px] w-[calc(100%-11px)] pl-[6px]">
              {rows.map((row) => (
                <SidebarMenuItem key={row.id}>
                  <SidebarMenuButton
                    className="h-auto py-[5px]"
                    isActive={openSessionId === row.id}
                    onClick={() => void openCloud(ws.id, row.id)}
                    title={`${row.title} · ${row.creatorLabel}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">{row.title}</span>
                    <MentionBadge
                      count={unread.bySession[row.id] ?? 0}
                      title={`这条会话里有 ${unread.bySession[row.id] ?? 0} 条 @ 你的消息没看`}
                    />
                  </SidebarMenuButton>
                  {/* ⋮ 菜单（#993 第 5 条）：归档从会话头部搬到这里，同本地会话那行的
                      ⋮。**「删除」是 #1044 补上的**：原来没有，理由是 0016 迁移把
                      wss_delete_publisher 钉死在 kind='package'，成员删不掉自己那行
                      workspace_sessions——但那条前提只对**客户端直连 Supabase** 成立，
                      runtime 拿的是 service key，走 delete 帧删得动（协议 10）。
                      显隐判据抄服务端那条（#822：owner 或建这条会话的人）——渲染层
                      不是安全边界，服务端仍然自己判一次 */}
                  {(selfUid === ws.ownerUid || selfUid === row.creatorUid) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction
                          showOnHover
                          title="会话操作"
                          onClick={(e) => e.stopPropagation() /* 别触发外层的"进这条会话" */}
                        >
                          <Ellipsis />
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem
                          onClick={() => {
                            // 云端没有"恢复归档"那一半（daemon 启动只捞 archived=false
                            // 的会话重开房间），所以先问一句——同侧栏「删除会话」、
                            // 踢人那几处的原生 confirm，不新造一套视觉语言
                            if (!window.confirm(`归档「${row.title}」？群里所有人都会看到它收尾，之后不能再发言，也不能恢复。`)) return;
                            void archiveCloud(ws.id, row.id);
                          }}
                        >
                          归档
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            // 两句话说清它与归档的差别：归档是"收尾但还看得见"，
                            // 删除是**整段对话从云端消失**，而那段对话是一群人一起
                            // 写的——本机那颗删除只影响自己，这颗不是
                            if (!window.confirm(`彻底删除「${row.title}」？\n整段对话会从云端抹掉，群里所有人都再也看不到，不可恢复。`)) return;
                            void deleteCloud(ws.id, row.id);
                          }}
                        >
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}
          {/* 开局卡正开在这个工作区上：给它一行占位，否则「我刚点了 ＋」这件事
              在侧栏里没有任何痕迹（本地那条路上，Welcome 也是主区一整屏在说话，
              但侧栏那颗 ＋ 是组头上的，视线本来就没离开） */}
          {draftWorkspaceId === ws.id && (
            <p className="ml-[11px] pl-[6px] border-l border-sidebar-border px-2 py-[5px] text-[11px] text-muted-foreground">
              正在开新会话…
            </p>
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
