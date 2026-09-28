// 「聊天」页签那一列 + 两个页签的角标（#1386）：四份数据（主场、团队、朋友、已读游标）拼成一份，判据在 shared 的 wechatInbox。
import { useMemo } from "react";
import type { FriendProfile } from "../../../src/shared/friends.js";
import { friendThreads, inboxRows, inboxUnreadChats, type FriendThread, type InboxRow } from "../../../src/shared/wechatInbox.js";
import { useFriends } from "../friends/friendsStore.js";
import { useHome } from "../home/homeStore.js";
import { useSeenStore } from "./seenStore.js";
import { useTeams } from "./teamsStore.js";

export interface Inbox {
  selfUid: string;
  rows: InboxRow[];
  /** 有新消息的聊天有几条（页签角标 / 「聊天(n)」） */
  unreadChats: number;
  threads: FriendThread[];
  /** 别人加我、还没处理的（通讯录角标 / 「新的朋友」那一格） */
  incoming: number;
  loaded: boolean;
}

export function useInbox(): Inbox {
  const home = useHome();
  const teams = useTeams();
  const friends = useFriends();
  const { seen, openKey } = useSeenStore();
  const selfUid = home.selfUid ?? friends.uid ?? "";
  const accepted = useMemo<FriendProfile[]>(
    () => (friends.rows ?? []).filter((r) => r.status === "accepted").map((r) => r.profile),
    [friends.rows],
  );
  const threads = useMemo(
    () => friendThreads({ selfUid, friends: accepted, messages: friends.recent, seen }),
    [selfUid, accepted, friends.recent, seen],
  );
  const rows = useMemo(
    () =>
      inboxRows({
        selfUid,
        home: home.home === null ? null : { ws: home.home, chats: home.chats, lasts: home.lasts },
        teams: teams.teams,
        guests: teams.guests,
        friends: threads,
        mentions: teams.mentions,
        seen,
        openKey,
      }),
    [selfUid, home.home, home.chats, home.lasts, teams.teams, teams.guests, teams.mentions, threads, seen, openKey],
  );
  const incoming = (friends.rows ?? []).filter((r) => r.status === "pending" && r.direction === "incoming").length;
  return { selfUid, rows, unreadChats: inboxUnreadChats(rows), threads, incoming, loaded: home.loaded && teams.loaded };
}
