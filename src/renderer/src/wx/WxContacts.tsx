// WxContacts —— 桌面微信式布局（#1386）「通讯录」那一栏的主区：智能体资料页、朋友资料页、
// 新的朋友、群聊。
//
// 智能体资料页照 demo：一行一格、点开就改（名字 / 职责 / 还有什么要交代的 / 形象），改完下一句话就生效。
// 型号与应用那两格没有摆在这一页上——它们是这一只的**进阶**设置，点「更多设置」进原来那扇抽屉
// （`AgentSettingsDrawer`，与团队设置里那张表单同一份），这一页不抄第二份。
// 「说话的声音」在桌面只读（ADR-0322 决定 6：桌面照读、不给挑，挑声音在手机上）。
//
// 别人的智能体（团队里的、朋友拉我进的群里的）只能看：名字、职责、归谁管——改不了、也私聊不了。

import type { ReactNode } from "react";
import { MessageCircle, Settings2, UserRoundPlus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { InsetGroup, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { useChat } from "../store.js";
import { WxAvatar, WxFace, WxPerson } from "./WxAvatar.js";
import { WxPaneHeader } from "./ui.js";
import { useWxDialog } from "./WxDialogs.js";
import { toast } from "./toast.js";
import { agentFaceSlot } from "../../../shared/agentAvatar.js";
import { voiceRowValue } from "../../../shared/agentVoicePicker.js";
import { CHAT_GROUP_MAX, CHAT_HUMANS_MAX } from "../../../shared/chatRoster.js";
import { mixedGroupName } from "../../../shared/chatGuests.js";
import type { FriendProfile } from "../../../shared/friends.js";
import { friendName, type GroupListRow, type GroupTarget } from "../../../shared/wechatInbox.js";
import { ADMIN_AGENT_ID, AGENT_NAME_MAX } from "../../../shared/workspaceAgents.js";
import { isHomeWorkspace, type WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { PickPerson } from "./WxDialogs.js";

/** 资料页 / 详情页共用的一副骨架：窄窗时头部只有一颗返回，正文居中一列 */
export function WxPage({
  onBack,
  width = 460,
  children,
}: {
  onBack: () => void;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WxPaneHeader onBack={onBack} bare />
      {/* 宽窗时头部整条不占地方——那一块留给拖窗口（资料页上面本来就是一片空白） */}
      <div className="drag-region h-6 shrink-0 max-[560px]:hidden" aria-hidden />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex flex-col gap-[18px] px-6 pt-7 pb-10" style={{ width: `min(${width}px, 100%)` }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** 资料页顶上那一块：名字（带一枚「是什么」的小签）+ 一行说明 + 右边一张大头像 */
function ProfileHead({ name, tag, sub, avatar }: { name: string; tag: string; sub: string; avatar: ReactNode }) {
  return (
    <div className="flex items-start gap-[18px]">
      <div className="min-w-0 flex-1 pt-1">
        <h2 className="m-0 flex items-center gap-2 text-[22px] leading-tight font-semibold tracking-[-0.01em]">
          <span className="min-w-0 truncate">{name}</span>
          <span className="shrink-0 rounded-[5px] bg-foreground/[0.055] px-1.5 py-px text-[11px] font-medium tracking-[0.02em] text-muted-foreground">
            {tag}
          </span>
        </h2>
        {sub !== "" && <p className="mt-1.5 mb-0 text-[13px] leading-[1.55] text-muted-foreground">{sub}</p>}
      </div>
      {avatar}
    </div>
  );
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex gap-2.5 [&>*]:h-[38px] [&>*]:flex-1">{children}</div>;
}

/** 把一次改动的结果翻成「存好了 / 一句人话」（EditTextDialog / FaceDialog 要的形状） */
function outcome(r: "ok" | "ok_stale" | "failed"): string | null {
  if (r !== "failed") return null;
  return useChat.getState().workspaceGroupsError ?? "没有改成，稍后再试";
}

// ── 智能体资料页 ─────────────────────────────────────────────────────

export function AgentProfilePane({
  ws,
  agentId,
  onBack,
  onMessage,
  onNewGroup,
}: {
  ws: WorkspaceSnapshot;
  agentId: string;
  onBack: () => void;
  onMessage: (agentId: string) => void;
  onNewGroup: (preset: { agents?: string[]; people?: string[] }) => void;
}) {
  const selfUid = useChat((s) => s.account.id);
  const update = useChat((s) => s.updateWorkspaceAgent);
  const del = useChat((s) => s.deleteWorkspaceAgent);
  const openAgentSettings = useChat((s) => s.openAgentSettings);
  const openDialog = useWxDialog();
  const confirm = useConfirm();
  const agent = ws.agents.find((a) => a.agentId === agentId) ?? null;
  if (agent === null) {
    return (
      <WxPage onBack={onBack}>
        <p className="py-10 text-center text-[13px] text-muted-foreground">这只智能体不在了。</p>
      </WxPage>
    );
  }
  const slot = agentFaceSlot(ws, agent.agentId);
  const mine = isHomeWorkspace(ws) && ws.ownerUid === selfUid;
  const ownerName = ws.members.find((m) => m.uid === ws.ownerUid)?.label ?? "群主";

  if (!mine) {
    // 别人的智能体：能看、能在群里 @，改不了、也私聊不了
    const whose = isHomeWorkspace(ws) ? `${ownerName}的智能体` : ws.name !== "" ? `${ws.name} 的智能体` : "团队的智能体";
    return (
      <WxPage onBack={onBack}>
        <ProfileHead name={agent.name} tag={whose} sub={agent.description} avatar={<WxFace slot={slot} size={84} state="alive" />} />
        <InsetNote className="px-0">
          {isHomeWorkspace(ws)
            ? `在群里 @ 它就行。它归${ownerName}管，在${ownerName}的电脑上干活，走${ownerName}的额度。`
            : "在团队的群里 @ 它就行。它归团队管，干活走团队所有者的额度。"}
        </InsetNote>
      </WxPage>
    );
  }

  const edit = (title: string, key: "name" | "description" | "instructions", desc: string, multiline: boolean): void =>
    openDialog({
      kind: "edit",
      spec: {
        title,
        desc,
        value: agent[key],
        multiline,
        ...(key === "name" ? { maxLength: AGENT_NAME_MAX } : {}),
        allowEmpty: key !== "name",
        onSave: async (v) => outcome(await update(ws.id, agent.agentId, { [key]: v })),
      },
    });

  return (
    <WxPage onBack={onBack}>
      <ProfileHead
        name={agent.name}
        tag="智能体"
        sub={agent.description !== "" ? agent.description : "还没定职责——跟它说一句它是干什么的。"}
        avatar={<WxFace slot={slot} size={84} state="alive" />}
      />
      <InsetGroup>
        <InsetRow
          title="形象"
          label="形象"
          chevron
          trailing={<WxFace slot={slot} size={24} />}
          onClick={() =>
            openDialog({
              kind: "face",
              spec: { title: "换个形象", current: slot, onSave: async (s) => outcome(await update(ws.id, agent.agentId, { avatarSlot: s })) },
            })
          }
        />
        <InsetRow title="名字" chevron trailing={<span className="max-w-[220px] truncate">{agent.name}</span>} onClick={() => edit("名字", "name", "群里 @ 它用的就是这个名字。", false)} />
        <InsetRow
          title="职责"
          chevron
          trailing={<span className="max-w-[220px] truncate">{agent.description || "没写"}</span>}
          onClick={() => edit("职责", "description", "一句话说清它是干什么的。群里没 @ 谁的时候，按这一句派活。", true)}
        />
        <InsetRow
          title="还有什么要交代的"
          chevron
          trailing={<span className="max-w-[180px] truncate">{agent.instructions.trim() !== "" ? agent.instructions.trim() : "没写"}</span>}
          onClick={() => edit("还有什么要交代的", "instructions", "口径、习惯、不许做的事。改完下一句话就生效。", true)}
        />
        <InsetRow title="说话的声音" trailing={voiceRowValue(agent.voice ?? null)} />
        <InsetRow
          title="更多设置"
          subtitle="型号、能用哪些应用、它的记忆页"
          chevron
          onClick={() => openAgentSettings(agent.agentId)}
          leading={<Settings2 className="size-4 text-muted-foreground" aria-hidden />}
        />
      </InsetGroup>
      <ActionRow>
        <Button onClick={() => onMessage(agent.agentId)}>
          <MessageCircle className="size-4" aria-hidden />
          发消息
        </Button>
        <Button variant="secondary" onClick={() => onNewGroup({ agents: [agent.agentId] })}>
          <UsersRound className="size-4" aria-hidden />
          拉进群聊
        </Button>
      </ActionRow>
      {agent.agentId === ADMIN_AGENT_ID ? (
        <InsetNote className="px-0">管理员删不掉：新建智能体、没 @ 谁时接活都靠它。</InsetNote>
      ) : (
        <InsetGroup>
          <InsetRow
            tone="danger"
            title={`删除「${agent.name}」`}
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: `删除「${agent.name}」？`,
                  description: "你和它的私聊、它自己的记忆页会一起删掉，不可恢复。它待过的群还在，只是少了它。",
                  confirmLabel: "删除",
                  tone: "danger",
                });
                if (!ok) return;
                const r = await del(ws.id, agent.agentId);
                if (r === "failed") toast(useChat.getState().workspaceGroupsError ?? "没有删成");
                else onBack();
              })();
            }}
          />
        </InsetGroup>
      )}
    </WxPage>
  );
}

// ── 朋友资料页 ───────────────────────────────────────────────────────

export function FriendProfilePane({
  friend,
  friendshipId,
  groups,
  canGroup,
  onBack,
  onMessage,
  onNewGroup,
}: {
  friend: FriendProfile;
  friendshipId: string;
  /** 一起在的群（标题） */
  groups: readonly string[];
  /** 我有没有自己的主场（没订阅就拉不了群） */
  canGroup: boolean;
  onBack: () => void;
  onMessage: (friend: FriendProfile) => void;
  onNewGroup: (preset: { agents?: string[]; people?: string[] }) => void;
}) {
  const confirm = useConfirm();
  const removeFriend = useChat((s) => s.removeFriend);
  const name = friendName(friend);
  return (
    <WxPage onBack={onBack}>
      <ProfileHead name={name} tag="朋友" sub={friend.email} avatar={<WxPerson name={name} url={friend.avatarUrl} size={84} />} />
      <InsetGroup>
        <InsetRow title="一起在的群" trailing={<span className="max-w-[260px] truncate">{groups.length > 0 ? groups.join("、") : "没有"}</span>} />
      </InsetGroup>
      <ActionRow>
        <Button onClick={() => onMessage(friend)}>
          <MessageCircle className="size-4" aria-hidden />
          发消息
        </Button>
        {canGroup && (
          <Button variant="secondary" onClick={() => onNewGroup({ people: [friend.id] })}>
            <UsersRound className="size-4" aria-hidden />
            拉进群聊
          </Button>
        )}
      </ActionRow>
      <InsetGroup>
        <InsetRow
          tone="danger"
          title="删除朋友"
          onClick={() => {
            void (async () => {
              const ok = await confirm({
                title: `删除「${name}」？`,
                description: "你们的私聊记录还在；一起在的群不会自动退出，要的话在群里移出。",
                confirmLabel: "删除",
                tone: "danger",
              });
              if (!ok) return;
              await removeFriend(friendshipId);
              const err = useChat.getState().friendError;
              if (err !== null) toast(err);
              else onBack();
            })();
          }}
        />
      </InsetGroup>
    </WxPage>
  );
}

// ── 新的朋友 ─────────────────────────────────────────────────────────

export function RequestsPane({ onBack }: { onBack: () => void }) {
  const snapshot = useChat((s) => s.friendsSnapshot);
  const respond = useChat((s) => s.respondFriend);
  const friendError = useChat((s) => s.friendError);
  const openDialog = useWxDialog();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WxPaneHeader
        onBack={onBack}
        actions={
          <Button variant="secondary" size="sm" onClick={() => openDialog({ kind: "addFriend" })}>
            <UserRoundPlus className="size-[15px]" aria-hidden />
            添加朋友
          </Button>
        }
      >
        <span className="text-[15px] font-semibold">新的朋友</span>
      </WxPaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-[min(560px,100%)] flex-col gap-[18px] px-6 py-8">
          {snapshot.incoming.length === 0 ? (
            <p className="m-0 text-[13px] text-muted-foreground">没有新的申请。</p>
          ) : (
            <InsetGroup sepInset={62}>
              {snapshot.incoming.map((r) => {
                const name = friendName(r.profile);
                return (
                  <InsetRow
                    key={r.friendshipId}
                    leading={<WxPerson name={name} url={r.profile.avatarUrl} size={40} />}
                    title={name}
                    subtitle={r.profile.email}
                    trailing={
                      <>
                        <Button variant="ghost" size="sm" onClick={() => void respond(r.friendshipId, false)}>
                          忽略
                        </Button>
                        <Button size="sm" onClick={() => void respond(r.friendshipId, true)}>
                          接受
                        </Button>
                      </>
                    }
                  />
                );
              })}
            </InsetGroup>
          )}
          {snapshot.outgoing.length > 0 && (
            <div>
              <div className="px-1 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">等对方同意</div>
              <InsetGroup sepInset={62}>
                {snapshot.outgoing.map((r) => {
                  const name = friendName(r.profile);
                  return (
                    <InsetRow
                      key={r.friendshipId}
                      leading={<WxPerson name={name} url={r.profile.avatarUrl} size={40} />}
                      title={name}
                      subtitle={r.profile.email}
                      trailing="已发申请"
                    />
                  );
                })}
              </InsetGroup>
            </div>
          )}
          {friendError !== null && <p className="m-0 text-[12px] text-err">{friendError}</p>}
        </div>
      </div>
    </div>
  );
}

// ── 群聊 ─────────────────────────────────────────────────────────────

export function GroupsPane({
  rows,
  canCreate,
  onBack,
  onOpen,
  onNewGroup,
}: {
  rows: readonly GroupListRow[];
  canCreate: boolean;
  onBack: () => void;
  onOpen: (t: GroupTarget) => void;
  onNewGroup: () => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WxPaneHeader
        onBack={onBack}
        actions={
          canCreate ? (
            <Button variant="secondary" size="sm" onClick={onNewGroup}>
              <UsersRound className="size-[15px]" aria-hidden />
              发起群聊
            </Button>
          ) : undefined
        }
      >
        <span className="text-[15px] font-semibold">群聊</span>
      </WxPaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-[min(560px,100%)] flex-col gap-[18px] px-6 py-8">
          {rows.length === 0 ? (
            <p className="m-0 text-[13px] text-muted-foreground">还没有群聊。</p>
          ) : (
            <InsetGroup sepInset={64}>
              {rows.map((g) => (
                <InsetRow
                  key={g.key}
                  leading={<WxAvatar spec={g.avatar} size={40} />}
                  title={g.title}
                  subtitle={g.members}
                  chevron
                  onClick={() => onOpen(g.target)}
                />
              ))}
            </InsetGroup>
          )}
          <InsetNote className="px-0">群里可以有智能体，也可以有朋友。群里的智能体归群主管，干活走群主的额度。</InsetNote>
        </div>
      </div>
    </div>
  );
}

// ── 发起群聊（弹窗的那份配置，列表头 ⊕ / 通讯录 / 资料页 / 聊天信息都从这里叫） ─────────

/** 我的朋友里能拉进群的那几位（按名字排，同通讯录） */
export function friendPeople(friends: readonly FriendProfile[], exclude: ReadonlySet<string>): PickPerson[] {
  return [...friends]
    .filter((f) => !exclude.has(f.id))
    .sort((a, b) => friendName(a).localeCompare(friendName(b), "zh-Hans-CN"))
    .map((f) => ({ uid: f.id, name: friendName(f), url: f.avatarUrl, sub: f.email }));
}

export function useNewGroupDialog(): (preset?: { agents?: string[]; people?: string[] }) => void {
  const openDialog = useWxDialog();
  const home = useChat((s) => s.workspaceGroups.find((g) => isHomeWorkspace(g)) ?? null);
  const friends = useChat((s) => s.friendsSnapshot.friends);
  const createGroupChat = useChat((s) => s.createGroupChat);
  return (preset) => {
    if (home === null) return;
    const people = friendPeople(friends.map((f) => f.profile), new Set());
    openDialog({
      kind: "pick",
      spec: {
        title: "发起群聊",
        desc: "拉几只智能体、几个朋友，凑够 2 位就能建。没 @ 谁的话，智能体按职责自己接活。",
        ws: home,
        agents: home.agents.map((a) => a.agentId),
        people,
        presetAgents: preset?.agents ?? [],
        presetPeople: preset?.people ?? [],
        maxAgents: CHAT_GROUP_MAX,
        maxPeople: CHAT_HUMANS_MAX,
        min: 2,
        okLabel: "建群",
        withName: true,
        onOk: async ({ agents, people: uids, name }) => {
          const picked = people.filter((p) => uids.includes(p.uid)).map((p) => ({ name: p.name }));
          const r = await createGroupChat(mixedGroupName(home, agents, picked, name), agents, uids);
          return r.ok ? null : r.message;
        },
      },
    });
  };
}
