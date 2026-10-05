// 定时任务（routine，#1283，spec §2）：形状、校验、下一跳、文案——**只此一份**，runtime 算下一跳、
// 手机画「下次」、工具回显都从这里取。零依赖、纯函数：同一组输入永远同一个输出（时区换算走 Intl，
// 不读进程时区——云 runtime 在 VPS 上是 UTC，手机在人手里是哪儿都有可能）。
// 为什么存墙上时间 + IANA 时区而不是 UTC 的 cron：人改时区、夏令时切换，墙上的「九点」都还是九点。

export type RoutineSchedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string };

export type RoutineStatus = "done" | "skipped_quota" | "missed" | "failed";

export interface RoutineRow {
  id: string;
  workspaceId: string;
  agentId: string;
  ownerUid: string;
  title: string;
  instruction: string;
  schedule: RoutineSchedule;
  tz: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: RoutineStatus | null;
  createdBy: "user" | "agent";
  createdAt: number;
  updatedAt: number;
}

export const ROUTINE_TITLE_MAX = 40;
export const ROUTINE_INSTRUCTION_MAX = 2000;
/** 每只**启用中**的任务上限（spec §2.1）。表单与工具两处都查，库里不加触发器 */
export const ROUTINES_ENABLED_MAX = 20;
/** 漏跑宽限（spec §3.4）：daemon 停机期间错过的，一次性任务晚这么久以内照跑，重复任务晚这么久以内照跑 */
export const ROUTINE_ONCE_GRACE_MS = 2 * 3_600_000;
export const ROUTINE_RECURRING_GRACE_MS = 10 * 60_000;
/** 同一任务两次执行至少隔这么久（spec §5.5） */
export const ROUTINE_MIN_GAP_MS = 60_000;
/** routine 轮的圈数硬上限（spec §5.4）：没人在场按停止键 */
export const ROUTINE_MAX_ROUNDS = 40;
/** 跑完 / 错过的一次性任务在列表「已完成」里留这么久再清（spec §3.6） */
export const ROUTINE_KEEP_DONE_MS = 7 * 86_400_000;

export const SCHEDULE_TASK_TOOL_NAME = "schedule_task";
export const LIST_SCHEDULES_TOOL_NAME = "list_schedules";
export const UPDATE_SCHEDULE_TOOL_NAME = "update_schedule";

const WEEKDAY_CN = ["", "一", "二", "三", "四", "五", "六", "日"] as const;

export function isIanaTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || v === "" || v.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const AT_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d)$/;

/** 校验 + 规整（days 去重升序）。不合法抛 Error，文案是给人 / 给模型看的人话 */
export function parseRoutineSchedule(v: unknown): RoutineSchedule {
  if (typeof v !== "object" || v === null) throw new Error("schedule 要是一个对象");
  const o = v as Record<string, unknown>;
  if (o.kind === "once") {
    const m = typeof o.at === "string" ? AT_RE.exec(o.at) : null;
    if (!m || typeof o.at !== "string") throw new Error("once 的 at 要写成 YYYY-MM-DDTHH:mm（墙上时间，不带时区）");
    // 正则放过了 02-30 / 04-31 这类：过一遍 Date.UTC 再比年月日，对不上就是日历上不存在的日子
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() + 1 !== mo || chk.getUTCDate() !== d) throw new Error(`这个日期不存在：${o.at.slice(0, 10)}`);
    return { kind: "once", at: o.at };
  }
  if (o.kind === "daily") {
    if (typeof o.time !== "string" || !TIME_RE.test(o.time)) throw new Error("time 要写成 HH:mm（两位小时，24 小时制）");
    return { kind: "daily", time: o.time };
  }
  if (o.kind === "weekly") {
    if (typeof o.time !== "string" || !TIME_RE.test(o.time)) throw new Error("time 要写成 HH:mm（两位小时，24 小时制）");
    if (!Array.isArray(o.days)) throw new Error("weekly 的 days 要是数组，1 = 周一 … 7 = 周日");
    const days = [...new Set(o.days.map((d) => (typeof d === "number" && Number.isInteger(d) ? d : NaN)))].sort((a, b) => a - b);
    if (days.length === 0) throw new Error("weekly 至少选一天");
    if (days.some((d) => !(d >= 1 && d <= 7))) throw new Error("days 里只能是 1..7（1 = 周一 … 7 = 周日）");
    return { kind: "weekly", days, time: o.time };
  }
  throw new Error("kind 只能是 once / daily / weekly");
}

/** 表单 / 工具共用的整条校验：第一条毛病先说；都好回 null */
export function routineErrors(f: { title: string; instruction: string; schedule: unknown; tz: string }): string | null {
  if (f.title.trim() === "") return "标题不能空";
  if (f.title.length > ROUTINE_TITLE_MAX) return `标题最多 ${ROUTINE_TITLE_MAX} 字`;
  if (f.instruction.trim() === "") return "任务内容不能空";
  if (f.instruction.length > ROUTINE_INSTRUCTION_MAX) return `任务内容最多 ${ROUTINE_INSTRUCTION_MAX} 字`;
  try {
    parseRoutineSchedule(f.schedule);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!isIanaTimeZone(f.tz)) return "时区要是 IANA 名字（比如 Asia/Shanghai）";
  return null;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtOf(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** 这一刻在 tz 里的墙上年月日时分 + ISO 周几（1 = 周一 … 7 = 周日） */
export function zonedParts(ts: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; weekday: number } {
  const parts: Record<string, string> = {};
  for (const p of fmtOf(tz).formatToParts(ts)) parts[p.type] = p.value;
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    // hourCycle h23 下有的引擎仍把午夜格式成 "24"
    hh: Number(parts.hour) % 24, mm: Number(parts.minute), weekday: WD[parts.weekday ?? ""] ?? 0,
  };
}

/** 某个 UTC 时刻在 tz 里的偏移（分钟，东为正） */
function offsetMinutesAt(utcMs: number, tz: string): number {
  const p = zonedParts(utcMs, tz);
  const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return Math.round((asIfUtc - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

/** tz 里的墙上时间 → UTC 毫秒。夏令时两种边角按 ICU / Java 的惯例：
    跳过的那一小时**按跳过的长度后移**（02:30 → 03:30）；重复的那一小时**取先到的那一次**。
    做法：把墙上时间当 UTC 得到 guess，真实时刻在 guess 往前 / 往后至多约 14 小时（偏移范围 -12..+14）。
    在 guess ± 24 小时各取一个偏移（没有哪个时区 48 小时内有两次切换，所以两个探针必然落在切换的两侧或同一侧；
    12 小时不够：+13 的地区真实时刻在 guess - 13h，guess - 12h 可能已经越过切换点），各算一个候选，
    先用「切换前」那个偏移——正常日子两个偏移相同、直接返回；重复时「切换前」的偏移给的是先到的那次；
    跳过时两个候选都对不上墙上时间，返回「切换前」偏移的那个，正好把它后移一个跳跃 */
export function wallClockToUtc(w: { y: number; m: number; d: number; hh: number; mm: number }, tz: string): number {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
  const before = offsetMinutesAt(guess - 24 * 3_600_000, tz);
  const after = offsetMinutesAt(guess + 24 * 3_600_000, tz);
  const a = guess - before * 60_000;
  if (before === after) return a;
  const same = (ts: number): boolean => {
    const p = zonedParts(ts, tz);
    return p.y === w.y && p.m === w.m && p.d === w.d && p.hh === w.hh && p.mm === w.mm;
  };
  if (same(a)) return a;
  const b = guess - after * 60_000;
  return same(b) ? b : a;
}

function parseTime(t: string): { hh: number; mm: number } {
  return { hh: Number(t.slice(0, 2)), mm: Number(t.slice(3, 5)) };
}

/** 从 tz 里的某一天往后数 n 天的年月日（按 UTC 中午做日期算术，不受夏令时影响） */
function addDays(p: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number; weekday: number } {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n, 12));
  const dow = t.getUTCDay(); // 0 = 周日
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: dow === 0 ? 7 : dow };
}

/** 下一次应执行的 UTC 毫秒；`once` 过了 / 没有下一次回 null。**严格大于** afterMs */
export function nextRunAt(schedule: RoutineSchedule, tz: string, afterMs: number): number | null {
  if (schedule.kind === "once") {
    const m = AT_RE.exec(schedule.at);
    if (!m) return null;
    const at = wallClockToUtc({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), hh: Number(m[4]), mm: Number(m[5]) }, tz);
    return at > afterMs ? at : null;
  }
  const { hh, mm } = parseTime(schedule.time);
  const today = zonedParts(afterMs, tz);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(today, i);
    if (schedule.kind === "weekly" && !schedule.days.includes(day.weekday)) continue;
    const cand = wallClockToUtc({ y: day.y, m: day.m, d: day.d, hh, mm }, tz);
    if (cand > afterMs) return cand;
  }
  return null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "2026-10-05 09:00（Asia/Shanghai，周一）" */
export function formatInTz(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}（${tz}，周${WEEKDAY_CN[p.weekday] ?? "?"}）`;
}

/** 列表副行 / 工具回显用的一句话 */
export function scheduleText(schedule: RoutineSchedule, tz: string): string {
  if (schedule.kind === "daily") return `每天 ${schedule.time} · ${tz}`;
  if (schedule.kind === "weekly") return `每周${schedule.days.map((d) => WEEKDAY_CN[d] ?? "?").join("、")} ${schedule.time} · ${tz}`;
  return `${schedule.at.replace("T", " ")} · ${tz}`;
}

/** 到点那一轮的开场白正文（spec §4.1）。时间与时区写在正文里：模型可见的就是已落盘的 */
export function routineOpeningText(o: { title: string; instruction: string; firedAt: number; tz: string }): string {
  return (
    `【定时任务到点】现在是 ${formatInTz(o.firedAt, o.tz)}。\n` +
    `任务：${o.instruction}\n` +
    `按任务去做。要叫我接电话就用 call_user；要打给好友用 call_friend。` +
    // #1612 真机：拨了电话还接着干活，接通时它还「忙」，开场白只能排队，主人拿着电话等它想
    `打电话之前先把要说的想好（写进 opening），拨出去之后这一轮就收口——回一句「已拨」，别接着干别的；接通了你在电话里说。别的事做完在这里说一句结果。`
  );
}

/** 没跑成的那条灰条文案（spec §4.3） */
export function routineNoteText(o: { title: string; reason: "missed" | "skipped_quota"; plannedAt: number; tz: string }): string {
  const when = formatInTz(o.plannedAt, o.tz);
  return o.reason === "missed"
    ? `定时任务「${o.title}」错过了（原定 ${when}，服务那会儿没在线）`
    : `定时任务「${o.title}」这次没跑（原定 ${when}，本周额度快用完了）`;
}
