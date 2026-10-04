// 好友在线状态在手机这一侧（#1460，ADR-0339）：
// · 报自己的：App 在前台时立刻报一次在线、之后每 60 秒一次（touch_presence(true)）；切到后台报一次不在线。
//   被杀掉 / 断网时报不了，对方那边靠心跳过期判（shared/presence.ts）。
// · 读朋友的：presence 表（RLS 只给本人与已接受的好友看）。登录、回到前台各拉一次，之后 realtime 推。
// 判据（在不在线、没报过就不画点）在 shared/presence.ts。
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { PRESENCE_BEAT_MS, presenceFromRow, presenceOf, type Presence, type PresenceRow } from "../../../src/shared/presence.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";
import { useNow } from "../ui.js";

const store = createStore<{ rows: ReadonlyMap<string, PresenceRow> }>({ rows: new Map() });

/** 这位朋友此刻在不在线。null = 不知道（不画点）。30 秒重判一次心跳过期 */
export function usePresence(uid: string): Presence | null {
  const s = useSyncExternalStore(store.subscribe, store.get);
  const now = useNow(30_000);
  return presenceOf(s.rows.get(uid), now);
}

function put(row: PresenceRow): void {
  const rows = new Map(store.get().rows);
  rows.set(row.uid, row);
  store.set({ rows });
}

let me: string | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let channel: ReturnType<typeof supabase.channel> | null = null;

function touch(online: boolean): void {
  if (me === null) return;
  void Promise.resolve(supabase.rpc("touch_presence", { p_online: online })).catch(() => undefined);
}

function startBeat(): void {
  if (beat !== null || me === null) return;
  touch(true);
  beat = setInterval(() => touch(true), PRESENCE_BEAT_MS);
}

function stopBeat(online: boolean): void {
  if (beat !== null) clearInterval(beat);
  beat = null;
  if (!online) touch(false);
}

async function loadAll(): Promise<void> {
  if (me === null) return;
  const mine = me;
  const { data, error } = await supabase.from("presence").select("uid, online, seen_at");
  if (error || mine !== me) return;
  const rows = new Map<string, PresenceRow>();
  for (const raw of (data ?? []) as unknown[]) {
    const r = presenceFromRow(raw);
    if (r !== null) rows.set(r.uid, r);
  }
  store.set({ rows });
}

/** 退出登录前报一次不在线（SettingsScreen 在 signOut 之前调；登出之后 session 没了，再报就报不上了） */
export async function goOffline(): Promise<void> {
  if (beat !== null) clearInterval(beat);
  beat = null;
  if (me === null) return;
  await Promise.race([
    Promise.resolve(supabase.rpc("touch_presence", { p_online: false })).catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, 2_000)),
  ]);
}

function adopt(uid: string | null): void {
  if (uid === me) return;
  // 换号 / 退出时 session 已经是新的了：这里只停心跳，不替上一个号报（那一句会落到新号头上）
  if (beat !== null) clearInterval(beat);
  beat = null;
  me = uid;
  store.set({ rows: new Map() });
  if (channel !== null) void supabase.removeChannel(channel);
  channel = null;
  if (uid === null) return;
  channel = supabase
    .channel(`presence-${uid}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, (p) => {
      const r = presenceFromRow(p.new);
      if (r !== null) put(r);
    })
    .subscribe();
  void loadAll();
  if (AppState.currentState === "active") startBeat();
}

void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_e, session) => adopt(session?.user.id ?? null));
AppState.addEventListener("change", (s) => {
  if (s === "active") {
    startBeat();
    void loadAll();
  } else if (s === "background") stopBeat(false);
});
