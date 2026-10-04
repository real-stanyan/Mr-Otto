// 在这台手机上左滑删掉的聊天（#1566）：键同 InboxRow.key，值 = 删的那一刻它最近一句的时刻。
// 判据在 shared 的 wechatInbox.isHidden：那一刻之后有新的一句才再冒出来（微信语义——删的是列表里这一行，
// 不删聊天记录、不删智能体、不动对方那头）。落 kv-store、**按账号分键**（同 seenStore，ADR-0187）。
import AsyncStorage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

export interface HiddenState {
  /** null = 还没从这台手机上读出来（一律不藏） */
  hidden: ReadonlyMap<string, number> | null;
}

const store = createStore<HiddenState>({ hidden: null });

export function useHidden(): HiddenState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let owner: string | null = null;
const keyOf = (uid: string): string => `otto.wx.hidden.${uid}`;

export function parseHidden(raw: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (raw === null) return out;
  try {
    const o = JSON.parse(raw) as unknown;
    if (o !== null && typeof o === "object") {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out.set(k, v);
      }
    }
  } catch {
    // 读坏了 = 什么都没藏
  }
  return out;
}

async function load(uid: string): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(keyOf(uid));
  } catch {
    // 读不到 = 什么都没藏
  }
  if (owner !== uid) return;
  store.set({ hidden: parseHidden(raw) });
}

function save(): void {
  const uid = owner;
  const hidden = store.get().hidden;
  if (uid === null || hidden === null) return;
  void AsyncStorage.setItem(keyOf(uid), JSON.stringify(Object.fromEntries(hidden))).catch(() => undefined);
}

function adopt(uid: string | null): void {
  if (uid === owner) return;
  owner = uid;
  store.set({ hidden: null });
  if (uid !== null) void load(uid);
}

void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_event, session) => adopt(session?.user.id ?? null));

/** 删掉列表里这一行：记下它此刻最近一句的时刻（ts = 0 的行——还没人说过话——记此刻，不然 0 ≤ 0 永远藏着也无所谓，但一有话就得冒出来） */
export function hideChat(key: string, ts: number): void {
  const cur = store.get().hidden;
  if (cur === null) return;
  const next = new Map(cur);
  next.set(key, ts > 0 ? ts : Date.now());
  store.set({ hidden: next });
  save();
}
