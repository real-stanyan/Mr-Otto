// Apple 健康（#1656，spec docs/superpowers/specs/2026-10-05-apple-health-design.md）：runtime 与手机两端共用的那一层。
// 帧里的 query / result 两端都过这里的校验（线上字节永远可能是垃圾）；给模型读的文本与聊天里那一行灰字也在这里，
// 两处的类别名同一张表。只回按天汇总，不回原始样本：数据要落进会话日志（先落盘再喂模型），越少越好，也省 token。

/** 工具名（两端共用：runtime 注册它，手机聊天流按它认出那一行） */
export const READ_HEALTH_TOOL = "read_health";

export const HEALTH_METRICS = [
  "steps", "distance", "activeEnergy", "flights", "exerciseMinutes", "standHours",
  "sleep",
  "heartRate", "restingHeartRate", "hrv", "spo2",
  "bodyMass", "bodyFat",
  "workouts",
] as const;
export type HealthMetric = (typeof HEALTH_METRICS)[number];

export const HEALTH_MAX_SPAN_DAYS = 92;
export const HEALTH_RESULT_MAX_BYTES = 64 * 1024;

/** from / to：手机本地日历的日期，闭区间 */
export interface HealthQuery { metrics: HealthMetric[]; from: string; to: string }

export interface HealthSleep { inBedMin?: number; asleepMin?: number; coreMin?: number; deepMin?: number; remMin?: number; awakeMin?: number }
export interface HealthDay {
  date: string;
  steps?: number; distanceM?: number; activeKcal?: number; flights?: number; exerciseMin?: number; standHours?: number;
  /** 算在醒来那天 */
  sleep?: HealthSleep;
  heartRate?: { min: number; avg: number; max: number };
  restingHeartRate?: number;
  /** SDNN 当天平均，毫秒 */
  hrv?: number;
  /** 百分比 0–100 */
  spo2?: { min: number; avg: number };
  bodyMassKg?: number; bodyFatPct?: number;
}
export interface HealthWorkout {
  /** ISO 8601，带偏移 */
  start: string; end: string;
  type: string;
  durationMin: number; distanceM?: number; activeKcal?: number;
}
export type HealthResult =
  | { ok: true; days: HealthDay[]; workouts: HealthWorkout[] }
  | { ok: false; error: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD → UTC 零点毫秒；不是真实存在的日期回 null（2 月 30 日之类） */
function dayMs(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = DATE_RE.exec(s);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}

const isMetric = (x: unknown): x is HealthMetric => typeof x === "string" && (HEALTH_METRICS as readonly string[]).includes(x);

export function parseHealthQuery(x: unknown): HealthQuery | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.metrics) || o.metrics.length === 0 || !o.metrics.every(isMetric)) return null;
  const from = dayMs(o.from);
  const to = dayMs(o.to);
  if (from === null || to === null || from > to) return null;
  // 闭区间的天数（含两头）不超过 92
  if ((to - from) / 86_400_000 + 1 > HEALTH_MAX_SPAN_DAYS) return null;
  return { metrics: [...new Set(o.metrics as HealthMetric[])], from: o.from as string, to: o.to as string };
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** 可选数字格：缺席 = 不放；在场但不是有限数 = 整份作废（返回 false） */
function copyNums<T extends object>(src: Record<string, unknown>, keys: readonly string[], out: T): boolean {
  for (const k of keys) {
    if (src[k] === undefined) continue;
    if (!num(src[k])) return false;
    (out as Record<string, unknown>)[k] = src[k];
  }
  return true;
}

function parseDay(x: unknown): HealthDay | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (dayMs(o.date) === null) return null;
  const day: HealthDay = { date: o.date as string };
  if (!copyNums(o, ["steps", "distanceM", "activeKcal", "flights", "exerciseMin", "standHours", "restingHeartRate", "hrv", "bodyMassKg", "bodyFatPct"], day)) return null;
  if (o.sleep !== undefined) {
    if (typeof o.sleep !== "object" || o.sleep === null) return null;
    const sleep: HealthSleep = {};
    if (!copyNums(o.sleep as Record<string, unknown>, ["inBedMin", "asleepMin", "coreMin", "deepMin", "remMin", "awakeMin"], sleep)) return null;
    day.sleep = sleep;
  }
  if (o.heartRate !== undefined) {
    const h = o.heartRate as Record<string, unknown> | null;
    if (typeof h !== "object" || h === null || !num(h.min) || !num(h.avg) || !num(h.max)) return null;
    day.heartRate = { min: h.min, avg: h.avg, max: h.max };
  }
  if (o.spo2 !== undefined) {
    const s = o.spo2 as Record<string, unknown> | null;
    if (typeof s !== "object" || s === null || !num(s.min) || !num(s.avg)) return null;
    day.spo2 = { min: s.min, avg: s.avg };
  }
  return day;
}

function parseWorkout(x: unknown): HealthWorkout | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.start !== "string" || typeof o.end !== "string" || typeof o.type !== "string" || !num(o.durationMin)) return null;
  const w: HealthWorkout = { start: o.start, end: o.end, type: o.type, durationMin: o.durationMin };
  if (!copyNums(o, ["distanceM", "activeKcal"], w)) return null;
  return w;
}

export function parseHealthResult(x: unknown): HealthResult | null {
  if (typeof x !== "object" || x === null) return null;
  if (new TextEncoder().encode(JSON.stringify(x)).byteLength > HEALTH_RESULT_MAX_BYTES) return null;
  const o = x as Record<string, unknown>;
  if (o.ok === false) return typeof o.error === "string" ? { ok: false, error: o.error } : null;
  if (o.ok !== true || !Array.isArray(o.days) || !Array.isArray(o.workouts)) return null;
  const days: HealthDay[] = [];
  for (const d of o.days) {
    const p = parseDay(d);
    if (p === null) return null;
    days.push(p);
  }
  const workouts: HealthWorkout[] = [];
  for (const w of o.workouts) {
    const p = parseWorkout(w);
    if (p === null) return null;
    workouts.push(p);
  }
  return { ok: true, days, workouts };
}

const METRIC_LABEL: Record<HealthMetric, string> = {
  steps: "步数", distance: "距离", activeEnergy: "活动能量", flights: "爬楼", exerciseMinutes: "锻炼时长", standHours: "站立",
  sleep: "睡眠", heartRate: "心率", restingHeartRate: "静息心率", hrv: "HRV", spo2: "血氧",
  bodyMass: "体重", bodyFat: "体脂", workouts: "体能训练",
};
/** 每个 metric 落在 HealthDay 的哪一格（workouts 不在 day 上） */
const DAY_KEY: Record<Exclude<HealthMetric, "workouts">, keyof HealthDay> = {
  steps: "steps", distance: "distanceM", activeEnergy: "activeKcal", flights: "flights", exerciseMinutes: "exerciseMin",
  standHours: "standHours", sleep: "sleep", heartRate: "heartRate", restingHeartRate: "restingHeartRate", hrv: "hrv",
  spo2: "spo2", bodyMass: "bodyMassKg", bodyFat: "bodyFatPct",
};

function dur(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}小时${m % 60}分` : `${m}分`;
}
const r0 = (n: number): number => Math.round(n);
const r1 = (n: number): number => Math.round(n * 10) / 10;

function sleepText(s: HealthSleep): string | null {
  const stages = [
    ["深睡", s.deepMin], ["REM", s.remMin], ["核心", s.coreMin], ["清醒", s.awakeMin],
  ].filter((p): p is [string, number] => p[1] !== undefined).map(([l, v]) => `${l} ${dur(v)}`);
  const tail = stages.length > 0 ? `（${stages.join(" · ")}）` : "";
  if (s.asleepMin !== undefined) return `睡眠 ${dur(s.asleepMin)}${tail}`;
  if (s.inBedMin !== undefined) return `卧床 ${dur(s.inBedMin)}${tail}`;
  return stages.length > 0 ? `睡眠${tail}` : null;
}

function dayLine(d: HealthDay): string {
  const parts: string[] = [];
  if (d.steps !== undefined) parts.push(`步数 ${r0(d.steps)}`);
  if (d.distanceM !== undefined) parts.push(`距离 ${r1(d.distanceM / 1000)}km`);
  if (d.activeKcal !== undefined) parts.push(`活动能量 ${r0(d.activeKcal)}kcal`);
  if (d.flights !== undefined) parts.push(`爬楼 ${r0(d.flights)}层`);
  if (d.exerciseMin !== undefined) parts.push(`锻炼 ${r0(d.exerciseMin)}分钟`);
  if (d.standHours !== undefined) parts.push(`站立 ${r0(d.standHours)}小时`);
  if (d.sleep !== undefined) {
    const t = sleepText(d.sleep);
    if (t !== null) parts.push(t);
  }
  if (d.heartRate !== undefined) parts.push(`心率 ${r0(d.heartRate.min)}–${r0(d.heartRate.max)}（平均 ${r0(d.heartRate.avg)}）`);
  if (d.restingHeartRate !== undefined) parts.push(`静息心率 ${r0(d.restingHeartRate)}`);
  if (d.hrv !== undefined) parts.push(`HRV ${r0(d.hrv)}ms`);
  if (d.spo2 !== undefined) parts.push(`血氧 平均 ${r1(d.spo2.avg)}%（最低 ${r1(d.spo2.min)}%）`);
  if (d.bodyMassKg !== undefined) parts.push(`体重 ${r1(d.bodyMassKg)}kg`);
  if (d.bodyFatPct !== undefined) parts.push(`体脂 ${r1(d.bodyFatPct)}%`);
  return `${d.date}：${parts.join("；")}`;
}

function workoutLine(w: HealthWorkout): string {
  const parts = [`${w.start.slice(0, 10)} ${w.start.slice(11, 16)}–${w.end.slice(11, 16)}`, w.type, `${r0(w.durationMin)}分钟`];
  if (w.distanceM !== undefined) parts.push(`${r1(w.distanceM / 1000)}km`);
  if (w.activeKcal !== undefined) parts.push(`${r0(w.activeKcal)}kcal`);
  return parts.join(" ");
}

/** 给模型读的文本：表头 → 每天一行（只列有值的格）→ 训练 → 请求了却整段全空的类别 */
export function formatHealthForModel(q: HealthQuery, r: Extract<HealthResult, { ok: true }>): string {
  const lines = [`Apple 健康 · ${q.from} 至 ${q.to}（用户手机本地日历，按天汇总）`];
  for (const d of r.days) {
    const line = dayLine(d);
    if (!line.endsWith("：")) lines.push(line);
  }
  if (r.workouts.length > 0) {
    lines.push("训练：");
    for (const w of r.workouts) lines.push(workoutLine(w));
  }
  const missing = q.metrics.filter((m) =>
    m === "workouts" ? r.workouts.length === 0 : !r.days.some((d) => d[DAY_KEY[m]] !== undefined),
  );
  if (missing.length > 0) lines.push(`以下类别在这段时间没有数据（可能没授权，也可能没记录）：${missing.map((m) => METRIC_LABEL[m]).join("、")}`);
  return lines.join("\n");
}

/** 手机收到 health_query 时的应答：开关关着不读；原生读出来的东西再过一遍校验（原生也可能给出垃圾） */
export async function answerHealthQuery(
  q: HealthQuery,
  deps: { enabled: () => boolean; read: (q: HealthQuery) => Promise<unknown> },
): Promise<HealthResult> {
  if (!deps.enabled()) return { ok: false, error: "用户在手机上关掉了 Apple 健康" };
  try {
    const raw = await deps.read(q);
    const parsed = typeof raw === "object" && raw !== null ? parseHealthResult({ ok: true, ...raw }) : null;
    return parsed ?? { ok: false, error: "手机读出来的数据格式不对" };
  } catch (e) {
    return { ok: false, error: `手机读健康数据出错：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 聊天里那一行灰字的类别分组（同 iOS「健康」App 的大类） */
const GROUP_OF: Record<HealthMetric, string> = {
  steps: "活动", distance: "活动", activeEnergy: "活动", flights: "活动", exerciseMinutes: "活动", standHours: "活动",
  sleep: "睡眠",
  heartRate: "心脏", restingHeartRate: "心脏", hrv: "心脏", spo2: "心脏",
  bodyMass: "身体测量", bodyFat: "身体测量",
  workouts: "体能训练",
};

const md = (s: string): string => `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日`;

/** 「读取了健康数据：睡眠、心脏 · 9月28日–10月4日」。参数读不懂只说读了，不编 */
export function healthReadLineText(args: unknown, status: "ok" | "error" | "denied"): string {
  if (status !== "ok") return "没读到健康数据";
  const q = parseHealthQuery(args);
  if (q === null) return "读取了健康数据";
  const groups = [...new Set(q.metrics.map((m) => GROUP_OF[m]))].join("、");
  const range = q.from === q.to ? md(q.from) : `${md(q.from)}–${md(q.to)}`;
  return `读取了健康数据：${groups} · ${range}`;
}
