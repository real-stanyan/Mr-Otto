// 本人资料（#1386，spec §5.8）：profiles 表里我那一行——朋友和群里的人看到的就是这里的名字和头像。
// 改名字 / 换头像走 shared 的 profileEdit（与桌面同一份判据：名字怎么收敛、什么样的头像串能进库），
// RLS 只许改自己那一行（profiles_update_self）。读不到 ≠ 没有：上一份照画。换号清掉。
import { useSyncExternalStore } from "react";
import type { MyProfile, ProfilePatch } from "../../../src/shared/profile.js";
import { buildColumnPatch, toMyProfile, type MyProfileRow } from "../../../src/shared/profileEdit.js";
import { saveTimezone } from "../../../src/shared/supabaseRoutinesApi.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

const COLUMNS = "id,email,name,avatar_url,onboarded_at";

export interface ProfileState {
  me: MyProfile | null;
  loaded: boolean;
  loadError: string | null;
}

const INITIAL: ProfileState = { me: null, loaded: false, loadError: null };
const store = createStore<ProfileState>(INITIAL);
let owner: string | null | undefined;

export function useProfile(): ProfileState {
  return useSyncExternalStore(store.subscribe, store.get);
}

supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user.id ?? null;
  if (owner === undefined) {
    owner = next;
    return;
  }
  if (next === owner) return;
  owner = next;
  store.set(INITIAL);
});

async function uidNow(): Promise<string | null> {
  return (await supabase.auth.getSession()).data.session?.user.id ?? null;
}

export async function refreshProfile(): Promise<void> {
  const uid = await uidNow();
  if (uid === null) return;
  // maybeSingle：profiles 那一行由 auth.users 的触发器建，注册那一瞬间可能还没到——那是「还没有」不是错误
  const res = await supabase.from("profiles").select(COLUMNS).eq("id", uid).maybeSingle();
  if (res.error) {
    store.set({ loadError: res.error.message, loaded: true });
    return;
  }
  const row = res.data as MyProfileRow | null;
  store.set({ me: row === null ? null : toMyProfile(row), loadError: null, loaded: true });
}

let inflight: Promise<void> | null = null;

/** 仓里还没有就拉一份（#1519）：聊天页、群资料页读的是同一个仓，冷启动直接进聊天时没人去过「我」页。
 * 几个屏同时挂上只发一条查询 */
export function ensureProfile(): Promise<void> {
  inflight ??= refreshProfile().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 改名字 / 换头像。校验没过或库里拒了都抛出一句人话，调用方原样显示 */
export async function saveProfile(patch: ProfilePatch): Promise<void> {
  const uid = await uidNow();
  if (uid === null) throw new Error("还没登录");
  const columns = buildColumnPatch(patch, new Date().toISOString());
  if (!columns.ok) throw new Error(columns.message);
  // .eq("id", uid) 不是多余的：没有它是一条全表更新，被 RLS 收成 0 行，然后 single() 报一个与权限无关的错
  const res = await supabase.from("profiles").update(columns.value).eq("id", uid).select(COLUMNS).single();
  if (res.error) throw new Error(res.error.message);
  store.set({ me: toMyProfile(res.data as MyProfileRow), loadError: null, loaded: true });
}

let lastSyncedTz: string | null = null;
/** 设备时区写到账号上（#1283，spec §6.3）：runtime 建任务时 tz 省略就用它。前台时调，变了才写；
    写的是 user_settings（只有本人读得到），不是 profiles——profiles 所有登录用户都能读，出差时区一变就等于报了行踪。
    写失败静默——0057 没跑 / 网络抖，下一次前台再试（lastSyncedTz 只在写成功后记） */
export async function syncDeviceTimezone(): Promise<void> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tz || tz === lastSyncedTz) return;
  const uid = await uidNow();
  if (uid === null) return;
  try {
    await saveTimezone(supabase, uid, tz);
    lastSyncedTz = tz;
  } catch { /* 下次再写 */ }
}
