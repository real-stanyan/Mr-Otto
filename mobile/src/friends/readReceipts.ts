// 朋友私聊的已读回执在手机这一侧（#1442）：
// · 我读到哪了 → mark_friend_read（0049；关了「已读回执」时那个 RPC 自己不写数，这里照常报）。同一位朋友同一条只报一次。
// · 对方读到哪了 → friend_reads 里 reader = 对方、peer = 我 的那一行。进私聊时拉一次，之后 realtime 推
//   （订的是 peer = 我 的那几行：任何一位朋友读了我的消息都推过来）。判据（画在哪、写什么）在 shared/readReceipt.ts。
import { useSyncExternalStore } from "react";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

/** 对方读到我的第几条。没有这一键 = 不知道（对方的 App 不认得已读回执，或者还没拉到）；null = 对方关了 */
const store = createStore<{ reads: ReadonlyMap<string, number | null> }>({ reads: new Map() });

export function usePeerRead(peer: string): number | null | undefined {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return s.reads.has(peer) ? (s.reads.get(peer) ?? null) : undefined;
}

function put(peer: string, v: number | null): void {
  const reads = new Map(store.get().reads);
  reads.set(peer, v);
  store.set({ reads });
}

const reported = new Map<string, number>();
let me: string | null = null;
let channel: ReturnType<typeof supabase.channel> | null = null;

/** 进私聊时拉一次对方那一行 */
export async function loadPeerRead(peer: string): Promise<void> {
  if (me === null) return;
  const { data, error } = await supabase.from("friend_reads").select("last_read_id").eq("reader", peer).eq("peer", me).maybeSingle();
  if (error || data === null) return;
  const v = (data as { last_read_id: number | string | null }).last_read_id;
  put(peer, v === null ? null : Number(v));
}

/** 我读到了对方发来的第 lastId 条（0 = 一条都还没有，也报：有这一行本身就是「我的 App 认得已读回执」） */
export function markFriendRead(peer: string, lastId: number): void {
  if (me === null) return;
  const prev = reported.get(peer);
  if (prev !== undefined && prev >= lastId) return;
  reported.set(peer, lastId);
  void Promise.resolve(supabase.rpc("mark_friend_read", { p_peer: peer, p_last_id: lastId }))
    .then(({ error }) => {
      if (error) reported.delete(peer);
    })
    .catch(() => reported.delete(peer));
}

function adopt(uid: string | null): void {
  if (uid === me) return;
  me = uid;
  reported.clear();
  store.set({ reads: new Map() });
  if (channel !== null) void supabase.removeChannel(channel);
  channel = null;
  if (uid === null) return;
  channel = supabase
    .channel(`friend-reads-${uid}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "friend_reads", filter: `peer=eq.${uid}` }, (p) => {
      const row = p.new as { reader?: string; last_read_id?: number | string | null } | undefined;
      if (row === undefined || typeof row.reader !== "string") return;
      put(row.reader, row.last_read_id === null || row.last_read_id === undefined ? null : Number(row.last_read_id));
    })
    .subscribe();
}

void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_e, session) => adopt(session?.user.id ?? null));
