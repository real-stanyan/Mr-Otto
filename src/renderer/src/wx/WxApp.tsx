// WxApp —— 桌面换成微信式布局（#1386 桌面那一半，spec docs/superpowers/specs/2026-09-28-wechat-desktop-design.md）。
//
// 三栏：竖条 64（我 / 聊天 / 通讯录）· 列表 280 · 主区。窗口窄于 1000 时列表收到 240、窄于 760 时 216；
// 窄于 560 才退成一栏（列表与主区轮流占满，主区头部多一颗返回）。
//
// 本机写代码那一半**入口全部藏起来、代码一行不删**（维护者在 #1391 拍板「先藏起来」）：`App()` 过了登录
// 那道闸之后，`OTTO_CODING=1` 时照旧画旧界面，否则只画这里。
//
// 这一层只管「此刻看哪一栏、选中了哪一行、哪扇抽屉开着」；会话、朋友、额度那些事实都在 store 里，
// 列表怎么拼的判据在 shared（wechatInbox，手机同一份）。聊天主区是 `CloudSessionPage` 本体换了一张皮。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ContactRound, MessageCircle, Plus, Sparkles, UserRoundPlus, UsersRound } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer.js";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { useNow } from "../lib/useNow.js";
import { WorkspacePage } from "../components/WorkspacePage.js";
import { AgentSettingsDrawer } from "../components/AgentSettingsDrawer.js";
import { WxPerson } from "./WxAvatar.js";
import { WxBadge, WxSearch } from "./ui.js";
import { useWxInbox } from "./useWxInbox.js";
import { ChatList, ContactList, MeList, type ContactSelection } from "./WxLists.js";
import { WxChatPane } from "./WxChatPane.js";
import { AgentProfilePane, FriendProfilePane, GroupsPane, RequestsPane, useNewGroupDialog } from "./WxContacts.js";
import { MePane, type MeSection } from "./WxMe.js";
import { WxInfoDrawer } from "./WxInfoDrawer.js";
import { useWxDialog, WxDialogHost } from "./WxDialogs.js";
import { WxToaster } from "./toast.js";
import { WxEmptyPane } from "./ui.js";
import { WxFace } from "./WxAvatar.js";
import { rosterGate, rosterRows } from "../../../shared/agentRoster.js";
import { agentFaceSlot } from "../../../shared/agentAvatar.js";
import type { FriendProfile } from "../../../shared/friends.js";
import type { GroupTarget, InboxRow, InboxTarget } from "../../../shared/wechatInbox.js";
import { workspaceAccess } from "../../../shared/workspaceAccess.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

type View = "chats" | "contacts" | "me";

/** 列表多久刷一次（只在窗口看得见时）。桌面窗口一开就是一整天、聚焦着也不会再触发 focus——
    只靠聚焦刷新的话，别的群里来了新消息列表一整天都不动。一次刷新是每个 workspace 两条小查询 */
const INBOX_POLL_MS = 60_000;

export function WxApp() {
  return (
    <WxDialogHost>
      <WxShell />
    </WxDialogHost>
  );
}

function WxShell() {
  const account = useChat((s) => s.account);
  const billing = useChat((s) => s.billing);
  const homeEnsure = useChat((s) => s.homeEnsure);
  const homeError = useChat((s) => s.homeError);
  const ensureHome = useChat((s) => s.ensureHome);
  const refreshInbox = useChat((s) => s.refreshInbox);
  const loadWxSeen = useChat((s) => s.loadWxSeen);
  const wxMarkSeen = useChat((s) => s.wxMarkSeen);
  const loadBilling = useChat((s) => s.loadBilling);
  const fullscreen = useChat((s) => s.fullscreen);
  const workspaceGroups = useChat((s) => s.workspaceGroups);
  const openWorkspaceId = useChat((s) => s.openWorkspaceId);
  const setOpenWorkspaceId = useChat((s) => s.setOpenWorkspaceId);
  const friendsSnapshot = useChat((s) => s.friendsSnapshot);
  const guests = useChat((s) => s.guestChats);
  const lists = useChat((s) => s.cloudSessionList);
  const signOut = useChat((s) => s.signOut);
  const confirm = useConfirm();
  const openDialog = useWxDialog();
  const newGroup = useNewGroupDialog();
  const inbox = useWxInbox();
  const now = useNow(60_000);

  const [view, setView] = useState<View>("chats");
  const [contact, setContact] = useState<ContactSelection | null>(null);
  const [me, setMe] = useState<MeSection | null>(null);
  const [queries, setQueries] = useState<Record<View, string>>({ chats: "", contacts: "", me: "" });
  const [infoOpen, setInfoOpen] = useState(false);
  /** 窄到一栏时此刻是不是在看主区（宽窗时不看它） */
  const [paneShown, setPaneShown] = useState(false);

  const access = workspaceAccess({ signedIn: account.signedIn, billing });
  const gate = rosterGate({ access, home: inbox.home, ensure: homeEnsure });

  // 已读游标按账号读回（换号 = 换一份；登出 = null，一律不画未读）
  useEffect(() => {
    loadWxSeen(account.signedIn ? account.id : null);
  }, [account.signedIn, account.id, loadWxSeen]);

  // 列表那一整份：进来一次、回到窗前一次、看得见时每分钟一次（不在看的时候不打网络）
  useEffect(() => {
    if (!account.signedIn) return undefined;
    const pull = (): void => {
      void refreshInbox();
    };
    pull();
    window.addEventListener("focus", pull);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") pull();
    }, INBOX_POLL_MS);
    return () => {
      window.removeEventListener("focus", pull);
      clearInterval(timer);
    };
  }, [account.signedIn, refreshInbox]);

  // 订阅快照的种子：冷启动那一发推送可能早于这里订阅（同侧栏那枚档位徽章的理由）
  useEffect(() => {
    if (account.signedIn) void loadBilling(false);
  }, [account.signedIn, loadBilling]);

  // 档位带、主场还没有 → 自己去建一次；失败之后不自己反复重试（那张卡上有一颗重试钮）
  useEffect(() => {
    if (gate === "ensuring" && homeEnsure === "idle") void ensureHome();
  }, [gate, homeEnsure, ensureHome]);

  // 开着的那一条：列表不画它的未读，它的最后一句一变就把游标推过去（离开时自然停在最后看到的那一刻）
  const openRow = useMemo(() => inbox.rows.find((r) => r.key === inbox.openKey) ?? null, [inbox.rows, inbox.openKey]);
  useEffect(() => {
    if (openRow !== null && openRow.ts > 0) wxMarkSeen(openRow.key, openRow.ts);
  }, [openRow?.key, openRow?.ts, wxMarkSeen]);

  // 有一条聊天被打开了（点了通知、从资料页点了「发消息」）：切到「聊天」那一栏
  useEffect(() => {
    if (inbox.openKey !== null) {
      setView("chats");
      setPaneShown(true);
    }
  }, [inbox.openKey]);

  const home = inbox.home;

  // ── 打开一条聊天 ──────────────────────────────────────────────────
  const openTarget = useCallback(
    async (t: InboxTarget, title?: string): Promise<void> => {
      const st = useChat.getState();
      setInfoOpen(false);
      setView("chats");
      setPaneShown(true);
      if (t.kind === "friend") {
        const profile = st.friendsSnapshot.friends.find((f) => f.profile.id === t.uid)?.profile;
        if (profile === undefined) return;
        // 桌面同一时刻只画一条：朋友私聊开着时云会话那一路收掉（通话也随之停听，名单还在日志里）
        if (st.cloudSession !== null) st.closeCloudSession();
        if (st.cloudDraftWorkspaceId !== null) st.cancelCloudDraft();
        if (st.friendChat?.id !== profile.id) await st.openFriendChat(profile);
        return;
      }
      if (st.friendChat !== null) st.closeFriendChat();
      if (t.kind === "agent") {
        const h = st.workspaceGroups.find((g) => g.kind === "home") ?? null;
        const sid = h === null ? null : (rosterRows(h, st.cloudSessionList[h.id] ?? []).find((r) => r.agentId === t.agentId)?.sessionId ?? null);
        if (sid !== null && st.cloudSession?.sessionId === sid) return;
        await st.openAgentChat(t.agentId);
        return;
      }
      if (st.cloudSession?.sessionId === t.sessionId) {
        if (st.cloudDraftWorkspaceId !== null) st.cancelCloudDraft();
        return;
      }
      if (t.kind === "group") {
        await st.openGroupChat(t.sessionId);
        return;
      }
      await st.openCloudSession(t.workspaceId, t.sessionId, undefined, title);
    },
    [],
  );

  const openRowTarget = (row: InboxRow): void => {
    void openTarget(row.target, row.title);
  };
  const openGroupTarget = (t: GroupTarget): void => {
    const row = inbox.groups.find((g) => g.target.kind === t.kind && g.target.sessionId === t.sessionId);
    void openTarget(t, row?.title);
  };
  const messageAgent = (agentId: string): void => {
    void openTarget({ kind: "agent", agentId });
  };
  const messageFriend = (f: FriendProfile): void => {
    void openTarget({ kind: "friend", uid: f.id });
  };
  const newAgent = (): void =>
    openDialog({
      kind: "newAgent",
      onCreated: (_agentId, sessionId, name) => {
        const h = useChat.getState().workspaceGroups.find((g) => g.kind === "home") ?? null;
        if (h === null) return;
        setView("chats");
        setPaneShown(true);
        void useChat.getState().openCloudSession(h.id, sessionId, undefined, name);
      },
    });
  const toSubscribe = (): void => {
    setView("me");
    setMe("quota");
    setPaneShown(true);
  };
  const askSignOut = async (): Promise<void> => {
    const ok = await confirm({
      title: "退出登录？",
      description: "只退出这台电脑。智能体和聊天记录都在云上，下次登录还在。",
      confirmLabel: "退出",
      tone: "danger",
    });
    if (ok) await signOut();
  };
  const openAgentProfile = (ws: WorkspaceSnapshot, agentId: string): void => {
    setInfoOpen(false);
    setView("contacts");
    setContact({ type: "agent", workspaceId: ws.id, agentId });
    setPaneShown(true);
  };
  const openFriendProfile = (uid: string): void => {
    setInfoOpen(false);
    setView("contacts");
    setContact({ type: "friend", uid });
    setPaneShown(true);
  };

  const go = (v: View): void => {
    setInfoOpen(false);
    // 窄到一栏时，再点一次当前那一格 = 回到列表
    if (v === view) setPaneShown(false);
    setView(v);
  };

  const query = queries[view];
  const setQuery = (q: string): void => setQueries((cur) => ({ ...cur, [view]: q }));

  // ── 列表那一列 ────────────────────────────────────────────────────
  let column: ReactNode = null;
  if (view === "chats") {
    column = (
      <ChatList
        inbox={inbox}
        query={query}
        gate={gate}
        homeError={homeError}
        now={now}
        onOpen={openRowTarget}
        onSubscribe={toSubscribe}
        onRetryHome={() => void ensureHome()}
      />
    );
  } else if (view === "contacts") {
    column = (
      <ContactList
        inbox={inbox}
        query={query}
        gate={gate}
        homeError={homeError}
        selected={contact}
        onSelect={(c) => {
          setContact(c);
          setPaneShown(true);
        }}
        onNewAgent={newAgent}
        onSubscribe={toSubscribe}
        onRetryHome={() => void ensureHome()}
      />
    );
  } else {
    column = (
      <MeList
        selected={me}
        hasHome={home !== null}
        now={now}
        onSelect={(s) => {
          setMe(s);
          setPaneShown(true);
        }}
        onSignOut={() => void askSignOut()}
      />
    );
  }

  // ── 主区 ──────────────────────────────────────────────────────────
  const back = (): void => setPaneShown(false);
  const emptyPane = <WxEmptyPane face={<WxFace slot={home === null ? 0 : agentFaceSlot(home, "admin")} size={64} />} />;
  let pane: ReactNode = emptyPane;
  if (view === "chats") {
    pane = <WxChatPane onBack={back} onInfo={() => setInfoOpen((o) => !o)} infoOpen={infoOpen} />;
  } else if (view === "contacts" && contact !== null) {
    if (contact.type === "requests") pane = <RequestsPane onBack={back} />;
    else if (contact.type === "groups") {
      pane = (
        <GroupsPane rows={inbox.groups} canCreate={gate === "ready"} onBack={back} onOpen={openGroupTarget} onNewGroup={() => newGroup()} />
      );
    } else if (contact.type === "agent") {
      const ws =
        workspaceGroups.find((g) => g.id === contact.workspaceId) ??
        guests.find((g) => g.ws.id === contact.workspaceId)?.ws ??
        null;
      pane =
        ws === null ? (
          emptyPane
        ) : (
          <AgentProfilePane
            key={`${ws.id}:${contact.agentId}`}
            ws={ws}
            agentId={contact.agentId}
            onBack={back}
            onMessage={messageAgent}
            onNewGroup={(p) => newGroup(p)}
          />
        );
    } else {
      const entry = friendsSnapshot.friends.find((f) => f.profile.id === contact.uid);
      if (entry !== undefined) {
        const together = sharedGroups(contact.uid, home, lists, guests, workspaceGroups, inbox.groups);
        pane = (
          <FriendProfilePane
            key={contact.uid}
            friend={entry.profile}
            friendshipId={entry.friendshipId}
            groups={together}
            canGroup={gate === "ready"}
            onBack={back}
            onMessage={messageFriend}
            onNewGroup={(p) => newGroup(p)}
          />
        );
      }
    }
  } else if (view === "me" && me !== null) {
    pane = <MePane section={me} onBack={back} />;
  }

  const openedWorkspace = workspaceGroups.find((g) => g.id === openWorkspaceId) ?? null;
  const myName = (useChat.getState().myProfile?.name || account.name || account.email).trim();

  return (
    <>
      <div
        className={cn(
          "grid h-screen w-screen overflow-hidden bg-background text-foreground",
          "grid-cols-[64px_280px_minmax(0,1fr)] max-[1000px]:grid-cols-[60px_240px_minmax(0,1fr)]",
          "max-[760px]:grid-cols-[60px_216px_minmax(0,1fr)] max-[560px]:grid-cols-[52px_minmax(0,1fr)]",
        )}
      >
        <WxRail
          view={view}
          fullscreen={fullscreen}
          unreadChats={inbox.unreadChats}
          incoming={inbox.incoming}
          myName={myName}
          onGo={go}
        />
        <section
          aria-label={view === "chats" ? "聊天" : view === "contacts" ? "通讯录" : "我"}
          className={cn(
            "flex min-h-0 min-w-0 flex-col border-r border-foreground/[0.07] bg-sidebar",
            paneShown && "max-[560px]:hidden",
          )}
        >
          <header className="drag-region flex h-[58px] shrink-0 items-center gap-2 px-3">
            <WxSearch value={query} onChange={setQuery} placeholder={view === "contacts" ? "搜索智能体、朋友" : "搜索"} />
            <PlusMenu
              canAgents={gate === "ready"}
              onNewAgent={newAgent}
              onNewGroup={() => newGroup()}
              onAddFriend={() => openDialog({ kind: "addFriend" })}
            />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">{column}</div>
        </section>
        <main className={cn("relative flex min-h-0 min-w-0 flex-col bg-background", !paneShown && "max-[560px]:hidden")}>
          {pane}
        </main>
      </div>
      <WxInfoDrawer
        open={infoOpen && view === "chats"}
        onClose={() => setInfoOpen(false)}
        onOpenAgent={openAgentProfile}
        onOpenFriend={openFriendProfile}
      />
      {/* 团队设置（团队群的聊天信息里「团队设置」那一行开它）：原来那扇抽屉原样，成员 / 智能体 /
          应用 / 文件都在那儿管。开合判据是查得到的那一份（团队被解散时自己关掉） */}
      <Drawer
        open={openedWorkspace !== null}
        onOpenChange={(o) => {
          if (!o) setOpenWorkspaceId(null);
        }}
        direction="right"
        shouldScaleBackground={false}
      >
        <DrawerContent side="right" className="w-[min(420px,92vw)]">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{openedWorkspace?.name ?? "团队"}</DrawerTitle>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <SidebarProvider defaultOpen className="min-h-0 flex-1 flex-col">
              {openedWorkspace && (
                <WorkspacePage ws={openedWorkspace} selfUid={account.id} onBack={() => setOpenWorkspaceId(null)} />
              )}
            </SidebarProvider>
          </div>
        </DrawerContent>
      </Drawer>
      {/* 一只智能体的进阶设置（型号、应用、记忆页）：资料页与聊天信息里「更多设置」开它 */}
      <AgentSettingsDrawer />
      <WxToaster />
    </>
  );
}

/** 一起在的群：主场群里的客人 / 别人拉我进的群里同在 / 同一个团队 */
function sharedGroups(
  uid: string,
  home: WorkspaceSnapshot | null,
  lists: Record<string, readonly { id: string; humans?: readonly { uid: string }[] }[]>,
  guests: readonly { ws: WorkspaceSnapshot; session: { id: string; humans?: readonly { uid: string }[] } }[],
  groups: readonly WorkspaceSnapshot[],
  groupRows: readonly { key: string; title: string }[],
): string[] {
  const titleOf = (key: string): string | null => groupRows.find((g) => g.key === key)?.title ?? null;
  const out: string[] = [];
  if (home !== null) {
    for (const r of lists[home.id] ?? []) {
      if ((r.humans ?? []).some((h) => h.uid === uid)) {
        const t = titleOf(`g:${r.id}`);
        if (t !== null) out.push(t);
      }
    }
  }
  for (const g of guests) {
    if (g.ws.ownerUid === uid || (g.session.humans ?? []).some((h) => h.uid === uid)) {
      const t = titleOf(`j:${g.session.id}`);
      if (t !== null) out.push(t);
    }
  }
  for (const ws of groups) {
    if (ws.kind === "home") continue;
    if (ws.members.some((m) => m.uid === uid)) out.push(ws.name);
  }
  return [...new Set(out)];
}

// ── 竖条 ─────────────────────────────────────────────────────────────

function WxRail({
  view,
  fullscreen,
  unreadChats,
  incoming,
  myName,
  onGo,
}: {
  view: View;
  fullscreen: boolean;
  unreadChats: number;
  incoming: number;
  myName: string;
  onGo: (v: View) => void;
}) {
  const url = useChat((s) => s.myProfile?.avatarUrl || s.account.avatarUrl || "");
  return (
    <nav
      aria-label="主导航"
      className={cn(
        // 上面 48px 留给 macOS 的红绿灯（全屏时没有灯）；整条是拖窗口的地方，按钮自动 no-drag
        "drag-region relative flex min-h-0 flex-col items-center gap-1.5 border-r border-foreground/[0.07] bg-sidebar pb-3.5",
        fullscreen ? "pt-4" : "pt-12 max-[560px]:pt-12",
      )}
    >
      <button
        type="button"
        onClick={() => onGo("me")}
        title="我"
        aria-label="我"
        aria-current={view === "me" ? "page" : undefined}
        className={cn(
          "relative mb-2.5 rounded-[8px] transition-[transform,box-shadow] duration-150 active:scale-[0.95]",
          view === "me" && "ring-2 ring-brand ring-offset-2 ring-offset-sidebar",
        )}
      >
        <WxPerson name={myName} url={url} size={34} />
      </button>
      <RailButton title="聊天" current={view === "chats"} onClick={() => onGo("chats")} badge={unreadChats}>
        <MessageCircle className="size-[22px]" strokeWidth={view === "chats" ? 2.1 : 1.75} aria-hidden />
      </RailButton>
      <RailButton title="通讯录" current={view === "contacts"} onClick={() => onGo("contacts")} badge={incoming}>
        <ContactRound className="size-[22px]" strokeWidth={view === "contacts" ? 2.1 : 1.75} aria-hidden />
      </RailButton>
    </nav>
  );
}

function RailButton({
  title,
  current,
  onClick,
  badge,
  children,
}: {
  title: string;
  current: boolean;
  onClick: () => void;
  badge: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={badge > 0 ? `${title}（${badge}）` : title}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "relative grid size-10 place-items-center rounded-[10px] transition-[background-color,color,transform] duration-150 active:scale-[0.94]",
        current ? "text-brand" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      {children}
      <WxBadge count={badge} className="top-px -right-px" />
    </button>
  );
}

// ── 列表头那颗 ⊕ ─────────────────────────────────────────────────────

function PlusMenu({
  canAgents,
  onNewAgent,
  onNewGroup,
  onAddFriend,
}: {
  canAgents: boolean;
  onNewAgent: () => void;
  onNewGroup: () => void;
  onAddFriend: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="新建"
          aria-label="新建"
          className="grid size-7 shrink-0 place-items-center rounded-md bg-foreground/[0.055] text-foreground transition-[background-color,transform] duration-150 hover:bg-foreground/[0.09] active:scale-[0.94]"
        >
          <Plus className="size-[17px]" strokeWidth={2} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[170px]">
        {canAgents && (
          <>
            <DropdownMenuItem onSelect={onNewAgent}>
              <Sparkles aria-hidden />
              新建智能体
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNewGroup}>
              <UsersRound aria-hidden />
              发起群聊
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={onAddFriend}>
          <UserRoundPlus aria-hidden />
          添加朋友
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
