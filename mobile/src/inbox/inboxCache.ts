// 聊天列表的本机快照（#1471，ADR-0344）：开 App 时先把上一次的列表一次性铺上，再在后台刷新替换——不再一行一行蹦出来。
// 编码 / 解码在 shared/inboxCache.ts（进 vitest）；这里只管：开机读一次、三份同一拍铺上；之后三份任一变了就（防抖）存一份；
// 退出登录清掉这个账号的那一份（本机数据跟着账号走，同聊天页缓存 ADR-0334）。
import AsyncStorage from "expo-sqlite/kv-store";
import { decodeInboxCache, encodeInboxCache, inboxCacheKey } from "../../../src/shared/inboxCache.js";
import type { FriendRow } from "../friends/friendsApi.js";
import { friendsSnapshot, hydrateFriends, onFriendsChange } from "../friends/friendsStore.js";
import { homeSnapshot, hydrateHome, onHomeChange } from "../home/homeStore.js";
import { supabase } from "../supabase.js";
import { hydrateTeams, onTeamsChange, teamsSnapshot } from "./teamsStore.js";

const SAVE_DELAY_MS = 1_000;

let me: string | null = null;
/** 这个账号的快照读过了没有：读完之前不存（不然开机那一刻的空状态会先把好好的快照盖掉） */
let restored = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function restore(uid: string): Promise<void> {
  const raw = await AsyncStorage.getItem(inboxCacheKey(uid)).catch(() => null);
  if (me !== uid) return;
  const data = decodeInboxCache<FriendRow>(raw, uid);
  // 三份同一拍铺上：列表一次出现，不再一份一份到
  if (data !== null) {
    if (data.home !== null) hydrateHome({ selfUid: uid, ...data.home });
    if (data.teams !== null) hydrateTeams(data.teams);
    if (data.friends !== null) hydrateFriends(uid, data.friends);
  }
  restored = true;
}

function save(): void {
  if (me === null || !restored) return;
  const uid = me;
  const h = homeSnapshot();
  const t = teamsSnapshot();
  const f = friendsSnapshot();
  // 只存拉到过的：还在骨架上的那一份写 null（下次就不铺它，照常等网络）
  const raw = encodeInboxCache<FriendRow>(uid, {
    home: h.loaded && h.selfUid === uid && h.home !== null ? { home: h.home, chats: h.chats, lasts: h.lasts } : null,
    teams: t.loaded ? { teams: t.teams, guests: t.guests, mentions: t.mentions } : null,
    friends: f.uid === uid && f.rows !== null ? { rows: f.rows, recent: f.recent } : null,
  }, Date.now());
  void AsyncStorage.setItem(inboxCacheKey(uid), raw).catch(() => undefined);
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    save();
  }, SAVE_DELAY_MS);
}

function adopt(uid: string | null): void {
  if (uid === me) return;
  const prev = me;
  me = uid;
  restored = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  // 退出登录：这个账号的列表不该留在这台手机上
  if (prev !== null && uid === null) void AsyncStorage.removeItem(inboxCacheKey(prev)).catch(() => undefined);
  if (uid !== null) void restore(uid);
}

onHomeChange(schedule);
onTeamsChange(schedule);
onFriendsChange(schedule);
void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_e, session) => adopt(session?.user.id ?? null));
