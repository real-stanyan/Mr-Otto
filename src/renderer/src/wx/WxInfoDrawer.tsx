// WxInfoDrawer —— 桌面微信式布局（#1386）右边那扇「聊天信息」抽屉（点头部的 ··· 开）。
//
// 四种聊天四种内容：
//   · 智能体私聊：它的那几格（形象 / 名字 / 职责 / 还有什么要交代的，点开就改）+「建群」+ 删除；
//   · 主场群（我是群主）：成员格（我 + 拉进来的朋友 + 智能体）+ 拉人 / 移出 + 群名 + 解散；
//   · 别人拉我进的群（#1393）：成员格 + 拉我的朋友进来 + 退出（智能体归群主管，我拉不了也移不了）；
//   · 团队群：成员格 + 「团队设置」（进原来那扇抽屉：成员、智能体、连接器都在那儿管）；
//   · 朋友私聊：TA 的格子 +「建群」。
//
// 名单怎么改的判据全在 shared：`chat_update` 收的是**变动之后的完整名单**（groupEdit / chatRoster），
// 客人只能拉自己的朋友、只能把自己移出去（ADR-0325 决定 6，runtime 再核一次）。
//
// 抽屉不是弹窗：没有遮罩、不抢焦点，点外面（弹窗与浮层除外——那是它自己叫出来的）/ Esc 就收。
// 进出同一条路（从右边来、回右边去），动效在 app.css 的 `.wx-drawer`。

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Minus, Plus, X } from "lucide-react";
import { InsetGroup, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { WxFace, WxPerson } from "./WxAvatar.js";
import { WxIconButton } from "./ui.js";
import { useWxDialog, type PickPerson } from "./WxDialogs.js";
import { friendPeople, useNewGroupDialog } from "./WxContacts.js";
import { toast } from "./toast.js";
import { agentFaceSlot } from "../../../shared/agentAvatar.js";
import { chatViewOf, homeOf } from "../../../shared/agentRoster.js";
import { voiceRowValue } from "../../../shared/agentVoicePicker.js";
import { CHAT_GROUP_MAX, CHAT_HUMANS_MAX, chatHumansNow, narrowRoster } from "../../../shared/chatRoster.js";
import type { ChatPerson } from "../../../shared/chatGuests.js";
import { rosterOrder } from "../../../shared/groupEdit.js";
import { friendName, teamChatTitle } from "../../../shared/wechatInbox.js";
import { ADMIN_AGENT_ID, AGENT_NAME_MAX } from "../../../shared/workspaceAgents.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../../shared/workspaces.js";

export function WxInfoDrawer({
  open,
  onClose,
  onOpenAgent,
  onOpenFriend,
}: {
  open: boolean;
  onClose: () => void;
  /** 点成员格里的一只智能体：去它的资料页 */
  onOpenAgent: (ws: WorkspaceSnapshot, agentId: string) => void;
  /** 点成员格里的一个朋友：去 TA 的资料页 */
  onOpenFriend: (uid: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // 点外面就收（弹窗、菜单、浮层除外：它们是抽屉自己叫出来的，portal 在 body 上）
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element | null;
      if (t === null || ref.current?.contains(t)) return;
      if (t.closest('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [data-wx-info-toggle]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // 弹窗开着时 Esc 归弹窗
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <aside
      ref={ref}
      aria-label="聊天信息"
      aria-hidden={!open}
      data-open={open ? "true" : "false"}
      {...(open ? {} : { inert: true })}
      className="wx-drawer fixed top-0 right-0 bottom-0 z-30 flex w-[340px] flex-col bg-card shadow-[-1px_0_0_var(--border),0_12px_32px_rgba(0,0,0,0.16)] max-[560px]:w-full"
    >
      <header className="drag-region flex h-[58px] shrink-0 items-center gap-2 pr-3 pl-5">
        <span className="flex-1 text-[14px] font-semibold">聊天信息</span>
        <WxIconButton title="关闭" onClick={onClose}>
          <X className="size-[18px]" aria-hidden />
        </WxIconButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-4 pt-1 pb-6">
        {open && <InfoBody onClose={onClose} onOpenAgent={onOpenAgent} onOpenFriend={onOpenFriend} />}
      </div>
    </aside>
  );
}

function InfoBody({
  onClose,
  onOpenAgent,
  onOpenFriend,
}: {
  onClose: () => void;
  onOpenAgent: (ws: WorkspaceSnapshot, agentId: string) => void;
  onOpenFriend: (uid: string) => void;
}) {
  const friend = useChat((s) => s.friendChat);
  const cs = useChat((s) => s.cloudSession);
  const groups = useChat((s) => s.workspaceGroups);
  const guests = useChat((s) => s.guestChats);
  const lists = useChat((s) => s.cloudSessionList);
  const selfUid = useChat((s) => s.account.id);
  const newGroup = useNewGroupDialog();
  const home = useMemo(() => homeOf(groups), [groups]);

  if (friend !== null) {
    const name = friendName(friend);
    return (
      <>
        <Members>
          <Tile avatar={<WxPerson name={name} url={friend.avatarUrl} size={46} />} name={name} onClick={() => onOpenFriend(friend.id)} />
          {home !== null && <AddTile label="建群" title="拉几位进来，建个群" onClick={() => newGroup({ people: [friend.id] })} />}
        </Members>
        <InsetGroup>
          <InsetRow title="邮箱" trailing={<span className="max-w-[180px] truncate">{friend.email}</span>} />
          <InsetRow title="查看资料" chevron onClick={() => onOpenFriend(friend.id)} />
        </InsetGroup>
      </>
    );
  }
  if (cs === null) return <p className="px-1 text-[13px] text-muted-foreground">没有开着的聊天。</p>;

  const memberWs = groups.find((g) => g.id === cs.workspaceId) ?? null;
  const guestChat = guests.find((g) => g.ws.id === cs.workspaceId && g.session.id === cs.sessionId) ?? null;
  const ws = memberWs ?? guestChat?.ws ?? null;
  if (ws === null) return <p className="px-1 text-[13px] text-muted-foreground">正在读取…</p>;
  const row = (lists[cs.workspaceId] ?? []).find((r) => r.id === cs.sessionId);

  // 团队群（chat === null）
  if (cs.chat === null || cs.chat === undefined) {
    if (cs.chat === undefined) return <p className="px-1 text-[13px] text-muted-foreground">正在进入这条会话…</p>;
    return <TeamInfo ws={ws} rowTitle={row !== undefined ? teamChatTitle(ws, row) : ws.name} rowAgentIds={row !== undefined && row.chatKind !== null ? row.agentIds : null} selfUid={selfUid} onOpenAgent={onOpenAgent} onClose={onClose} />;
  }
  const view = chatViewOf(ws, cs.chat, cs.events, row?.title ?? "");
  // 私聊里那一只已经不在名册上了（删一只是三步、不原子）
  if (view === null) return <p className="px-1 text-[13px] text-muted-foreground">这只智能体不在了。</p>;
  if (view.kind === "dm") {
    const agent = ws.agents.find((a) => a.agentId === view.agentIds[0]) ?? null;
    if (agent === null) return <p className="px-1 text-[13px] text-muted-foreground">这只智能体不在了。</p>;
    return <DmInfo ws={ws} agent={agent} onOpenAgent={onOpenAgent} onClose={onClose} />;
  }
  // 群里的真人：日志那份是事实，清单那一行补头像
  const known = row?.humans ?? guestChat?.session.humans ?? [];
  const humans: ChatPerson[] = chatHumansNow(cs.events, cs.chat.humans).map((h) => ({
    uid: h.uid,
    name: h.name,
    avatarUrl: known.find((p) => p.uid === h.uid)?.avatarUrl ?? "",
  }));
  return (
    <GroupInfo
      ws={ws}
      sessionId={cs.sessionId}
      title={view.title}
      agentIds={view.agentIds}
      humans={humans}
      selfUid={selfUid}
      isOwner={ws.ownerUid === selfUid}
      onOpenAgent={onOpenAgent}
      onOpenFriend={onOpenFriend}
      onClose={onClose}
    />
  );
}

// ── 成员格 ───────────────────────────────────────────────────────────

function Members({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-4 gap-x-1.5 gap-y-3.5 px-0.5 pt-1">{children}</div>;
}

function Tile({ avatar, name, onClick }: { avatar: ReactNode; name: string; onClick?: () => void }) {
  const body = (
    <>
      {avatar}
      <span className="max-w-full truncate text-[11.5px] text-muted-foreground">{name}</span>
    </>
  );
  if (onClick === undefined) return <div className="flex min-w-0 flex-col items-center gap-[5px]">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={name}
      className="flex min-w-0 flex-col items-center gap-[5px] rounded-md transition-transform duration-150 active:scale-[0.95]"
    >
      {body}
    </button>
  );
}

function AddTile({ label, title, onClick, remove = false }: { label: string; title: string; onClick: () => void; remove?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-[5px]">
      <button
        type="button"
        title={title}
        aria-label={title}
        onClick={onClick}
        className="grid size-[46px] place-items-center rounded-[7px] border-[1.5px] border-dashed border-border text-muted-foreground transition-[background-color,color] duration-150 hover:bg-foreground/[0.045] hover:text-foreground"
      >
        {remove ? <Minus className="size-[18px]" aria-hidden /> : <Plus className="size-[18px]" aria-hidden />}
      </button>
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ── 智能体私聊 ───────────────────────────────────────────────────────

/** 一只智能体那几格（私聊的聊天信息里用；资料页那一份在 WxContacts，同一套判据） */
function AgentRows({ ws, agent }: { ws: WorkspaceSnapshot; agent: WorkspaceAgentRow }) {
  const update = useChat((s) => s.updateWorkspaceAgent);
  const openAgentSettings = useChat((s) => s.openAgentSettings);
  const openDialog = useWxDialog();
  const slot = agentFaceSlot(ws, agent.agentId);
  const outcome = (r: "ok" | "ok_stale" | "failed"): string | null =>
    r === "failed" ? (useChat.getState().workspaceGroupsError ?? "没有改成，稍后再试") : null;
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
    <InsetGroup>
      <InsetRow
        title="形象"
        chevron
        trailing={<WxFace slot={slot} size={22} />}
        onClick={() =>
          openDialog({
            kind: "face",
            spec: { title: "换个形象", current: slot, onSave: async (s) => outcome(await update(ws.id, agent.agentId, { avatarSlot: s })) },
          })
        }
      />
      <InsetRow title="名字" chevron trailing={<span className="max-w-[140px] truncate">{agent.name}</span>} onClick={() => edit("名字", "name", "群里 @ 它用的就是这个名字。", false)} />
      <InsetRow
        title="职责"
        chevron
        trailing={<span className="max-w-[140px] truncate">{agent.description || "没写"}</span>}
        onClick={() => edit("职责", "description", "一句话说清它是干什么的。", true)}
      />
      <InsetRow
        title="还有什么要交代的"
        chevron
        trailing={<span className="max-w-[100px] truncate">{agent.instructions.trim() || "没写"}</span>}
        onClick={() => edit("还有什么要交代的", "instructions", "口径、习惯、不许做的事。改完下一句话就生效。", true)}
      />
      <InsetRow title="说话的声音" trailing={voiceRowValue(agent.voice ?? null)} />
      <InsetRow title="更多设置" subtitle="型号、应用、记忆页" chevron onClick={() => openAgentSettings(agent.agentId)} />
    </InsetGroup>
  );
}

function DmInfo({
  ws,
  agent,
  onOpenAgent,
  onClose,
}: {
  ws: WorkspaceSnapshot;
  agent: WorkspaceAgentRow;
  onOpenAgent: (ws: WorkspaceSnapshot, agentId: string) => void;
  onClose: () => void;
}) {
  const newGroup = useNewGroupDialog();
  const del = useChat((s) => s.deleteWorkspaceAgent);
  const confirm = useConfirm();
  return (
    <>
      <Members>
        <Tile avatar={<WxFace slot={agentFaceSlot(ws, agent.agentId)} size={46} />} name={agent.name} onClick={() => onOpenAgent(ws, agent.agentId)} />
        <AddTile label="建群" title="拉几位进来，建个群" onClick={() => newGroup({ agents: [agent.agentId] })} />
      </Members>
      <AgentRows ws={ws} agent={agent} />
      {agent.agentId === ADMIN_AGENT_ID ? (
        <InsetNote className="-mt-2">管理员删不掉：新建智能体、没 @ 谁时接活都靠它。</InsetNote>
      ) : (
        <InsetGroup>
          <InsetRow
            tone="danger"
            title="删除这只智能体"
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: `删除「${agent.name}」？`,
                  description: "它的私聊一起删掉；它待过的群还在，只是少了它。删了找不回来。",
                  confirmLabel: "删除",
                  tone: "danger",
                });
                if (!ok) return;
                const r = await del(ws.id, agent.agentId);
                if (r === "failed") toast(useChat.getState().workspaceGroupsError ?? "没有删成");
                else onClose();
              })();
            }}
          />
        </InsetGroup>
      )}
    </>
  );
}

// ── 群（主场的，或别人拉我进的） ─────────────────────────────────────

function GroupInfo({
  ws,
  sessionId,
  title,
  agentIds,
  humans,
  selfUid,
  isOwner,
  onOpenAgent,
  onOpenFriend,
  onClose,
}: {
  ws: WorkspaceSnapshot;
  sessionId: string;
  title: string;
  agentIds: readonly string[];
  /** 群主之外的真人（含我自己，如果我是客人） */
  humans: readonly ChatPerson[];
  selfUid: string;
  isOwner: boolean;
  onOpenAgent: (ws: WorkspaceSnapshot, agentId: string) => void;
  onOpenFriend: (uid: string) => void;
  onClose: () => void;
}) {
  const openDialog = useWxDialog();
  const confirm = useConfirm();
  const updateGroupChat = useChat((s) => s.updateGroupChat);
  const dissolve = useChat((s) => s.dissolveGroupChat);
  const friends = useChat((s) => s.friendsSnapshot.friends);
  const myName = useChat((s) => (s.myProfile?.name || s.account.name || s.account.email).trim());
  const myUrl = useChat((s) => s.myProfile?.avatarUrl || s.account.avatarUrl || "");
  const friendIds = useMemo(() => new Set(friends.map((f) => f.profile.id)), [friends]);
  const owner = ws.members.find((m) => m.uid === ws.ownerUid) ?? null;
  const agents = rosterOrder(ws, agentIds.filter((id) => ws.agents.some((a) => a.agentId === id)));
  const humanUids = humans.map((h) => h.uid);
  const others = humans.filter((h) => h.uid !== selfUid);
  // 客人那一侧能拉的：我的朋友里此刻不在群里的（群主也不算——他本来就在）
  const invitable: PickPerson[] = friendPeople(
    friends.map((f) => f.profile),
    new Set([selfUid, ws.ownerUid, ...humanUids]),
  );
  const wsIdForUpdate = isOwner ? undefined : ws.id;

  const addMembers = (): void =>
    openDialog({
      kind: "pick",
      spec: {
        title: "拉人进群",
        ...(isOwner ? {} : { desc: "你能拉自己的朋友进来；智能体归群主管，只有群主能拉。" }),
        ws,
        agents: isOwner ? ws.agents.map((a) => a.agentId).filter((id) => !agentIds.includes(id)) : [],
        people: invitable,
        maxAgents: Math.max(0, CHAT_GROUP_MAX - agentIds.length),
        maxPeople: Math.max(0, CHAT_HUMANS_MAX - humans.length),
        min: 1,
        okLabel: "拉进来",
        onOk: async ({ agents: addA, people: addP }) => {
          const patch: { agentIds?: string[]; humans?: string[] } = {};
          if (addA.length > 0) patch.agentIds = rosterOrder(ws, [...agentIds, ...addA]);
          if (addP.length > 0) patch.humans = [...humanUids, ...addP];
          const r = await updateGroupChat(sessionId, patch, wsIdForUpdate);
          return r.ok ? null : r.message;
        },
      },
    });

  const removeMembers = (): void =>
    openDialog({
      kind: "pick",
      spec: {
        title: "移出群聊",
        ws,
        agents: agents,
        people: others.map((h) => ({ uid: h.uid, name: h.name, url: h.avatarUrl })),
        peopleLabel: "群里的人",
        maxAgents: CHAT_GROUP_MAX,
        maxPeople: CHAT_HUMANS_MAX,
        min: 1,
        okLabel: "移出",
        onOk: async ({ agents: rmA, people: rmP }) => {
          const patch: { agentIds?: string[]; humans?: string[] } = {};
          if (rmA.length > 0) patch.agentIds = agents.filter((id) => !rmA.includes(id));
          if (rmP.length > 0) patch.humans = humanUids.filter((u) => !rmP.includes(u));
          const r = await updateGroupChat(sessionId, patch);
          return r.ok ? null : r.message;
        },
      },
    });

  const rename = (): void =>
    openDialog({
      kind: "edit",
      spec: {
        title: "群聊名称",
        desc: "群里每个人看到的都是这个名字。",
        value: title,
        maxLength: 60,
        onSave: async (v) => {
          const r = await updateGroupChat(sessionId, { name: v });
          return r.ok ? null : r.message;
        },
      },
    });

  const leave = async (): Promise<void> => {
    const ok = await confirm({
      title: `退出「${title}」？`,
      description: "退出后收不到这个群的消息。群还在，里面的人和智能体都还在。",
      confirmLabel: "退出",
      tone: "danger",
    });
    if (!ok) return;
    const r = await updateGroupChat(sessionId, { humans: humanUids.filter((u) => u !== selfUid) }, ws.id);
    if (!r.ok) {
      toast(r.message);
      return;
    }
    useChat.getState().closeCloudSession();
    onClose();
  };

  const disband = async (): Promise<void> => {
    const ok = await confirm({
      title: `解散「${title}」？`,
      description: "聊天记录一起删掉，不可恢复。里面的智能体都还在，通讯录里照样找得到。",
      confirmLabel: "解散",
      tone: "danger",
    });
    if (!ok) return;
    const r = await dissolve(sessionId);
    if (!r.ok) {
      toast(r.message);
      return;
    }
    onClose();
  };

  return (
    <>
      <Members>
        {isOwner ? (
          <Tile avatar={<WxPerson name={myName} url={myUrl} size={46} />} name={myName} />
        ) : (
          owner !== null && (
            <Tile
              avatar={<WxPerson name={owner.label} url={owner.avatarUrl} size={46} />}
              name={owner.label}
              {...(friendIds.has(owner.uid) ? { onClick: () => onOpenFriend(owner.uid) } : {})}
            />
          )
        )}
        {humans.map((h) => (
          <Tile
            key={h.uid}
            avatar={<WxPerson name={h.name} url={h.avatarUrl} size={46} />}
            name={h.uid === selfUid ? myName : h.name}
            {...(friendIds.has(h.uid) ? { onClick: () => onOpenFriend(h.uid) } : {})}
          />
        ))}
        {agents.map((id) => {
          const a = ws.agents.find((x) => x.agentId === id);
          return (
            <Tile
              key={id}
              avatar={<WxFace slot={agentFaceSlot(ws, id)} size={46} />}
              name={a?.name ?? id}
              onClick={() => onOpenAgent(ws, id)}
            />
          );
        })}
        <AddTile label="拉人" title="拉人进群" onClick={addMembers} />
        {isOwner && (agents.length > 0 || others.length > 0) && <AddTile label="移出" title="移出群聊" onClick={removeMembers} remove />}
      </Members>
      <InsetGroup>
        {isOwner ? (
          <InsetRow title="群聊名称" chevron trailing={<span className="max-w-[160px] truncate">{title}</span>} onClick={rename} />
        ) : (
          <InsetRow title="群聊名称" trailing={<span className="max-w-[160px] truncate">{title}</span>} />
        )}
        <InsetRow title="群主" trailing={isOwner ? "我" : (owner?.label ?? "")} />
        <InsetRow title="没 @ 谁的时候" trailing={agents.length > 0 ? "智能体按职责自己接" : "等人回"} />
      </InsetGroup>
      <InsetNote className="-mt-2">
        {isOwner
          ? "群里的智能体归你管，在你的电脑上干活，走你的额度。朋友点起的活要动手之前，会等你批。"
          : "群里的智能体归群主管，在群主的电脑上干活，走群主的额度。你让它动手之前，要等群主批。"}
      </InsetNote>
      <InsetGroup>
        <InsetRow tone="danger" title={isOwner ? "解散群聊" : "退出群聊"} onClick={() => void (isOwner ? disband() : leave())} />
      </InsetGroup>
    </>
  );
}

// ── 团队群 ───────────────────────────────────────────────────────────

function TeamInfo({
  ws,
  rowTitle,
  rowAgentIds,
  selfUid,
  onOpenAgent,
  onClose,
}: {
  ws: WorkspaceSnapshot;
  rowTitle: string;
  /** 这条会话收窄过的名单（null = 团队会话不收窄 = 团队全部） */
  rowAgentIds: readonly string[] | null;
  selfUid: string;
  onOpenAgent: (ws: WorkspaceSnapshot, agentId: string) => void;
  onClose: () => void;
}) {
  const setOpenWorkspaceId = useChat((s) => s.setOpenWorkspaceId);
  const agents = narrowRoster(ws.agents, rowAgentIds === null ? null : [...rowAgentIds]);
  return (
    <>
      <Members>
        {ws.members.map((m) => (
          <Tile key={m.uid} avatar={<WxPerson name={m.label} url={m.avatarUrl} size={46} />} name={m.uid === selfUid ? `${m.label}（我）` : m.label} />
        ))}
        {agents.map((a) => (
          <Tile key={a.agentId} avatar={<WxFace slot={agentFaceSlot(ws, a.agentId)} size={46} />} name={a.name} onClick={() => onOpenAgent(ws, a.agentId)} />
        ))}
      </Members>
      <InsetGroup>
        <InsetRow title="群聊名称" trailing={<span className="max-w-[160px] truncate">{rowTitle}</span>} />
        <InsetRow title="团队" trailing={<span className="max-w-[160px] truncate">{ws.name}</span>} />
        <InsetRow
          title="团队设置"
          subtitle="成员、智能体、应用、文件"
          chevron
          onClick={() => {
            setOpenWorkspaceId(ws.id);
            onClose();
          }}
        />
      </InsetGroup>
      <InsetNote className={cn("-mt-2")}>团队里的智能体归团队管，干活走团队所有者的额度。</InsetNote>
    </>
  );
}
