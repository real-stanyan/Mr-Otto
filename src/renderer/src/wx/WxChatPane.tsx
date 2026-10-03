// WxChatPane —— 桌面微信式布局（#1386）「聊天」那一栏的主区。四种样子：
//   · 云会话（智能体私聊 / 主场群 / 团队群 / 别人拉我进的群）→ `CloudSessionMain` 原样，
//     只把头部换成微信那一行（名字带人数 · 此刻在干什么 · 电话 · ···），输入框与气泡那一套由
//     `CloudSessionPage` 的 `wx` 外观管；
//   · 私聊草稿（从通讯录点「发消息」、还没说第一句）→ 一张脸 + 它的职责 + 输入框，第一句发出去才建；
//   · 团队的开局卡（团队设置里点「新群聊」）→ 原来那张 `CloudWelcome`；
//   · 朋友私聊 → `messages` 表那条路（dmByFriend / sendDm / loadOlderDms），换一张微信的皮。
//
// 头部是拖窗口的地方（`drag-region`，按钮自动 no-drag）。窄到一栏时多一颗返回。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Ellipsis } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { CloudSessionMain } from "../components/CloudSessionMain.js";
import { CloudWelcome } from "../components/CloudWelcome.js";
import { EmojiPicker } from "../components/EmojiPicker.js";
import { WxFace, WxPerson } from "./WxAvatar.js";
import { WxEmptyPane, WxIconButton, WxPaneHeader } from "./ui.js";
import { homeOf } from "../../../shared/agentRoster.js";
import type { ChatView } from "../../../shared/agentRoster.js";
import { agentFaceSlot } from "../../../shared/agentAvatar.js";
import { othersInGroup } from "../../../shared/chatGuests.js";
import { chatHumansNow } from "../../../shared/chatRoster.js";
import type { FriendProfile } from "../../../shared/friends.js";
import { nowRowOf, type NowPhase } from "../../../shared/mobileChat.js";
import { decodeEnvelope } from "../../../shared/sessionPackageCodec.js";
import { dmPreview, friendName, needsTimeRow, teamChatTitle, timelineTimeLabel } from "../../../shared/wechatInbox.js";
import { isHomeWorkspace, type WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { ChatMessage } from "../lib/friendsState.js";

const PHASE_STATUS: Record<NowPhase, string> = { solving: "正在输入…", working: "正在干活…", queued: "排队中…" };
const EMPTY_DMS: ChatMessage[] = [];

export function WxChatPane({
  onBack,
  onInfo,
  infoOpen,
}: {
  /** 窄到一栏时回到列表 */
  onBack: () => void;
  onInfo: () => void;
  infoOpen: boolean;
}) {
  const friend = useChat((s) => s.friendChat);
  const hasCloud = useChat((s) => s.cloudSession !== null);
  const draftWs = useChat((s) => s.cloudDraftWorkspaceId);
  const draftChat = useChat((s) => s.cloudDraftChat);
  const home = useChat((s) => homeOf(s.workspaceGroups));

  if (friend !== null) return <WxFriendChat friend={friend} onBack={onBack} onInfo={onInfo} infoOpen={infoOpen} />;
  if (draftWs !== null && draftChat?.kind === "dm") {
    return <WxDraftChat workspaceId={draftWs} agentId={draftChat.agentId} onBack={onBack} />;
  }
  if (draftWs !== null && draftChat === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <WxPaneHeader onBack={onBack} />
        <CloudWelcome workspaceId={draftWs} />
      </div>
    );
  }
  if (hasCloud) return <WxCloudChat onBack={onBack} onInfo={onInfo} infoOpen={infoOpen} />;
  return (
    <WxEmptyPane face={<WxFace slot={home === null ? 0 : agentFaceSlot(home, "admin")} size={64} />} />
  );
}

// ── 云会话 ───────────────────────────────────────────────────────────

function WxCloudChat({ onBack, onInfo, infoOpen }: { onBack: () => void; onInfo: () => void; infoOpen: boolean }) {
  const setOpenWorkspaceId = useChat((s) => s.setOpenWorkspaceId);
  const cloudWs = useChat((s) => s.cloudSession?.workspaceId ?? null);
  const cloudSid = useChat((s) => s.cloudSession?.sessionId ?? null);
  const guests = useChat((s) => s.guestChats);
  // 别人主场里拉我进去的群（#1393）：我不在那个 workspace 里，快照是拉清单时拼好的那一份
  const fallbackWs = useMemo(
    () => guests.find((g) => g.ws.id === cloudWs && g.session.id === cloudSid)?.ws ?? null,
    [guests, cloudWs, cloudSid],
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CloudSessionMain
        onManage={setOpenWorkspaceId}
        fallbackWs={fallbackWs}
        wxHeader={({ ws, chat, voiceSlot }) => (
          <WxCloudHeader ws={ws} chat={chat} voiceSlot={voiceSlot} onBack={onBack} onInfo={onInfo} infoOpen={infoOpen} />
        )}
      />
    </div>
  );
}

/** 云会话的头部：标题（群带人数）+ 此刻在干什么（作答 > 执行 > 排队，`nowRowOf`，手机同一份）+ 电话 + ··· */
function WxCloudHeader({
  ws,
  chat,
  voiceSlot,
  onBack,
  onInfo,
  infoOpen,
}: {
  ws: WorkspaceSnapshot;
  chat: ChatView | null;
  voiceSlot: ReactNode;
  onBack: () => void;
  onInfo: () => void;
  infoOpen: boolean;
}) {
  const cs = useChat((s) => s.cloudSession);
  const streaming = useChat((s) => s.cloudStreaming);
  const selfUid = useChat((s) => s.account.id);
  const row = useChat((s) =>
    s.cloudSession ? s.cloudSessionList[s.cloudSession.workspaceId]?.find((r) => r.id === s.cloudSession?.sessionId) : undefined
  );
  const events = cs?.events;
  const now = useMemo(() => (events === undefined ? null : nowRowOf({ events, streaming, ws })), [events, streaming, ws]);
  const humans = useMemo(() => {
    if (chat === null) return ws.members.filter((m) => m.uid !== selfUid).length;
    if (chat.kind !== "group" || !cs?.chat) return 0;
    const people = chatHumansNow(cs.events, cs.chat.humans).map((h) => ({ uid: h.uid, name: h.name, avatarUrl: "" }));
    // 群主那一侧：客人；客人那一侧：群主 + 别的客人（我自己另算一位）
    return othersInGroup({ ws, humans: people, selfUid, guestView: ws.ownerUid !== selfUid }).length;
  }, [chat, cs, ws, selfUid]);
  const title = chat !== null ? chat.title : row !== undefined ? teamChatTitle(ws, row) : ws.name;
  // 人数（照微信：连我自己算上）。私聊不写
  const count =
    chat === null
      ? humans + 1 + (row !== undefined && row.chatKind !== null ? row.agentIds.length : ws.agents.length)
      : chat.kind === "group"
        ? chat.agentIds.length + humans + 1
        : 0;
  const status =
    cs?.state === "gone" ? "正在重连…" : cs?.state === "connecting" ? "连接中…" : now !== null ? PHASE_STATUS[now.phase] : "";
  const guestChat = isHomeWorkspace(ws) && ws.ownerUid !== selfUid;
  return (
    <WxPaneHeader
      onBack={onBack}
      actions={
        <>
          {voiceSlot}
          <WxIconButton title="聊天信息" onClick={onInfo} active={infoOpen} aria-haspopup="dialog">
            <Ellipsis className="size-[18px]" aria-hidden />
          </WxIconButton>
        </>
      }
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">
          {title}
          {count > 0 && <span className="ml-0.5 font-normal text-muted-foreground tabular-nums">({count})</span>}
        </span>
        {status !== "" && (
          <span className={cn("shrink-0 text-[12px] text-muted-foreground", now !== null && "shimmer")}>{status}</span>
        )}
        {guestChat && status === "" && (
          <span className="shrink-0 text-[11.5px] text-muted-foreground">群主的智能体在群主的电脑上干活</span>
        )}
      </span>
    </WxPaneHeader>
  );
}

// ── 私聊草稿 ─────────────────────────────────────────────────────────

function WxDraftChat({ workspaceId, agentId, onBack }: { workspaceId: string; agentId: string; onBack: () => void }) {
  const ws = useChat((s) => s.workspaceGroups.find((g) => g.id === workspaceId) ?? null);
  const createFromDraft = useChat((s) => s.createCloudSessionFromDraft);
  const agent = ws?.agents.find((a) => a.agentId === agentId) ?? null;
  const [busy, setBusy] = useState(false);
  const name = agent?.name ?? "智能体";
  const send = async (text: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    await createFromDraft(workspaceId, text);
    setBusy(false);
    return true;
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WxPaneHeader onBack={onBack}>
        <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">{name}</span>
      </WxPaneHeader>
      <div className="grid flex-1 place-items-center overflow-y-auto px-8">
        <div className="flex max-w-[360px] flex-col items-center gap-2 text-center">
          {ws !== null && <WxFace slot={agentFaceSlot(ws, agentId)} size={72} state="alive" />}
          <span className="mt-1 text-[17px] font-semibold">{name}</span>
          {agent !== null && agent.description !== "" && (
            <span className="text-[13.5px] leading-relaxed text-muted-foreground">{agent.description}</span>
          )}
          <span className="text-[12.5px] text-foreground/40">说第一句话就开始了。</span>
        </div>
      </div>
      <WxComposer placeholder={`跟${name}说点什么`} disabled={busy || ws === null} onSend={send} />
    </div>
  );
}

// ── 输入框（朋友私聊 / 草稿用；云会话的那一块在 CloudSessionPage 里，同一个样子） ──

export function WxComposer({
  placeholder,
  disabled = false,
  onSend,
}: {
  placeholder: string;
  disabled?: boolean;
  /** 发出去了回 true（清输入框）；没发出去回 false（正文留着，人改改再发） */
  onSend: (text: string) => Promise<boolean> | boolean;
}) {
  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !disabled && draft.trim() !== "";
  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!canSend || text === "") return;
    const ok = await onSend(text);
    if (ok) setDraft("");
  };
  const insert = (t: string): void => {
    const box = boxRef.current;
    const start = box?.selectionStart ?? draft.length;
    const end = box?.selectionEnd ?? start;
    const c = start + t.length;
    setDraft(draft.slice(0, start) + t + draft.slice(end));
    requestAnimationFrame(() => {
      boxRef.current?.focus();
      boxRef.current?.setSelectionRange(c, c);
    });
  };
  return (
    <footer className="group/composer relative flex h-[152px] shrink-0 flex-col border-t border-foreground/[0.07] pt-2.5 pr-4 pb-3 pl-6 max-[760px]:pl-4">
      <textarea
        ref={boxRef}
        rows={1}
        autoFocus
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="输入消息"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter 发送、Shift+Enter 换行；输入法组词途中的 Enter 是「选词」不是「发送」
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        className="min-h-0 w-full flex-1 resize-none border-0 bg-transparent py-0.5 text-[14px] leading-[1.6] text-foreground caret-brand outline-none placeholder:text-foreground/35 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="-ml-1.5 flex items-center gap-0.5">
        <EmojiPicker disabled={disabled} onPick={insert} />
        <span className="mr-2.5 ml-auto text-[11.5px] text-foreground/40 opacity-0 transition-opacity duration-150 group-focus-within/composer:opacity-100">
          Enter 发送 · Shift + Enter 换行
        </span>
        <Button size="sm" className="h-[30px] px-[18px]" disabled={!canSend} onClick={() => void submit()}>
          发送
        </Button>
      </div>
    </footer>
  );
}

// ── 朋友私聊 ─────────────────────────────────────────────────────────

function WxFriendChat({
  friend,
  onBack,
  onInfo,
  infoOpen,
}: {
  friend: FriendProfile;
  onBack: () => void;
  onInfo: () => void;
  infoOpen: boolean;
}) {
  const messages = useChat((s) => s.dmByFriend[friend.id]) ?? EMPTY_DMS;
  const selfUid = useChat((s) => s.account.id);
  const me = useChat((s) => s.myProfile);
  const account = useChat((s) => s.account);
  const online = useChat((s) => s.onlineIds.includes(friend.id));
  const health = useChat((s) => s.realtimeHealth);
  const friendError = useChat((s) => s.friendError);
  const sendDm = useChat((s) => s.sendDm);
  const loadOlderDms = useChat((s) => s.loadOlderDms);
  const name = friendName(friend);
  const myName = (me?.name || account.name || account.email).trim();
  const myUrl = me?.avatarUrl || account.avatarUrl || "";

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // 贴底才跟底：翻旧消息时来一条新的不该把人拽回去（同云会话那一页）。按最后一条的 id 判，
  // 翻旧页（前插）不动它
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastId, friend.id]);

  const now = useMemo(() => Date.now(), []);
  const rows = useMemo(() => {
    const out: { key: string; time: string | null; m: ChatMessage; mine: boolean }[] = [];
    let prev: number | null = null;
    for (const m of messages) {
      const ts = Date.parse(m.createdAt) || now;
      const mine = m.sender !== friend.id;
      out.push({ key: `m${m.id}`, time: needsTimeRow(prev, ts) ? timelineTimeLabel(ts, now) : null, m, mine });
      prev = ts;
    }
    return out;
  }, [messages, friend.id, now]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WxPaneHeader
        onBack={onBack}
        actions={
          <WxIconButton title="聊天信息" onClick={onInfo} active={infoOpen} aria-haspopup="dialog">
            <Ellipsis className="size-[18px]" aria-hidden />
          </WxIconButton>
        }
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">{name}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground">
            {health === "degraded" ? "实时推送不通，慢几秒" : online ? "在线" : ""}
          </span>
        </span>
      </WxPaneHeader>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 pt-5 pb-6 max-[760px]:px-4"
      >
        {messages.length >= 50 && (
          <button
            type="button"
            onClick={() => void loadOlderDms()}
            className="self-center rounded-full px-3 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            更早的消息
          </button>
        )}
        {messages.length === 0 && (
          <p className="self-center py-6 text-[12.5px] text-foreground/40">还没有消息，和 {name} 说点什么。</p>
        )}
        {rows.map((r) => (
          <FriendRow key={r.key} time={r.time} m={r.m} mine={r.mine} friend={friend} friendDisplay={name} myName={myName} myUrl={myUrl} selfUid={selfUid} />
        ))}
      </div>
      {friendError !== null && <p className="px-6 pb-2 text-[12px] text-err">{friendError}</p>}
      <WxComposer
        placeholder={`发给 ${name}`}
        onSend={async (text) => {
          await sendDm(text);
          return true;
        }}
      />
    </div>
  );
}

function FriendRow({
  time,
  m,
  mine,
  friend,
  friendDisplay,
  myName,
  myUrl,
}: {
  time: string | null;
  m: ChatMessage;
  mine: boolean;
  friend: FriendProfile;
  friendDisplay: string;
  myName: string;
  myUrl: string;
  selfUid: string;
}) {
  const failed = m.status === "failed";
  // 桌面分享会话的信封：摊开是一坨 JSON（还带一次性的邀请码）。这一版没有本机会话可以导进去，
  // 只写一句它是什么（同列表那一行，dmPreview）
  const text = decodeEnvelope(m.body) !== null ? dmPreview(m.body) : m.body;
  return (
    <>
      {time !== null && <span className="self-center py-0.5 text-[11.5px] text-foreground/40 tabular-nums">{time}</span>}
      <div className={cn("flex max-w-[min(78%,680px)] gap-2.5", mine ? "flex-row-reverse self-end" : "self-start")}>
        {mine ? <WxPerson name={myName} url={myUrl} size={36} /> : <WxPerson name={friendDisplay} url={friend.avatarUrl} size={36} />}
        <div className={cn("flex min-w-0 flex-col gap-0.5", mine ? "items-end" : "items-start")}>
          <div
            className={cn(
              "rounded-[12px] px-3 py-2 text-[14px] leading-[1.6] break-words whitespace-pre-wrap",
              mine ? "rounded-tr-[4px] bg-[color-mix(in_srgb,var(--brand)_18%,var(--card))]" : "rounded-tl-[4px] bg-muted",
              m.status === "sending" && "opacity-60",
              failed && "ring-1 ring-err/50",
            )}
          >
            {text}
          </div>
          {failed && (
            <span className="flex items-center gap-1 px-0.5 text-[11px] text-err">
              <AlertCircle className="size-3" aria-hidden />
              没发出去
            </span>
          )}
        </div>
      </div>
    </>
  );
}
