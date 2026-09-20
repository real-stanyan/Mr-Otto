// AgentSettingsDrawer —— 一只智能体自己的设置（#1280，ADR-0297）。
//
// 与团队设置抽屉（WorkspacePage）同一副壳：右侧 Drawer + NavStack 推入式导航
// （ADR-0264）。差别在主语——那一页问「这个团队怎么配」，这一页问「这一只是谁、
// 它能用什么、它记得什么」。
//
// 根页直接是那张编辑表单（`AgentEditorScreen`，与团队设置里的「智能体」tab 共用
// 同一份）：这一层不再套一张「一只智能体」的列表——列表就是侧栏那一栏。
//
// 删除住在最底下、红字、单独一组，和 WorkspacePage 的危险区同一套版式。
// **管理员那一格换成一句为什么**，不是一颗点了必然被拒的钮（#722 的一般形式）。

import { NavStack, useNav } from "@/components/ui/nav-stack.js";
import { InsetGroup, InsetIcon, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer.js";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { Gauge, Sparkles } from "lucide-react";
import { useChat } from "../store.js";
import { AgentEditorScreen } from "./WorkspaceAgentsTab.js";
import { WorkspaceUsageTab } from "./WorkspaceUsageTab.js";
import { WorkspaceWikiTab } from "./WorkspaceWikiTab.js";
import { ADMIN_AGENT_ID } from "../../../shared/workspaceAgents.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../../shared/workspaces.js";

export function AgentSettingsDrawer() {
  const agentId = useChat((s) => s.agentSettingsFor);
  const close = useChat((s) => s.closeAgentSettings);
  // 主场那一份快照：这扇抽屉只给主场里的智能体用（团队里那几只在团队设置的
  // 「智能体」tab 里改，那一页还有权限矩阵要讲）
  const ws = useChat((s) => s.workspaceGroups.find((g) => g.agents.some((a) => a.agentId === agentId)) ?? null);
  const agent = ws?.agents.find((a) => a.agentId === agentId) ?? null;

  return (
    <Drawer
      // 判据取**查得到的那只**而不是 agentSettingsFor：它被删掉之后这扇抽屉
      // 自己关掉，不用另写一条善后（同 App.tsx 里 openedWorkspace 的纪律）
      open={agent !== null && ws !== null}
      onOpenChange={(o) => { if (!o) close(); }}
      direction="right"
      shouldScaleBackground={false}
    >
      <DrawerContent side="right" className="w-[min(420px,92vw)]">
        <DrawerHeader className="sr-only">
          <DrawerTitle>{agent?.name ?? "智能体"}</DrawerTitle>
        </DrawerHeader>
        {/* SidebarMenu 系列要 SidebarProvider 的上下文（抽屉 portal 到 body，
            根 provider 够不着）。滚动归每一页自己，同 WorkspacePage 那扇抽屉 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <SidebarProvider defaultOpen className="min-h-0 flex-1 flex-col">
            {ws !== null && agent !== null && (
              <NavStack
                root={{
                  key: `agent:${agent.agentId}`,
                  title: agent.name,
                  largeTitle: { title: agent.name },
                  render: () => <AgentSettingsRoot ws={ws} agent={agent} onClose={close} />,
                }}
              />
            )}
          </SidebarProvider>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function AgentSettingsRoot({
  ws,
  agent,
  onClose,
}: {
  ws: WorkspaceSnapshot;
  agent: WorkspaceAgentRow;
  onClose: () => void;
}) {
  const nav = useNav();
  const confirm = useConfirm();
  const deleteAgent = useChat((s) => s.deleteWorkspaceAgent);
  const isAdmin = agent.agentId === ADMIN_AGENT_ID;

  return (
    <div className="flex flex-col gap-[22px]">
      {/* 它是谁 / 它能用什么：与团队设置里那张表单共用同一份 */}
      <AgentEditorScreen ws={ws} state={{ mode: "edit", agent }} onDone={onClose} />

      {/* 它记得什么 */}
      <div>
        <InsetGroup sepInset={51}>
          <InsetRow
            leading={<InsetIcon><Sparkles /></InsetIcon>}
            title="记忆页"
            subtitle="它自己维护的那一页"
            chevron
            onClick={() =>
              nav.push({
                key: `agent-wiki:${agent.agentId}`,
                title: "记忆页",
                backLabel: agent.name.length > 6 ? "返回" : agent.name,
                largeTitle: { title: "记忆页" },
                render: () => <WorkspaceWikiTab key={ws.id} ws={ws} />,
              })
            }
          />
          <InsetRow
            leading={<InsetIcon><Gauge /></InsetIcon>}
            title="本周用量"
            subtitle="它占了多少额度"
            chevron
            onClick={() =>
              nav.push({
                key: `agent-usage:${agent.agentId}`,
                title: "本周用量",
                backLabel: agent.name.length > 6 ? "返回" : agent.name,
                largeTitle: { title: "本周用量" },
                render: () => <WorkspaceUsageTab ws={ws} />,
              })
            }
          />
        </InsetGroup>
      </div>

      {/* 删除。管理员那一格换成一句为什么——给一颗点了必然被拒的钮是撒谎的勾 */}
      {isAdmin ? (
        <InsetNote>
          管理员删不掉：它是替你建智能体的那一只，也是群里没人对口时接活的那一只。
        </InsetNote>
      ) : (
        <div>
          <InsetGroup>
            <InsetRow
              tone="danger"
              title={`删除「${agent.name}」`}
              onClick={() => {
                void (async () => {
                  const ok = await confirm({
                    title: `删除「${agent.name}」？`,
                    description:
                      "你和它的整段聊天、它自己的记忆页会一起删掉，不可恢复。它所在的群聊还在，只是少了它。",
                    confirmLabel: "删除",
                    tone: "danger",
                  });
                  if (!ok) return;
                  if (await deleteAgent(ws.id, agent.agentId)) onClose();
                })();
              }}
            />
          </InsetGroup>
          <InsetNote>删掉之后它在群里说过的话还在，只是再也叫不动它了。</InsetNote>
        </div>
      )}
    </div>
  );
}
