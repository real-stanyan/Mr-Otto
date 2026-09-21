// GroupSettingsDrawer —— 一个群自己的设置（#1280 A4，ADR-0297）。
//
// 与智能体设置抽屉（AgentSettingsDrawer）同一副壳、同一套版式：右侧 Drawer +
// NavStack（ADR-0264），危险动作在最底下、红字、单独一组。主语是这个群：
// 它叫什么、里面站着谁、还要不要它。
//
// 三条判据：
// ① **最后一只也移得走**：空群合法（0037 给 group 那条 CHECK 写的是 `0..6`），
//    删一只智能体不该连坐删掉它待过的群。空群的聊天页顶上会说「这个群里没有
//    智能体了」，人再往里加就是（AddAgentPopover 照常能用）。
// ② **改名与改名单分开发**：`chat_update` 两格各自可选，只改名时不把名单一起
//    发过去——那等于替用户声明「那一格我也确认是这个值」，而名单此刻可能正被
//    另一台设备改着。
// ③ **解散是删除不是归档**：整段聊天记录从 VPS 上抹掉，不可逆，所以二次确认里
//    要把这句话说全，同时说清「里面的智能体都还在」——人最怕的是删群连带删人。

import { useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { Button } from "@/components/ui/button.js";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer.js";
import { InsetGroup, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { Input } from "@/components/ui/input.js";
import { NavStack } from "@/components/ui/nav-stack.js";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { useChat } from "../store.js";
import { agentAvatarSrc } from "../lib/agentAvatar.js";
import { groupRows, homeOf } from "../lib/agentRoster.js";
import { CHAT_NAME_MAX } from "../../../shared/chatRoster.js";
import type { GroupChatRow } from "../lib/agentRoster.js";
import type { CloudSessionListRow } from "../lib/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

/** selector 里的 `?? []` 会每次造一个新数组 → zustand 走 `useSyncExternalStore`，
    每次都判成「变了」= 一个真的死循环（`unreadMentionCounts` 踩过）。兜底落在
    selector **外面**，指向同一个模块常量（同 AgentsSidebarSection / WorkspacesSidebarSection） */
const EMPTY_CLOUD_SESSIONS: CloudSessionListRow[] = [];

export function GroupSettingsDrawer() {
  const sessionId = useChat((s) => s.groupSettingsFor);
  const close = useChat((s) => s.closeGroupSettings);
  const groups = useChat((s) => s.workspaceGroups);
  const home = useMemo(() => homeOf(groups), [groups]);
  const chats = useChat((s) => (home === null ? undefined : s.cloudSessionList[home.id])) ?? EMPTY_CLOUD_SESSIONS;
  // 群名与名单都从清单那一行来（**头部不是**：名单那一半从日志推导，ADR-0302）；
  // 这个群被解散掉之后它自己就查不到了，
  // 抽屉跟着关，不用另写一条善后（同 AgentSettingsDrawer 的纪律）
  const row = useMemo(
    () => (home === null ? undefined : groupRows(home, chats).find((g) => g.sessionId === sessionId)),
    [home, chats, sessionId],
  );

  return (
    <Drawer
      open={row !== undefined && home !== null}
      onOpenChange={(o) => { if (!o) close(); }}
      direction="right"
      shouldScaleBackground={false}
    >
      <DrawerContent side="right" className="w-[min(420px,92vw)]">
        <DrawerHeader className="sr-only">
          <DrawerTitle>{row?.name ?? "群聊"}</DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <SidebarProvider defaultOpen className="min-h-0 flex-1 flex-col">
            {home !== null && row !== undefined && (
              <NavStack
                root={{
                  key: `group:${row.sessionId}`,
                  title: row.name,
                  largeTitle: { title: row.name },
                  render: () => <GroupSettingsRoot home={home} row={row} />,
                }}
              />
            )}
          </SidebarProvider>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function GroupSettingsRoot({ home, row }: { home: WorkspaceSnapshot; row: GroupChatRow }) {
  const confirm = useConfirm();
  const update = useChat((s) => s.updateGroupChat);
  const dissolve = useChat((s) => s.dissolveGroupChat);
  const [error, setError] = useState<string | null>(null);

  const apply = async (patch: { name?: string; agentIds?: string[] }): Promise<void> => {
    setError(null);
    const r = await update(row.sessionId, patch);
    if (!r.ok) setError(r.message);
  };

  return (
    <div className="flex flex-col gap-[22px]">
      <div>
        <InsetGroup>
          <GroupNameRow row={row} onSave={(name) => void apply({ name })} />
        </InsetGroup>
        <InsetNote>
          没起过名字的群，侧栏上显示的是成员名拼起来的一串——起个名字就不用每次数头像了。
        </InsetNote>
      </div>

      <div>
        <InsetGroup sepInset={51}>
          {row.agentIds.map((id) => {
            const name = home.agents.find((a) => a.agentId === id)?.name ?? id;
            return (
              <InsetRow
                key={id}
                leading={
                  <Avatar className="size-[26px] shrink-0 rounded-[6px]">
                    <AvatarImage src={agentAvatarSrc(home, id)} alt="" className="[image-rendering:pixelated]" />
                    <AvatarFallback className="rounded-[6px] text-[10px]">{name.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                }
                title={name}
                trailing={
                  <Button
                    variant="ghost"
                    size="xs"
                    className="press-scale text-err"
                    onClick={() => void apply({ agentIds: row.agentIds.filter((x) => x !== id) })}
                  >
                    移出
                  </Button>
                }
              />
            );
          })}
          {row.agentIds.length === 0 && (
            // 空群是合法状态不是坏掉了：删一只智能体不该连坐删掉它待过的群
            <InsetRow title="这个群里没有智能体了" subtitle="在聊天页顶上「添加智能体」把人请回来" />
          )}
        </InsetGroup>
        <InsetNote>移出之后它在群里说过的话还在，只是不再接这个群的活。</InsetNote>
      </div>

      {error !== null && <p className="px-1 text-[12px] text-err break-words">{error}</p>}

      <div>
        <InsetGroup>
          <InsetRow
            tone="danger"
            title="解散群聊"
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: `解散「${row.name}」？`,
                  description: "群里的整段聊天记录会一起删掉，不可恢复。里面的智能体都还在。",
                  confirmLabel: "解散",
                  tone: "danger",
                });
                if (!ok) return;
                const r = await dissolve(row.sessionId);
                if (!r.ok) setError(r.message);
              })();
            }}
          />
        </InsetGroup>
      </div>
    </div>
  );
}

/** 群名那一行：行内输入 + 「保存」。改名与改名单分开发——两格各自可选，
    只改名时不把名单一起发过去（见文件头注第 ② 条）。 */
function GroupNameRow({ row, onSave }: { row: GroupChatRow; onSave: (name: string) => void }) {
  // key 挂在 sessionId 上由上层的 NavStack 负责；这里的初值取**清单里那一行**，
  // 所以别处改完名刷新回来时这一格跟着变
  const [draft, setDraft] = useState(row.name);
  const trimmed = draft.trim();
  const dirty = trimmed !== "" && trimmed !== row.name;

  return (
    <InsetRow
      title={
        <Input
          value={draft}
          maxLength={CHAT_NAME_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && dirty) onSave(trimmed); }}
          aria-label="群名"
          className="h-7 border-0 bg-transparent px-0 text-[14px] shadow-none focus-visible:ring-0"
        />
      }
      label="群名"
      trailing={
        <Button
          variant="ghost"
          size="xs"
          className="press-scale transition-opacity duration-150 ease-out"
          disabled={!dirty}
          onClick={() => onSave(trimmed)}
        >
          保存
        </Button>
      }
    />
  );
}
