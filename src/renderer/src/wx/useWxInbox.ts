// useWxInbox —— 「聊天」那一列 + 两个角标（#1386 桌面那一半）。几份 store 状态拼成一份，
// 判据全在 `src/shared/wechatInbox.ts`（手机同一份：mobile/src/inbox/useInbox.ts）。
//
// 桌面比手机多一件事：**开着的那条聊天的最后一句从手上的日志现算**（`liveLastOf`）——库里那一格是
// runtime 3 秒节流写的投影，人正看着时间线时列表那一行不该落后于它。
//
// 这些派生一律在组件里 `useMemo`，**不写进 zustand 的 selector**：它们每次都造新数组，写进
// selector 就是每次渲染都「变了」，而 zustand 走 useSyncExternalStore —— 那是一个真的死循环
// （Maximum update depth exceeded，`unreadMentionCounts` 踩过）。

import { useMemo } from "react";
import { useChat } from "../store.js";
import { homeOf, teamsOf } from "../../../shared/agentRoster.js";
import type { FriendProfile } from "../../../shared/friends.js";
import type { SessionLast } from "../../../shared/sessionLast.js";
import {
  friendThreads, groupList, inboxRows, inboxUnreadChats,
  type GroupListRow, type HomeInput, type InboxRow, type TeamInput,
} from "../../../shared/wechatInbox.js";
import type { CloudSessionListRow } from "../../../shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { liveLastOf, newerLast, openInboxKey } from "../lib/wxInbox.js";

const EMPTY_ROWS: CloudSessionListRow[] = [];
const EMPTY_LASTS: Record<string, SessionLast> = {};

export interface WxInbox {
  selfUid: string;
  home: WorkspaceSnapshot | null;
  teams: WorkspaceSnapshot[];
  rows: InboxRow[];
  /** 有新消息的聊天有几条（竖条角标 / 「聊天(n)」） */
  unreadChats: number;
  /** 此刻开着的那一行的键（它不画未读） */
  openKey: string | null;
  /** 别人加我、还没处理的（通讯录角标 / 「新的朋友」那一格） */
  incoming: number;
  groups: GroupListRow[];
  /** 已经是朋友的那几位 */
  friends: FriendProfile[];
}

export function useWxInbox(): WxInbox {
  const selfUid = useChat((s) => s.account.id);
  const workspaceGroups = useChat((s) => s.workspaceGroups);
  const lists = useChat((s) => s.cloudSessionList);
  const lasts = useChat((s) => s.cloudLasts);
  const guests = useChat((s) => s.guestChats);
  const recentDms = useChat((s) => s.recentDms);
  const snapshot = useChat((s) => s.friendsSnapshot);
  const mentions = useChat((s) => s.workspaceMentions);
  const seen = useChat((s) => s.wxSeen);
  const cloudWs = useChat((s) => s.cloudSession?.workspaceId ?? null);
  const cloudSid = useChat((s) => s.cloudSession?.sessionId ?? null);
  const cloudEvents = useChat((s) => s.cloudSession?.events ?? null);
  const draftWs = useChat((s) => s.cloudDraftWorkspaceId);
  const draftChat = useChat((s) => s.cloudDraftChat);
  const friendUid = useChat((s) => s.friendChat?.id ?? null);

  const home = useMemo(() => homeOf(workspaceGroups), [workspaceGroups]);
  const teams = useMemo(() => teamsOf(workspaceGroups), [workspaceGroups]);
  const homeChats = home === null ? EMPTY_ROWS : (lists[home.id] ?? EMPTY_ROWS);

  const openKey = useMemo(
    () =>
      openInboxKey({
        friendUid,
        draft: draftWs === null ? null : { workspaceId: draftWs, chat: draftChat },
        cloud: cloudWs === null || cloudSid === null ? null : { workspaceId: cloudWs, sessionId: cloudSid },
        home,
        homeChats,
        guests,
      }),
    [friendUid, draftWs, draftChat, cloudWs, cloudSid, home, homeChats, guests],
  );

  // 开着的那条的最后一句：库里那一格与日志现算的取更晚的
  const live = useMemo(() => (cloudEvents === null ? null : liveLastOf(cloudEvents)), [cloudEvents]);
  const lastsOf = useMemo(() => {
    return (workspaceId: string): ReadonlyMap<string, SessionLast> => {
      const base = new Map(Object.entries(lasts[workspaceId] ?? EMPTY_LASTS));
      if (workspaceId === cloudWs && cloudSid !== null) {
        const merged = newerLast(base.get(cloudSid), live);
        if (merged !== undefined) base.set(cloudSid, merged);
      }
      return base;
    };
  }, [lasts, cloudWs, cloudSid, live]);

  const friends = useMemo(() => snapshot.friends.map((f) => f.profile), [snapshot.friends]);
  const threads = useMemo(
    () => friendThreads({ selfUid, friends, messages: recentDms, seen }),
    [selfUid, friends, recentDms, seen],
  );

  const homeInput = useMemo<HomeInput | null>(
    () => (home === null ? null : { ws: home, chats: homeChats, lasts: lastsOf(home.id) }),
    [home, homeChats, lastsOf],
  );
  const teamInputs = useMemo<TeamInput[]>(
    () => teams.map((ws) => ({ ws, sessions: lists[ws.id] ?? EMPTY_ROWS, lasts: lastsOf(ws.id) })),
    [teams, lists, lastsOf],
  );
  // 别人拉我进的群：开着的那条也用日志现算的那一句
  const guestInputs = useMemo(
    () => guests.map((g) => (g.session.id === cloudSid ? { ...g, last: newerLast(g.last ?? undefined, live) ?? null } : g)),
    [guests, cloudSid, live],
  );

  const rows = useMemo(
    () => inboxRows({ selfUid, home: homeInput, teams: teamInputs, guests: guestInputs, friends: threads, mentions, seen, openKey }),
    [selfUid, homeInput, teamInputs, guestInputs, threads, mentions, seen, openKey],
  );
  const groups = useMemo(
    () => groupList({ selfUid, home: homeInput, teams: teamInputs, guests: guestInputs }),
    [selfUid, homeInput, teamInputs, guestInputs],
  );

  return {
    selfUid,
    home,
    teams,
    rows,
    unreadChats: inboxUnreadChats(rows),
    openKey,
    incoming: snapshot.incoming.length,
    groups,
    friends,
  };
}
