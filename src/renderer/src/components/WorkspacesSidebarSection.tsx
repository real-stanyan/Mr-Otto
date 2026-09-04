// WorkspacesSidebarSection —— 侧栏「项目」栏顶部的工作区一节（issue #917，ADR-0217）。
//
// 前身是 WorkspacesPanel：收在 footer icon 的右侧抽屉里，列表和详情页两层都归它管
// （ADR-0198 切片 3）。维护者 2026-09-04 把它搬进侧栏项目区——工作区和本地工程是
// 同一个问题的两个答案（「我在哪儿干活」），一个在侧栏一眼可见、另一个藏在底部
// 一枚图标后面，等于宣称它们不是一类东西。搬完这个组件只剩「列表」这一层，详情页
// 由 App 那侧的抽屉直接挂 WorkspacePage（换页/换层的判断收在一处，见 App.tsx）。
//
// **和本地工程分开显示**（维护者规则三）：自带一条段头 + 段尾一道内缩的细线。
// 内缩而不是通栏——通栏的横线读作「界面构件之间的分隔」（工具栏/页脚那种），
// 内缩的才读作「同一份清单里的两组」。两组的行长得也不一样：工作区行挂 Boxes
// 图标、报人数，本地工程组是可折叠的组头 + 组内会话，一眼分得出。
//
// 拉取不在这一层：refreshWorkspaceGroups 挂在 AppSidebar 上（工作区一条都没有时
// 这个组件 return null，effect 写在这儿就永远等不到第一次拉取——先有鸡还是先有蛋）。

import { Boxes } from "lucide-react";
import { useChat } from "../store.js";
import {
  SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar.js";

export function WorkspacesSidebarSection({
  openId,
  onOpen,
}: {
  /** 此刻详情页开着的那个（抽屉里那份）。行的选中态照它画 */
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const groups = useChat((s) => s.workspaceGroups);
  const error = useChat((s) => s.workspaceGroupsError);

  // 一条都没有就整节不出：**不画空态**。项目栏底下已经有一段「还没有项目」的
  // 空态文案，顶上再压一句「还没有工作区」，第一次进来的人要读两段才走到列表。
  // 发现入口是侧栏头部那颗「＋ 新工作区」，它常驻——空态本来就是它的活。
  // 拉取失败时也要出（groups 为空 + 有错 = 「读不到」，不是「没有」）
  if (groups.length === 0 && error === null) return null;

  return (
    <>
      <SidebarGroup className="py-1">
        {/* 段头不加 className:和下面本地工程组的组头用的是同一份 SidebarGroupLabel
            样式。两段是平级的两组「可以去干活的地方」,长得该一样;区分靠的是
            段名、行的样子和中间那道线,不是把段头做成另一种字 */}
        <SidebarGroupLabel>工作区</SidebarGroupLabel>
        <SidebarGroupContent>
          {error && <p className="px-2 pb-1 text-[11px] text-err break-words">{error}</p>}
          <SidebarMenu>
            {groups.map((g) => (
              <SidebarMenuItem key={g.id}>
                <SidebarMenuButton
                  className="h-auto py-[5px]"
                  isActive={openId === g.id}
                  onClick={() => onOpen(g.id)}
                  title={g.name}
                >
                  <Boxes className="size-[14px] shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1 min-w-0 truncate text-xs">{g.name}</span>
                  {/* 人数是这一行唯一值得占地方的事实：工作区的意义就是「不止我一个」 */}
                  <span className="shrink-0 font-mono text-[10px] opacity-70">{g.members.length}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {/* 分组线内缩(左右各让出 14px = 组的 8px 内边距再多 6px)。通栏的横线读作
          「界面构件之间的分隔」——工具栏、页脚那种;内缩的才读作「同一份清单里的
          两组」,而这正是要说的意思 */}
      <div className="mx-[14px] mb-1 border-b border-sidebar-border" aria-hidden />
    </>
  );
}
