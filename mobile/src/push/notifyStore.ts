// 推送的开关与免打扰在手机这一侧（#1442）：notify_prefs（四个开关）与 chat_mutes（免打扰的聊天）。
// 直连 Supabase（用户 JWT + RLS：只读写自己的）。判据在 shared/notifyPrefs.ts，runtime 读的是同两张表。
//
// · 读不到 ≠ 全开：prefs 为 null 时设置页那段开关不画（画成「全开」就是在 0049 没跑 / 断网时撒谎），
//   免打扰为 null 时信息页那一行不画；
// · 改动先画上、写失败退回去并说一句（同一个开关来回点不该等网络）；
// · 换号整份清掉重读。
import { useSyncExternalStore } from "react";
import { MUTE_KEY_RE, prefsFromRow, prefsToRow, type NotifyPrefs } from "../../../src/shared/notifyPrefs.js";
import { parseQuietWindow, parseReportPlan, type QuietWindow, type ReportPlan } from "../../../src/shared/quietHours.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

/** 免打扰与汇报（#1569）：notify_prefs 的 quiet / report / tz 三列 */
export interface QuietSettings {
  quiet: QuietWindow | null;
  report: ReportPlan | null;
  tz: string | null;
}

export interface NotifyState {
  prefs: NotifyPrefs | null;
  mutes: ReadonlySet<string> | null;
  /** undefined = 还没读；null = 读不到（0060 没跑 / 断网），那一页说清、不画成能改的样子 */
  quiet: QuietSettings | null | undefined;
  /** 最近一次写失败说的话（设置页 / 信息页底下那一行）。下一次成功清掉 */
  error: string | null;
}

const store = createStore<NotifyState>({ prefs: null, mutes: null, quiet: undefined, error: null });

export function useNotify(): NotifyState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** 这条聊天开着免打扰没有（读不到时当没开：列表照常画数字，不替人藏东西） */
export function isMuted(key: string): boolean {
  return store.get().mutes?.has(key) ?? false;
}

let owner: string | null = null;

async function uid(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

export async function loadNotify(): Promise<void> {
  const me = await uid();
  if (me === null) return;
  const [p, m, q] = await Promise.all([
    supabase.from("notify_prefs").select("agent_reply, mentions, friends, read_receipts").eq("uid", me).maybeSingle(),
    supabase.from("chat_mutes").select("chat_key").eq("uid", me),
    // 免打扰与汇报（#1569）：单独一问——0060 没跑时这一问 42703，别把四个开关一起拖下水
    supabase.from("notify_prefs").select("quiet, report, tz").eq("uid", me).maybeSingle(),
  ]);
  if (owner !== me) return;
  const qrow = q.error ? null : ((q.data ?? {}) as { quiet?: unknown; report?: unknown; tz?: unknown });
  store.set({
    ...(p.error ? {} : { prefs: prefsFromRow(p.data) }),
    ...(m.error ? {} : { mutes: new Set(((m.data ?? []) as { chat_key: string }[]).map((r) => r.chat_key)) }),
    quiet: qrow === null ? null : { quiet: parseQuietWindow(qrow.quiet), report: parseReportPlan(qrow.report), tz: typeof qrow.tz === "string" ? qrow.tz : null },
  });
}

export async function setPref(patch: Partial<NotifyPrefs>): Promise<void> {
  const me = await uid();
  const before = store.get().prefs;
  if (me === null || before === null) return;
  const next = { ...before, ...patch };
  store.set({ prefs: next, error: null });
  const { error } = await supabase.from("notify_prefs").upsert(prefsToRow(me, next), { onConflict: "uid" });
  // 写的这一会儿换了号：退回的是上一个号的值，不能落进这个号的状态里
  if (error && owner === me) store.set({ prefs: before, error: `没存上：${error.message}` });
}

/** 存免打扰与汇报（#1569）：只写这三列 + 把 report_next_at 清空让 runtime 重排。回 ok / 那句话 */
export async function setQuietSettings(next: QuietSettings): Promise<{ ok: true } | { ok: false; message: string }> {
  const me = await uid();
  if (me === null) return { ok: false, message: "还没登录" };
  const { error } = await supabase
    .from("notify_prefs")
    .upsert({ uid: me, quiet: next.quiet, report: next.report, tz: next.tz, report_next_at: null, updated_at: new Date().toISOString() }, { onConflict: "uid" });
  if (error) return { ok: false, message: error.code === "42703" ? "服务器还没准备好这一项（迁移 0060 没跑）" : `没存上：${error.message}` };
  if (owner === me) store.set({ quiet: next, error: null });
  return { ok: true };
}

export async function setMuted(key: string, on: boolean): Promise<void> {
  const me = await uid();
  const before = store.get().mutes;
  if (me === null || before === null || !MUTE_KEY_RE.test(key)) return;
  const next = new Set(before);
  if (on) next.add(key);
  else next.delete(key);
  store.set({ mutes: next, error: null });
  const { error } = on
    ? await supabase.from("chat_mutes").upsert({ uid: me, chat_key: key }, { onConflict: "uid,chat_key" })
    : await supabase.from("chat_mutes").delete().eq("uid", me).eq("chat_key", key);
  if (error && owner === me) store.set({ mutes: before, error: `没存上：${error.message}` });
}

function adopt(next: string | null): void {
  if (next === owner) return;
  owner = next;
  store.set({ prefs: null, mutes: null, quiet: undefined, error: null });
  if (next !== null) void loadNotify().catch(() => undefined);
}

void uid().then(adopt);
supabase.auth.onAuthStateChange((_e, session) => adopt(session?.user.id ?? null));
