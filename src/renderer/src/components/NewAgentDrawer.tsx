// NewAgentDrawer —— 「不想聊，直接填表」那扇抽屉（#1280 A5）。
//
// 建一只智能体的**主路是跟管理员说一句话**（开局卡上那三枚 chip + 一个输入框）。
// 这一扇是第二条路，给已经知道自己要什么的人：名字、职责、型号、连接器、提示词
// 五格一次填完，不用等管理员反问。
//
// **两条路通向同一张表单**（`AgentEditorScreen`，与团队设置里的「智能体」tab、
// 以及 `AgentSettingsDrawer` 共用同一份）：抄第二份的那天两处会开始各说各的，
// 而这张表单里「型号那一格怎么映射回 models 那条有序链」的规则只有一份是对的。
//
// 壳与 `AgentSettingsDrawer` 逐字相同（右侧 Drawer + NavStack + SidebarProvider）——
// 那不是巧合：它们是同一件东西的两个时态（建 / 改），推入式导航、返回手势、
// 大标题都该一样。差别只有根页那一格 `state`。
//
// **主场没有的时候不画**（冷启动那一瞬、或档位不够还没建出来）：`AgentEditorScreen`
// 要一份 `WorkspaceSnapshot` 才画得出连接器那一段，没有就是一扇空抽屉。

import { NavStack } from "@/components/ui/nav-stack.js";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer.js";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { useMemo } from "react";
import { useChat } from "../store.js";
import { homeOf } from "../../../shared/agentRoster.js";
import { AgentEditorScreen } from "./WorkspaceAgentsTab.js";

export function NewAgentDrawer() {
  const open = useChat((s) => s.newAgentFormOpen);
  const close = useChat((s) => s.closeNewAgentForm);
  const groups = useChat((s) => s.workspaceGroups);
  // useMemo 而不是写进 selector：`homeOf` 今天回的是数组里那一项、引用是稳的，
  // 但这一栏的三个同族函数（rosterRows / groupRows）都造新数组，统一走 useMemo
  // 省得下一个人照着这里把会造新数组的那个也写进 selector（那是个真的死循环）
  const home = useMemo(() => homeOf(groups), [groups]);

  return (
    <Drawer
      // 判据取**查得到的主场**而不是 newAgentFormOpen 本身：主场读不出来时这扇
      // 抽屉自己不开，不用另写一条善后（同 AgentSettingsDrawer 的纪律）
      open={open && home !== null}
      onOpenChange={(o) => { if (!o) close(); }}
      direction="right"
      shouldScaleBackground={false}
    >
      <DrawerContent side="right" className="w-[min(420px,92vw)]">
        <DrawerHeader className="sr-only">
          <DrawerTitle>新智能体</DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <SidebarProvider defaultOpen className="min-h-0 flex-1 flex-col">
            {home !== null && (
              <NavStack
                root={{
                  key: "new-agent",
                  title: "新智能体",
                  largeTitle: { title: "新智能体" },
                  render: () => (
                    // 存好了 / 用户主动退出都走 onDone：表单自己会刷名册
                    <AgentEditorScreen ws={home} state={{ mode: "create" }} onDone={close} />
                  ),
                }}
              />
            )}
          </SidebarProvider>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
