// 这台手机上「看过了」的游标 + 草稿 + 此刻开着哪一条（#1386，spec §3.1）。
//
// · 游标落 kv-store、**按账号分键**：换个号登录，不该拿上一个人的已读去算这个人的未读（ADR-0187 本机数据跟着账号走）。
//   第一次（或读坏了）用此刻当 baseline——一装上满屏都是未读是最坏的那种开场。写盘攒 400ms 一次：
//   聊天页开着时每来一句都会推一次游标。
// · 草稿只在内存里：杀掉 app 就没了（微信也是这样；落盘要解决「换号之后这句草稿归谁」，不值当）。
// · 开着的那一条不画未读（人正看着它），离开时把游标推到那一刻。
import AsyncStorage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { markSeen as advance, parseSeen, serializeSeen, type SeenState } from "../../../src/shared/wechatInbox.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

export interface SeenStoreState {
  /** null = 还没从这台手机上读出来（一律不画未读） */
  seen: SeenState | null;
  drafts: ReadonlyMap<string, string>;
  openKey: string | null;
}

const store = createStore<SeenStoreState>({ seen: null, drafts: new Map(), openKey: null });

export function useSeenStore(): SeenStoreState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let owner: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (uid: string): string => `otto.wx.seen.${uid}`;

async function load(uid: string): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(keyOf(uid));
  } catch {
    // 读不到 = 从此刻重新开始
  }
  if (owner !== uid) return;
  const seen = parseSeen(raw) ?? { baselineTs: Date.now(), marks: new Map<string, number>() };
  store.set({ seen });
  if (raw === null) scheduleSave();
}

function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const uid = owner;
    const seen = store.get().seen;
    if (uid === null || seen === null) return;
    void AsyncStorage.setItem(keyOf(uid), serializeSeen(seen)).catch(() => undefined);
  }, 400);
}

function adopt(uid: string | null): void {
  if (uid === owner) return;
  owner = uid;
  store.set({ seen: null, drafts: new Map(), openKey: null });
  if (uid !== null) void load(uid);
}

void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_event, session) => adopt(session?.user.id ?? null));

/** 看过了这一条，看到 ts 那一刻（只往前走，shared 的 markSeen） */
export function markSeen(key: string, ts: number): void {
  const seen = store.get().seen;
  if (seen === null) return;
  const next = advance(seen, key, ts);
  if (next === seen) return;
  store.set({ seen: next });
  scheduleSave();
}

/** 此刻开着的那一条（推送那侧要：人正看着这条就不弹，#1442） */
export function openKeyNow(): string | null {
  return store.get().openKey;
}

export function setOpenKey(key: string | null): void {
  if (store.get().openKey !== key) store.set({ openKey: key });
}

export function draftOf(key: string): string {
  return store.get().drafts.get(key) ?? "";
}

export function setDraft(key: string, text: string): void {
  const cur = store.get().drafts;
  const t = text.trim() === "" ? "" : text;
  if ((cur.get(key) ?? "") === t) return;
  const drafts = new Map(cur);
  if (t === "") drafts.delete(key);
  else drafts.set(key, t);
  store.set({ drafts });
}
