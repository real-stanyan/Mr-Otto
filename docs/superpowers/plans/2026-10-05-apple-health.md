# Apple 健康按需读取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 云端智能体能调 `read_health`，经 relay 让说话人自己那台开着 Otto 的 iPhone 读 HealthKit（按天聚合）并回传。

**Architecture:** 手机发 `caps{health}` 帧声明能力；runtime 的 `healthBroker` 记「哪条 cid 能读健康」并负责 `health_query` → `health_result` 的定向往返（30 s 超时 / 断开 / abort）；`read_health` 工具只在「人亲口发起、非接力、非定时、非汇报、主场里限主人」的轮里、且发起人此刻有能力连接时出现，调用时现选 cid。结果走普通 `tool_result` 落盘。手机侧是新 Expo 本地模块 `otto-health`（Swift/HealthKit）+ 设置页开关；聊天流复用 `note` 行画一行灰字。

**Tech Stack:** TypeScript strict / vitest / Expo SDK 57 本地模块（Swift 5.9, iOS 16.4, HealthKit）/ React Native。

**Spec:** `docs/superpowers/specs/2026-10-05-apple-health-design.md`（Issue #1656）

## Global Constraints

- 协议版本 `CS_PROTOCOL_VERSION` 28 → **29**（若合并前 main 已被别人升到 29，则改 30，所有钉子测试一起改）。
- 查询跨度上限 **92 天**（闭区间，from ≤ to）；结果上限 **64 KB**（`HEALTH_RESULT_MAX_BYTES = 64 * 1024`，按 UTF-8 字节）。
- runtime 等手机回帧 **30 秒**（`HEALTH_TIMEOUT_MS = 30_000`）。
- 工具名 `read_health`（常量 `READ_HEALTH_TOOL_NAME`）。
- metrics 枚举（顺序固定）：`steps, distance, activeEnergy, flights, exerciseMinutes, standHours, sleep, heartRate, restingHeartRate, hrv, spo2, bodyMass, bodyFat, workouts`。
- 只读 HealthKit，`toShare` 为空；`app.json` 只加 `NSHealthShareUsageDescription`，不加 Update 那条。
- 手机 runtimeVersion `"6"` → `"7"`（`mobile/app.json`）；`mobile/native-build.json` **不在本计划里改**（打 TestFlight 那一步改，上传前问维护者）。
- Hard rule：工具只依赖 `ExecutionWorld`/注入的端口，不 import fs / child_process；先落盘再喂模型（结果只经 `tool_result` 进模型）。
- 测试放 `tests/`，镜像 `src/` / `services/` 结构。
- 代码里写 NUL 一律 `String.fromCharCode(0)`（本计划不需要）。
- 每个 Task 结束跑 `npx vitest run <该 task 的测试文件>`；全部结束跑门禁 `npm test`。
- worktree 跑测试前确认 `node_modules` 在（本 worktree 已有）；跑 `npm test` 前 `mobile/node_modules` 要在（缺就 `npm --prefix mobile ci`）。
- commit message 结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，正文写为什么。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/shared/health.ts`（新） | 两端共用：类型、`parseHealthQuery` / `parseHealthResult`、给模型的 `formatHealthForModel`、手机侧 `answerHealthQuery`、聊天灰字 `healthReadLineText` |
| `src/shared/remote/cloudSession.ts` | 三种新帧 + 协议号 29 |
| `services/runtime/src/healthBroker.ts`（新） | 能力表 + 定向请求往返（纯逻辑，send 注入） |
| `services/runtime/src/frameHandler.ts` | `caps` / `health_result` 两帧接到 broker；`onGone` 通知 broker |
| `services/runtime/src/healthTool.ts`（新） | `read_health` 工具 + 资格判据 `healthTurnEligible` |
| `services/runtime/src/sessionService.ts` | `CloudSessionOpts.health?`、`healthTurn` 旗、工具表接入 |
| `services/runtime/src/daemon.ts` | 建 broker，接进 frameHandler 与每条会话 |
| `src/shared/remote/cloudSessionClient.ts` | `deviceCaps` / `onHealthQuery` 两个可选 dep + `refreshCaps()` |
| `src/shared/mobileChat.ts` | `read_health` 的结果画成一行 `note` |
| `mobile/modules/otto-health/*`（新） | Swift HealthKit 读取 + JS 门面 |
| `mobile/src/health/healthPrefs.ts`（新） | 开关状态（kv-store）+ 变更订阅 + 读数入口 |
| `mobile/src/cloud/cloudClient.ts` / `mobile/src/account/SettingsScreen.tsx` / `mobile/App.tsx` / `mobile/app.json` | 接线、开关、权限文案、runtimeVersion |
| `docs/adr/NNNN-device-executed-tool-channel.md`（新）、`docs/where-to-find-things.md`、`CONTEXT.md` | 决策与索引 |

---

### Task 1: 共享健康模块 `src/shared/health.ts`

**Files:**
- Create: `src/shared/health.ts`
- Test: `tests/shared/health.test.ts`

**Interfaces:**
- Produces（后续所有 task 用）：
  - `READ_HEALTH_TOOL = "read_health"`（两端共用的工具名：runtime 注册它，手机聊天流按它认；src 不 import services）
  - `HEALTH_METRICS`, `type HealthMetric`, `HEALTH_MAX_SPAN_DAYS = 92`, `HEALTH_RESULT_MAX_BYTES = 64 * 1024`
  - `interface HealthQuery { metrics: HealthMetric[]; from: string; to: string }`
  - `interface HealthDay`, `interface HealthWorkout`, `type HealthResult = { ok: true; days: HealthDay[]; workouts: HealthWorkout[] } | { ok: false; error: string }`
  - `parseHealthQuery(x: unknown): HealthQuery | null`
  - `parseHealthResult(x: unknown): HealthResult | null`
  - `formatHealthForModel(q: HealthQuery, r: Extract<HealthResult, { ok: true }>): string`
  - `answerHealthQuery(q: HealthQuery, deps: { enabled: () => boolean; read: (q: HealthQuery) => Promise<unknown> }): Promise<HealthResult>`
  - `healthReadLineText(args: unknown, status: "ok" | "error" | "denied"): string`

- [ ] **Step 1: 写失败测试** `tests/shared/health.test.ts`

```ts
// Apple 健康（#1656）两端共用的那一层：查询 / 结果的校验、给模型读的文本、手机侧应答、聊天里那一行灰字。
import { describe, expect, it } from "vitest";
import {
  answerHealthQuery, formatHealthForModel, healthReadLineText, parseHealthQuery, parseHealthResult,
  HEALTH_RESULT_MAX_BYTES, type HealthQuery,
} from "../../src/shared/health.js";

describe("parseHealthQuery", () => {
  it("合法：去重、保序", () => {
    expect(parseHealthQuery({ metrics: ["sleep", "steps", "sleep"], from: "2026-09-28", to: "2026-10-04" }))
      .toEqual({ metrics: ["sleep", "steps"], from: "2026-09-28", to: "2026-10-04" });
  });
  it("同一天可以", () => {
    expect(parseHealthQuery({ metrics: ["steps"], from: "2026-10-05", to: "2026-10-05" })).not.toBeNull();
  });
  it.each([
    ["空 metrics", { metrics: [], from: "2026-10-01", to: "2026-10-02" }],
    ["未知 metric", { metrics: ["mood"], from: "2026-10-01", to: "2026-10-02" }],
    ["metrics 不是数组", { metrics: "steps", from: "2026-10-01", to: "2026-10-02" }],
    ["坏日期格式", { metrics: ["steps"], from: "2026-1-01", to: "2026-10-02" }],
    ["不存在的日期", { metrics: ["steps"], from: "2026-02-30", to: "2026-03-02" }],
    ["from > to", { metrics: ["steps"], from: "2026-10-03", to: "2026-10-02" }],
    ["跨度 93 天", { metrics: ["steps"], from: "2026-01-01", to: "2026-04-03" }],
    ["不是对象", null],
  ])("拒：%s", (_name, x) => {
    expect(parseHealthQuery(x)).toBeNull();
  });
  it("跨度正好 92 天可以", () => {
    expect(parseHealthQuery({ metrics: ["steps"], from: "2026-01-01", to: "2026-04-02" })).not.toBeNull();
  });
});

describe("parseHealthResult", () => {
  it("ok：只留认识的字段", () => {
    const r = parseHealthResult({
      ok: true,
      days: [{ date: "2026-10-04", steps: 8231, junk: 1, sleep: { asleepMin: 420, deepMin: 65, extra: 3 }, heartRate: { min: 50, avg: 70, max: 140 } }],
      workouts: [{ start: "2026-10-04T08:02:00+08:00", end: "2026-10-04T08:41:00+08:00", type: "running", durationMin: 39, distanceM: 6200, activeKcal: 410, junk: true }],
    });
    expect(r).toEqual({
      ok: true,
      days: [{ date: "2026-10-04", steps: 8231, sleep: { asleepMin: 420, deepMin: 65 }, heartRate: { min: 50, avg: 70, max: 140 } }],
      workouts: [{ start: "2026-10-04T08:02:00+08:00", end: "2026-10-04T08:41:00+08:00", type: "running", durationMin: 39, distanceM: 6200, activeKcal: 410 }],
    });
  });
  it("ok:false 带 error", () => {
    expect(parseHealthResult({ ok: false, error: "x" })).toEqual({ ok: false, error: "x" });
  });
  it.each([
    ["day.date 坏", { ok: true, days: [{ date: "10/04" }], workouts: [] }],
    ["数字是字符串", { ok: true, days: [{ date: "2026-10-04", steps: "1" }], workouts: [] }],
    ["NaN", { ok: true, days: [{ date: "2026-10-04", steps: Number.NaN }], workouts: [] }],
    ["heartRate 缺 max", { ok: true, days: [{ date: "2026-10-04", heartRate: { min: 1, avg: 2 } }], workouts: [] }],
    ["workout 缺 type", { ok: true, days: [], workouts: [{ start: "a", end: "b", durationMin: 1 }] }],
    ["没有 days", { ok: true, workouts: [] }],
    ["ok:false 没 error", { ok: false }],
  ])("拒：%s", (_n, x) => {
    expect(parseHealthResult(x)).toBeNull();
  });
  it("超过 64KB 拒", () => {
    const days = Array.from({ length: 2000 }, (_, i) => ({ date: "2026-10-04", steps: i, distanceM: i, activeKcal: i, flights: i, exerciseMin: i }));
    expect(JSON.stringify({ ok: true, days, workouts: [] }).length).toBeGreaterThan(HEALTH_RESULT_MAX_BYTES);
    expect(parseHealthResult({ ok: true, days, workouts: [] })).toBeNull();
  });
});

describe("formatHealthForModel", () => {
  const q: HealthQuery = { metrics: ["steps", "sleep", "heartRate", "spo2", "workouts"], from: "2026-10-03", to: "2026-10-04" };
  it("每天一行只列有值的；训练单列；全空的类别在末尾说明", () => {
    const text = formatHealthForModel(q, {
      ok: true,
      days: [
        { date: "2026-10-03", steps: 5012 },
        { date: "2026-10-04", steps: 8231, sleep: { asleepMin: 432, deepMin: 65, remMin: 100, coreMin: 267, awakeMin: 18 }, heartRate: { min: 52, avg: 71, max: 148 } },
      ],
      workouts: [{ start: "2026-10-04T08:02:00+08:00", end: "2026-10-04T08:41:00+08:00", type: "running", durationMin: 39, distanceM: 6200, activeKcal: 410 }],
    });
    expect(text).toBe([
      "Apple 健康 · 2026-10-03 至 2026-10-04（用户手机本地日历，按天汇总）",
      "2026-10-03：步数 5012",
      "2026-10-04：步数 8231；睡眠 7小时12分（深睡 1小时5分 · REM 1小时40分 · 核心 4小时27分 · 清醒 18分）；心率 52–148（平均 71）",
      "训练：",
      "2026-10-04 08:02–08:41 running 39分钟 6.2km 410kcal",
      "以下类别在这段时间没有数据（可能没授权，也可能没记录）：血氧",
    ].join("\n"));
  });
  it("一天都没有：只有表头与说明", () => {
    expect(formatHealthForModel({ metrics: ["bodyMass"], from: "2026-10-04", to: "2026-10-04" }, { ok: true, days: [], workouts: [] }))
      .toBe("Apple 健康 · 2026-10-04 至 2026-10-04（用户手机本地日历，按天汇总）\n以下类别在这段时间没有数据（可能没授权，也可能没记录）：体重");
  });
});

describe("answerHealthQuery", () => {
  const q: HealthQuery = { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" };
  it("开关关着：不读，回 ok:false", async () => {
    let read = 0;
    const r = await answerHealthQuery(q, { enabled: () => false, read: async () => { read++; return {}; } });
    expect(r).toEqual({ ok: false, error: "用户在手机上关掉了 Apple 健康" });
    expect(read).toBe(0);
  });
  it("读到：过一遍 parseHealthResult", async () => {
    const r = await answerHealthQuery(q, { enabled: () => true, read: async () => ({ days: [{ date: "2026-10-04", steps: 3 }], workouts: [] }) });
    expect(r).toEqual({ ok: true, days: [{ date: "2026-10-04", steps: 3 }], workouts: [] });
  });
  it("原生给的形状不对", async () => {
    const r = await answerHealthQuery(q, { enabled: () => true, read: async () => ({ days: "x" }) });
    expect(r).toEqual({ ok: false, error: "手机读出来的数据格式不对" });
  });
  it("原生抛错", async () => {
    const r = await answerHealthQuery(q, { enabled: () => true, read: async () => { throw new Error("boom"); } });
    expect(r).toEqual({ ok: false, error: "手机读健康数据出错：boom" });
  });
});

describe("healthReadLineText", () => {
  it("类别按组去重、日期写成几月几日", () => {
    expect(healthReadLineText({ metrics: ["sleep", "heartRate", "hrv"], from: "2026-09-28", to: "2026-10-04" }, "ok"))
      .toBe("读取了健康数据：睡眠、心脏 · 9月28日–10月4日");
  });
  it("同一天只写一次", () => {
    expect(healthReadLineText({ metrics: ["steps", "workouts"], from: "2026-10-04", to: "2026-10-04" }, "ok"))
      .toBe("读取了健康数据：活动、体能训练 · 10月4日");
  });
  it("参数读不懂也给一句", () => {
    expect(healthReadLineText("garbage", "ok")).toBe("读取了健康数据");
  });
  it("失败", () => {
    expect(healthReadLineText({ metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" }, "error")).toBe("没读到健康数据");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/health.test.ts`
Expected: FAIL（`Cannot find module '../../src/shared/health.js'`）

- [ ] **Step 3: 实现** `src/shared/health.ts`

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/health.test.ts`
Expected: PASS（如 64KB 那条的样本不够大，把 `length: 2000` 调大直到前一个断言成立，不改阈值）

- [ ] **Step 5: tsc 自查 + commit**

Run: `npx tsc --noEmit -p .`
Expected: 无错误

```bash
git add src/shared/health.ts tests/shared/health.test.ts
git commit -m "feat(health): 两端共用的健康查询 / 结果校验与给模型的文本（#1656）

只回按天汇总：数据要落进会话日志，越少越好；类别名一张表，模型文本与聊天灰字同源。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 协议帧 `caps` / `health_query` / `health_result`，协议号 29

**Files:**
- Modify: `src/shared/remote/cloudSession.ts`（`CS_PROTOCOL_VERSION` 注释块 + 常量 :151；`CsUp` 联合 :351-447；`CsDown` 联合 :450-547；`decodeCsUp` :770 起；`decodeCsDown` :1012 起）
- Modify（钉子测试）：`tests/runtime/humanCallFrames.test.ts:23`、`tests/shared/chatMediaRefs.test.ts:74`、`tests/shared/cloudSessionFrames.test.ts:28`、`tests/shared/remote/cloudSession.test.ts:43,188,331`
- Test: `tests/shared/remote/healthFrames.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `HealthQuery`, `HealthResult`, `parseHealthQuery`, `parseHealthResult`
- Produces:
  - `CsUp` 增 `{ t: "caps"; health: boolean }`、`{ t: "health_result"; reqId: string; result: HealthResult }`
  - `CsDown` 增 `{ t: "health_query"; reqId: string; query: HealthQuery }`
  - `CS_PROTOCOL_VERSION === 29`

- [ ] **Step 1: 写失败测试** `tests/shared/remote/healthFrames.test.ts`

```ts
// Apple 健康的三种帧（协议 29，#1656）：形状不对整帧拒（解回 null），对的原样往返。
import { describe, expect, it } from "vitest";
import { CS_PROTOCOL_VERSION, decodeCsDown, decodeCsUp, encodeCs } from "../../../src/shared/remote/cloudSession.js";

describe("health 帧", () => {
  it("协议号 29（#1656 健康三帧）", () => {
    expect(CS_PROTOCOL_VERSION).toBe(29);
  });
  it("caps 往返；health 不是布尔就拒", () => {
    expect(decodeCsUp(encodeCs({ t: "caps", health: true }))).toEqual({ t: "caps", health: true });
    expect(decodeCsUp(encodeCs({ t: "caps", health: "yes" } as never))).toBeNull();
  });
  it("health_query 往返；query 不合法就拒", () => {
    const ok = { t: "health_query" as const, reqId: "r1", query: { metrics: ["steps" as const], from: "2026-10-04", to: "2026-10-04" } };
    expect(decodeCsDown(encodeCs(ok))).toEqual(ok);
    expect(decodeCsDown(encodeCs({ ...ok, query: { metrics: [], from: "2026-10-04", to: "2026-10-04" } } as never))).toBeNull();
    expect(decodeCsDown(encodeCs({ ...ok, reqId: 3 } as never))).toBeNull();
  });
  it("health_result 往返（ok 与失败）；result 不合法就拒；reqId 太长就拒", () => {
    const ok = { t: "health_result" as const, reqId: "r1", result: { ok: true as const, days: [{ date: "2026-10-04", steps: 1 }], workouts: [] } };
    expect(decodeCsUp(encodeCs(ok))).toEqual(ok);
    const fail = { t: "health_result" as const, reqId: "r1", result: { ok: false as const, error: "手机断开了" } };
    expect(decodeCsUp(encodeCs(fail))).toEqual(fail);
    expect(decodeCsUp(encodeCs({ ...ok, result: { ok: true, days: "x", workouts: [] } } as never))).toBeNull();
    expect(decodeCsUp(encodeCs({ ...ok, reqId: "x".repeat(65) }))).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/remote/healthFrames.test.ts`
Expected: FAIL（版本号是 28；`caps` 解回 null）

- [ ] **Step 3: 实现**

在 `cloudSession.ts` 顶部 import：

```ts
import { parseHealthQuery, parseHealthResult, type HealthQuery, type HealthResult } from "../health.js";
```

协议号注释块最上方加一行，常量改 29：

```ts
    29（#1656）：Apple 健康三帧——上行 `caps`（这台设备能替智能体读健康数据）与 `health_result`，下行 `health_query`
    （runtime 定向发给声明了能力的那一条 cid）。另：#1605 / #1648 的几条帧注释写着「协议 29」而常量当时没进位，
    这一次进位把它们一并落实。
```
```ts
export const CS_PROTOCOL_VERSION = 29;
```

`CsUp` 联合末尾（`| { t: "call"; participants: string[] }` 那一项之前）加：

```ts
  /** 这台设备此刻能替智能体做什么（协议 29，#1656）：welcome 之后发一次，开关变动再发。只有手机发 */
  | { t: "caps"; health: boolean }
  /** health_query 的应答（协议 29，#1656）。runtime 只认发请求的那条 cid 回的 */
  | { t: "health_result"; reqId: string; result: HealthResult }
```

`CsDown` 联合末尾（`| { t: "error"; msg: string };` 之前）加：

```ts
  /** 读这台手机的 Apple 健康（协议 29，#1656）：只发给声明了 `caps.health` 的那一条 cid */
  | { t: "health_query"; reqId: string; query: HealthQuery }
```

`decodeCsUp` 里，在 `if (t === "stop")` 分支之前加：

```ts
    if (t === "caps") {
      return typeof obj.health === "boolean" ? { t: "caps", health: obj.health } : null;
    }

    if (t === "health_result") {
      if (typeof obj.reqId !== "string" || obj.reqId.length === 0 || obj.reqId.length > 64) return null;
      const result = parseHealthResult(obj.result);
      return result === null ? null : { t: "health_result", reqId: obj.reqId, result };
    }
```

`decodeCsDown` 里，在 `if (t === "welcome")` 分支之前加：

```ts
    if (t === "health_query") {
      if (typeof obj.reqId !== "string" || obj.reqId.length === 0 || obj.reqId.length > 64) return null;
      const query = parseHealthQuery(obj.query);
      return query === null ? null : { t: "health_query", reqId: obj.reqId, query };
    }
```

把六处 `expect(CS_PROTOCOL_VERSION).toBe(28)` 改成 `29`，并把旁边写着「此刻 28」的用例标题改成「此刻 29：#1656 健康三帧在它之后进位」（`cloudSession.test.ts:331` 的标题改成 `"CS_PROTOCOL_VERSION 是 29（#1656 健康三帧之后）"`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/remote/healthFrames.test.ts tests/shared/remote/cloudSession.test.ts tests/shared/cloudSessionFrames.test.ts tests/shared/chatMediaRefs.test.ts tests/runtime/humanCallFrames.test.ts`
Expected: PASS。再 `grep -rn "toBe(28)" tests | grep -i protocol` 应无残留。

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit -p .`（`frameHandler` 的 switch 若因新帧报「未处理」类错误，先在它的 `default` 之前加 `case "caps": case "health_result": deny(cid, "not_authorized"); return;` 占位——Task 4 会换成真实处理；cloudSessionClient 同理加 `case "health_query": return;` 占位，Task 7 换掉）

```bash
git add src/shared/remote/cloudSession.ts tests/
git commit -m "feat(protocol): 协议 29——Apple 健康三帧 caps / health_query / health_result（#1656）

握手严格相等，加帧必须进位；#1605/#1648 注释里那几条「协议 29」借这次进位落实。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: runtime `healthBroker`

**Files:**
- Create: `services/runtime/src/healthBroker.ts`
- Test: `tests/runtime/healthBroker.test.ts`

**Interfaces:**
- Consumes: Task 1 `HealthQuery`, `HealthResult`；Task 2 `CsDown`
- Produces:

```ts
export const HEALTH_TIMEOUT_MS = 30_000;
export interface HealthBroker {
  setCaps(cid: string, uid: string, health: boolean): void;
  gone(cid: string): void;
  cidOf(uid: string): string | null;
  request(cid: string, query: HealthQuery, signal?: AbortSignal): Promise<HealthResult>;
  resolve(cid: string, reqId: string, result: HealthResult): boolean;
}
export function createHealthBroker(deps: { send: (cid: string, msg: CsDown) => void; timeoutMs?: number; newId?: () => string }): HealthBroker;
```

- [ ] **Step 1: 写失败测试** `tests/runtime/healthBroker.test.ts`

```ts
// 健康读取的定向往返（#1656）：能力表、请求只发给那一条 cid、四种收场（回帧 / 超时 / abort / 断开）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHealthBroker, HEALTH_TIMEOUT_MS } from "../../services/runtime/src/healthBroker.js";
import type { CsDown } from "../../src/shared/remote/cloudSession.js";
import type { HealthQuery } from "../../src/shared/health.js";

const Q: HealthQuery = { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" };
const OK = { ok: true as const, days: [{ date: "2026-10-04", steps: 1 }], workouts: [] };

function setup() {
  const sent: { cid: string; msg: CsDown }[] = [];
  let n = 0;
  const broker = createHealthBroker({ send: (cid, msg) => sent.push({ cid, msg }), newId: () => `r${++n}` });
  return { broker, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("能力表", () => {
  it("cidOf 取这个 uid 最近声明的那一条；关掉 / 断开就摘", () => {
    const { broker } = setup();
    expect(broker.cidOf("u1")).toBeNull();
    broker.setCaps("c1", "u1", true);
    broker.setCaps("c2", "u1", true);
    broker.setCaps("c3", "u2", true);
    expect(broker.cidOf("u1")).toBe("c2");
    broker.setCaps("c2", "u1", false);
    expect(broker.cidOf("u1")).toBe("c1");
    broker.gone("c1");
    expect(broker.cidOf("u1")).toBeNull();
    expect(broker.cidOf("u2")).toBe("c3");
  });
  it("同一条 cid 再声明一次会挪到最新", () => {
    const { broker } = setup();
    broker.setCaps("c1", "u1", true);
    broker.setCaps("c2", "u1", true);
    broker.setCaps("c1", "u1", true);
    expect(broker.cidOf("u1")).toBe("c1");
  });
});

describe("request", () => {
  it("只发给那一条 cid；那条 cid 回帧就收场", async () => {
    const { broker, sent } = setup();
    const p = broker.request("c1", Q);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "health_query", reqId: "r1", query: Q } }]);
    expect(broker.resolve("c1", "r1", OK)).toBe(true);
    await expect(p).resolves.toEqual(OK);
  });
  it("别的 cid 冒充回帧：不认", async () => {
    const { broker } = setup();
    const p = broker.request("c1", Q);
    expect(broker.resolve("c2", "r1", OK)).toBe(false);
    expect(broker.resolve("c1", "nope", OK)).toBe(false);
    expect(broker.resolve("c1", "r1", OK)).toBe(true);
    await expect(p).resolves.toEqual(OK);
  });
  it("超时", async () => {
    const { broker } = setup();
    const p = broker.request("c1", Q);
    vi.advanceTimersByTime(HEALTH_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ ok: false, error: "手机 30 秒没回" });
    expect(broker.resolve("c1", "r1", OK)).toBe(false);
  });
  it("那条 cid 断开", async () => {
    const { broker } = setup();
    const p = broker.request("c1", Q);
    broker.gone("c1");
    await expect(p).resolves.toEqual({ ok: false, error: "手机断开了" });
  });
  it("turn 被停", async () => {
    const { broker } = setup();
    const ac = new AbortController();
    const p = broker.request("c1", Q, ac.signal);
    ac.abort();
    await expect(p).resolves.toEqual({ ok: false, error: "这一轮被停了" });
  });
  it("已经 abort 的信号：不发帧直接收场", async () => {
    const { broker, sent } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(broker.request("c1", Q, ac.signal)).resolves.toEqual({ ok: false, error: "这一轮被停了" });
    expect(sent).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/healthBroker.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `services/runtime/src/healthBroker.ts`

```ts
// 健康读取的定向往返（#1656，spec §3.2）：哪几条 cid 声明了「能读健康」、给其中一条发 health_query、等它回。
// 纯逻辑，发送注入（daemon 给 globalSend）——frameHandler 喂 caps / health_result / onGone 进来，read_health 工具从这里取 cid 与结果。
//
// 结果永远 resolve 成 HealthResult，不 reject：四种收场（回帧 / 超时 / 断开 / abort）都是「这次没读到」的不同说法，
// 工具那一侧统一把 ok:false 的 error 抛给模型。回帧只认发请求的那一条 cid：别的连接（哪怕同一个人）冒充的不收。

import type { HealthQuery, HealthResult } from "../../../src/shared/health.js";
import type { CsDown } from "../../../src/shared/remote/cloudSession.js";

export const HEALTH_TIMEOUT_MS = 30_000;

export interface HealthBroker {
  setCaps(cid: string, uid: string, health: boolean): void;
  gone(cid: string): void;
  /** 这个人此刻能读健康的连接里最近声明的那一条；没有回 null */
  cidOf(uid: string): string | null;
  request(cid: string, query: HealthQuery, signal?: AbortSignal): Promise<HealthResult>;
  /** true = 对上了一条挂着的请求 */
  resolve(cid: string, reqId: string, result: HealthResult): boolean;
}

export function createHealthBroker(deps: {
  send: (cid: string, msg: CsDown) => void;
  timeoutMs?: number;
  newId?: () => string;
}): HealthBroker {
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  /** cid → uid；Map 保插入序，「最近声明」= 迭代里最后一条 */
  const capable = new Map<string, string>();
  const pending = new Map<string, { cid: string; settle: (r: HealthResult) => void }>();

  /** 每条的 settle 自己从 pending 里摘（并清计时器、摘 abort 监听），所以这里先拷一份再逐个收场 */
  function failAllOf(cid: string, error: string): void {
    for (const p of [...pending.values()]) if (p.cid === cid) p.settle({ ok: false, error });
  }

  return {
    setCaps(cid, uid, health) {
      capable.delete(cid);
      if (health) capable.set(cid, uid);
    },
    gone(cid) {
      capable.delete(cid);
      failAllOf(cid, "手机断开了");
    },
    cidOf(uid) {
      let hit: string | null = null;
      for (const [cid, u] of capable) if (u === uid) hit = cid;
      return hit;
    },
    request(cid, query, signal) {
      if (signal?.aborted === true) return Promise.resolve({ ok: false, error: "这一轮被停了" });
      const reqId = newId();
      return new Promise<HealthResult>((resolve) => {
        const timer = setTimeout(() => settle({ ok: false, error: `手机 ${Math.round(timeoutMs / 1000)} 秒没回` }), timeoutMs);
        const onAbort = (): void => settle({ ok: false, error: "这一轮被停了" });
        function settle(r: HealthResult): void {
          if (!pending.has(reqId)) return;
          pending.delete(reqId);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        }
        pending.set(reqId, { cid, settle });
        signal?.addEventListener("abort", onAbort, { once: true });
        deps.send(cid, { t: "health_query", reqId, query });
      });
    },
    resolve(cid, reqId, result) {
      const p = pending.get(reqId);
      if (p === undefined || p.cid !== cid) return false;
      p.settle(result);
      return true;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/runtime/healthBroker.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add services/runtime/src/healthBroker.ts tests/runtime/healthBroker.test.ts
git commit -m "feat(runtime): healthBroker——健康读取的定向往返（#1656）

只认发请求那条 cid 的回帧；超时 / 断开 / 停止都收成 ok:false，工具一侧统一抛给模型。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: frameHandler 接 `caps` / `health_result` / onGone

**Files:**
- Modify: `services/runtime/src/frameHandler.ts`（`FrameHandlerDeps` :117 起加一格；`onSessionFrame` 的 `switch (msg.t)`；`inner.onGone` :1054 附近）
- Test: `tests/runtime/frameHandler.test.ts`（在 `makeDeps` 的 config 加 `health?`，文件末尾加一个 describe）

**Interfaces:**
- Consumes: Task 3 `HealthBroker`
- Produces: `FrameHandlerDeps.health?: Pick<HealthBroker, "setCaps" | "resolve" | "gone">`

- [ ] **Step 1: 写失败测试**——`makeDeps` 的 config 类型加一行、deps 对象加一行：

```ts
  /** #1656：默认不接（绝大多数用例不关心健康读取） */
  health?: FrameHandlerDeps["health"];
```
```ts
    ...(config.health !== undefined ? { health: config.health } : {}),
```

文件末尾加：

```ts
describe("Apple 健康（#1656）", () => {
  function recorder() {
    const calls: string[] = [];
    const health: NonNullable<FrameHandlerDeps["health"]> = {
      setCaps: (cid, uid, on) => calls.push(`caps ${cid} ${uid} ${on}`),
      resolve: (cid, reqId) => { calls.push(`resolve ${cid} ${reqId}`); return reqId === "known"; },
      gone: (cid) => calls.push(`gone ${cid}`),
    };
    return { calls, health };
  }
  async function joined(health: NonNullable<FrameHandlerDeps["health"]>) {
    const m = makeDeps({ health });
    const fh = createFrameHandler(m.deps);
    await fh.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    return { fh, ...m };
  }
  it("caps 记到这条 cid 与验过的 uid 上", async () => {
    const { calls, health } = recorder();
    const { fh } = await joined(health);
    await fh.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "caps", health: true }));
    expect(calls).toEqual(["caps c1 u1 true"]);
  });
  it("health_result 交给 broker；对不上记一笔", async () => {
    const { calls, health } = recorder();
    const { fh, logs } = await joined(health);
    const result = { ok: false as const, error: "x" };
    await fh.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "health_result", reqId: "known", result }));
    await fh.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "health_result", reqId: "stale", result }));
    expect(calls).toEqual(["resolve c1 known", "resolve c1 stale"]);
    expect(logs.some((l) => l.includes("健康回帧没对上") && l.includes("stale"))).toBe(true);
  });
  it("没 hello 的 cid 发 caps：拒，不进 broker", async () => {
    const { calls, health } = recorder();
    const m = makeDeps({ health });
    const fh = createFrameHandler(m.deps);
    await fh.onSessionFrame("w1", "s1", "c9", encodeCs({ t: "caps", health: true }));
    expect(calls).toEqual([]);
    expect(m.sent.at(-1)?.msg).toMatchObject({ t: "denied", code: "not_authorized" });
  });
  it("onGone 通知 broker", async () => {
    const { calls, health } = recorder();
    const { fh } = await joined(health);
    fh.onGone("c1");
    expect(calls).toEqual(["gone c1"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/frameHandler.test.ts -t "Apple 健康"`
Expected: FAIL（caps 被 Task 2 的占位 deny 掉 / `health` 不是已知 dep）

- [ ] **Step 3: 实现**

`FrameHandlerDeps` 里（`dropCid?` 之前）加：

```ts
  /** Apple 健康的能力表与回帧（#1656）。可选：smoke / 测试假货不接——缺席时 caps 与 health_result 照收照丢，
      不拒（拒会把一台正常的手机踢出房间）。daemon 是唯一装配者，总会给 */
  health?: Pick<HealthBroker, "setCaps" | "resolve" | "gone">;
```

import：`import type { HealthBroker } from "./healthBroker.js";`

`onSessionFrame` 的 switch 里，把 Task 2 的占位换成（放在 `case "say"` 之前）：

```ts
        case "caps": {
          // 能力声明（#1656）：只记「这条连接能读健康」，读谁的由 read_health 按这一轮的发起人现选。
          // 不复查在籍、不进限速：它不读写会话状态，被踢的人留着一条能力也只会让 runtime 来问他自己
          deps.health?.setCaps(cid, entry.uid, msg.health);
          return;
        }

        case "health_result": {
          if (deps.health !== undefined && !deps.health.resolve(cid, msg.reqId, msg.result)) {
            deps.log(`健康回帧没对上 cid=${cid} reqId=${msg.reqId}`);
          }
          return;
        }
```

（`entry` 在这个 switch 之前已经判过非空——照 `case "approve"` 的用法直接读 `entry.uid`；若 TS 说可能为 null，照 `say` 分支的写法取。）

`inner.onGone(cid)` 改成：

```ts
    onGone(cid) {
      cids.delete(cid);
      deps.health?.gone(cid);
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/runtime/frameHandler.test.ts`
Expected: PASS（全文件）

- [ ] **Step 5: commit**

```bash
git add services/runtime/src/frameHandler.ts tests/runtime/frameHandler.test.ts
git commit -m "feat(runtime): frameHandler 接健康能力声明与回帧（#1656）

health 缺席时照收照丢不拒：拒会把一台正常的手机踢出房间。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `read_health` 工具 + 资格判据 + sessionService 接入

**Files:**
- Create: `services/runtime/src/healthTool.ts`
- Modify: `services/runtime/src/sessionService.ts`（`CloudSessionOpts` :374 起加 `health?`；`let routineTurn` :1004 旁加 `healthTurn`；`callUserTool` :1784 旁建 `healthTool`；`tools()` 的 `list` :1950 附近；`runJob` 里 `applyTraits(...)` 之后；`finally` 复位 :3058 附近）
- Test: `tests/runtime/healthTool.test.ts`、`tests/runtime/sessionService.health.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseHealthQuery`, `formatHealthForModel`, `HEALTH_METRICS`, `HealthQuery`, `HealthResult`；Task 3 `HealthBroker`
- Produces:

```ts
export const READ_HEALTH_TOOL_NAME = "read_health";
export type HealthGateway = Pick<HealthBroker, "cidOf" | "request">;
export function healthTurnEligible(t: { approveAll: boolean; ownerUid: string; initiator: string | null; depth: number; routine: boolean; report: boolean; rerun: boolean }): boolean;
export function createReadHealthTool(deps: { gateway: HealthGateway; initiator: () => string | null }): Tool;
// CloudSessionOpts.health?: HealthGateway
```

- [ ] **Step 1: 写失败测试** `tests/runtime/healthTool.test.ts`

```ts
// read_health（#1656）：资格判据（谁的哪一轮能读）与工具本身（现选 cid、失败抛给模型、成功给文本）。
import { describe, expect, it } from "vitest";
import { createReadHealthTool, healthTurnEligible, type HealthGateway } from "../../services/runtime/src/healthTool.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;
const base = { approveAll: true, ownerUid: "owner", initiator: "owner", depth: 0, routine: false, report: false, rerun: false };

describe("healthTurnEligible", () => {
  it("主场：主人亲口的那一轮可以", () => expect(healthTurnEligible(base)).toBe(true));
  it.each([
    ["主场里客人 / 朋友那一轮", { initiator: "friend" }],
    ["接力棒", { depth: 1 }],
    ["定时任务", { routine: true }],
    ["汇报轮", { report: true }],
    ["重启补跑", { rerun: true }],
    ["没有发起人", { initiator: null }],
    ["系统", { initiator: "system" }],
  ])("不行：%s", (_n, patch) => {
    expect(healthTurnEligible({ ...base, ...patch })).toBe(false);
  });
  it("团队会话：哪位成员亲口都行（读的是他自己的手机）", () => {
    expect(healthTurnEligible({ ...base, approveAll: false, initiator: "member" })).toBe(true);
  });
});

describe("read_health", () => {
  const OK = { ok: true as const, days: [{ date: "2026-10-04", steps: 8231 }], workouts: [] };
  function gw(cid: string | null, result = OK as Awaited<ReturnType<HealthGateway["request"]>>) {
    const asked: { cid: string; q: unknown }[] = [];
    const gateway: HealthGateway = {
      cidOf: (uid) => (uid === "owner" ? cid : null),
      request: async (c, q) => { asked.push({ cid: c, q }); return result; },
    };
    return { gateway, asked };
  }
  it("不过审批门、名字固定", () => {
    const t = createReadHealthTool({ gateway: gw("c1").gateway, initiator: () => "owner" });
    expect(t.def.name).toBe("read_health");
    expect(t.requiresApproval).toBe(false);
  });
  it("调用时按发起人现选 cid，回给模型的文本", async () => {
    const { gateway, asked } = gw("c1");
    const t = createReadHealthTool({ gateway, initiator: () => "owner" });
    const out = await t.run({ metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" }, world, { toolCallId: "x" });
    expect(asked).toEqual([{ cid: "c1", q: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } }]);
    expect(out).toBe("Apple 健康 · 2026-10-04 至 2026-10-04（用户手机本地日历，按天汇总）\n2026-10-04：步数 8231");
  });
  it("手机不在线：抛人话", async () => {
    const t = createReadHealthTool({ gateway: gw(null).gateway, initiator: () => "owner" });
    await expect(t.run({ metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" }, world)).rejects.toThrow("手机现在没连着");
  });
  it("参数不对：抛错并说清规则", async () => {
    const t = createReadHealthTool({ gateway: gw("c1").gateway, initiator: () => "owner" });
    await expect(t.run({ metrics: ["mood"], from: "x", to: "y" }, world)).rejects.toThrow("YYYY-MM-DD");
  });
  it("手机回 ok:false：把 error 抛给模型", async () => {
    const t = createReadHealthTool({ gateway: gw("c1", { ok: false, error: "手机 30 秒没回" }).gateway, initiator: () => "owner" });
    await expect(t.run({ metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" }, world)).rejects.toThrow("手机 30 秒没回");
  });
});
```

`tests/runtime/sessionService.health.test.ts`（夹具照 `sessionService.routine.test.ts` 的 `open()`，多一格 `health`）：

```ts
// read_health 进不进工具表（#1656）：主人亲口 + 手机在线才有；定时任务没有；没接 health 没有。调了之后结果落 tool_result。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";
import type { HealthGateway } from "../../services/runtime/src/healthTool.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { ToolResultEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const OWNER = "owner";
const SID = "s-health";
const HELPER = { agentId: "a_000000000001", name: "助手", description: "", instructions: "", models: ["fake-model"], tools: [], domain: "dev" };
const fakeWorld: ExecutionWorld = { fs: { read: async () => "", write: async () => {} }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), http: { postJson: async () => ({}) } };
const FIRED = Date.UTC(2026, 9, 5, 1, 0);
const ROUTINE = { routineId: "r1", title: "早报", instruction: "看一眼", tz: "Asia/Shanghai", firedAt: FIRED, agentId: HELPER.agentId };

/** 第一圈记工具表；callHealth 时第一圈调 read_health，第二圈收口 */
function adapter(seen: string[][], callHealth = false): ModelAdapter {
  let n = 0;
  return {
    model: "fake-model",
    async chat(_m, tools): Promise<ModelReply> {
      seen.push((tools ?? []).map((t) => t.name));
      n++;
      if (callHealth && n === 1) return { content: "", toolCalls: [{ id: "h1", name: "read_health", args: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } }] };
      return { content: "好" };
    },
  };
}

function open(o: { adapter: ModelAdapter; health?: HealthGateway }) {
  const store = new EventStore(join(tempDir("mrotto-runtime-health-"), "session.db"));
  store.append({ sessionId: SID, ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "home", home: true, chat: { kind: "dm" } } });
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "home", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => [HELPER], adapterFor: () => o.adapter, px: { edgeBase: "https://edge.example", runtimeSecret: "sek" },
    hostUids: async () => [OWNER], onEvent: () => {}, onUsage: () => {},
    wiki: createWikiService({ workspaceId: "home", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true }),
    mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, approveAll: true, callback: null,
    routines: createInMemoryRoutineStore(),
    ...(o.health !== undefined ? { health: o.health } : {}),
  };
  return { session: createCloudSession(opts), store };
}

const online: HealthGateway = {
  cidOf: (uid) => (uid === OWNER ? "c1" : null),
  request: async () => ({ ok: true, days: [{ date: "2026-10-04", steps: 8231 }], workouts: [] }),
};

describe("read_health 的挂载", () => {
  it("主人亲口 + 手机在线：有；调了结果落 tool_result", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen, true), health: online });
    await session.say(OWNER, "小明", "我今天走了多少步", true, [HELPER.agentId], undefined, []);
    await session.settled();
    expect(seen[0]).toContain("read_health");
    const r = store.load(SID).find((e): e is ToolResultEvent => e.type === "tool_result" && e.toolCallId === "h1")!;
    expect(r.status).toBe("ok");
    expect(r.output).toContain("步数 8231");
    store.close();
  });
  it("手机不在线：没有", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen), health: { ...online, cidOf: () => null } });
    await session.say(OWNER, "小明", "嗨", true, [HELPER.agentId], undefined, []);
    await session.settled();
    expect(seen[0]).not.toContain("read_health");
    store.close();
  });
  it("定时任务那一轮：没有", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen), health: online });
    await session.runRoutine(ROUTINE);
    await session.settled();
    expect(seen[0]).not.toContain("read_health");
    store.close();
  });
  it("没接 health：没有", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen) });
    await session.say(OWNER, "小明", "嗨", true, [HELPER.agentId], undefined, []);
    await session.settled();
    expect(seen[0]).not.toContain("read_health");
    store.close();
  });
});
```

（如果 `say` 的参数签名与上面不一致，照 `sessionService.routine.test.ts` 里那一行现抄；夹具里任何必需格报缺，照该文件补齐——那份是最新的。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/healthTool.test.ts tests/runtime/sessionService.health.test.ts`
Expected: FAIL（模块不存在 / `health` 不是 opts 的格）

- [ ] **Step 3: 实现** `services/runtime/src/healthTool.ts`

```ts
// read_health（#1656，spec §2.1 / §3.2）：读说话人自己那台开着 Otto 的 iPhone 上的 Apple 健康，按天汇总。
// 工具不碰网络与 fs（硬规则）：取 cid 与等结果都经注入的 HealthGateway（daemon 给 healthBroker）。
// cid 在**调用时**现选：手机回前台会换一条新连接，turn 开始时那条可能已经没了。
// 不过审批门：是说话人本人在问，而且只读他自己的手机；谁的哪一轮能用由 healthTurnEligible 判。

import { formatHealthForModel, HEALTH_MAX_SPAN_DAYS, HEALTH_METRICS, parseHealthQuery, READ_HEALTH_TOOL } from "../../../src/shared/health.js";
import type { Tool } from "../../../src/tools/tool.js";
import type { HealthBroker } from "./healthBroker.js";

export const READ_HEALTH_TOOL_NAME = READ_HEALTH_TOOL;

export type HealthGateway = Pick<HealthBroker, "cidOf" | "request">;

/** 这一轮能不能读健康数据：人亲口说的（不是接力棒 / 定时任务 / 汇报 / 重启补跑）；主场里（个人空间、私密车道、
    好友群）只认主人——客人那一轮读不到主人的手机，也不该读他们自己的（数据会落进主人的日志）。团队会话里哪位成员
    亲口都行：读的是他自己的手机，回答在他自己选的群里 */
export function healthTurnEligible(t: {
  approveAll: boolean; ownerUid: string; initiator: string | null;
  depth: number; routine: boolean; report: boolean; rerun: boolean;
}): boolean {
  if (t.initiator === null || t.initiator === "system") return false;
  if (t.depth > 0 || t.routine || t.report || t.rerun) return false;
  return t.approveAll ? t.initiator === t.ownerUid : true;
}

export function createReadHealthTool(deps: { gateway: HealthGateway; initiator: () => string | null }): Tool {
  return {
    def: {
      name: READ_HEALTH_TOOL_NAME,
      description:
        "读正在和你说话的这个人自己 iPhone 上的 Apple 健康数据（按天汇总：步数、距离、活动能量、爬楼、锻炼时长、站立、睡眠分期、" +
        "心率、静息心率、HRV、血氧、体重、体脂、体能训练）。只在他问到自己的运动、睡眠、身体指标时用。" +
        `日期是他手机的本地日历，闭区间，跨度最多 ${HEALTH_MAX_SPAN_DAYS} 天；「今天」以系统提示里的日期为准。` +
        "某一类读出来是空的，可能是他没授权那一类，也可能是没记录——照实说，不要猜数。",
      parameters: {
        type: "object",
        properties: {
          metrics: { type: "array", items: { type: "string", enum: [...HEALTH_METRICS] }, minItems: 1, description: "要读哪几类" },
          from: { type: "string", description: "起始日期 YYYY-MM-DD" },
          to: { type: "string", description: "结束日期 YYYY-MM-DD（含这一天）" },
        },
        required: ["metrics", "from", "to"],
      },
    },
    requiresApproval: false,
    async run(args, _world, ctx) {
      const q = parseHealthQuery(args);
      if (q === null) {
        throw new Error(`参数不对：metrics 取 ${HEALTH_METRICS.join(" / ")} 里的一个或几个；from、to 是 YYYY-MM-DD，from 不晚于 to，跨度不超过 ${HEALTH_MAX_SPAN_DAYS} 天。`);
      }
      const uid = deps.initiator();
      const cid = uid === null ? null : deps.gateway.cidOf(uid);
      if (cid === null) throw new Error("他的手机现在没连着（Otto App 不在前台），读不到健康数据。可以请他打开 Otto 再问一次。");
      const r = await deps.gateway.request(cid, q, ctx?.signal);
      if (!r.ok) throw new Error(r.error);
      return formatHealthForModel(q, r);
    },
  };
}
```

`sessionService.ts` 改动：

1. import：`import { createReadHealthTool, healthTurnEligible, type HealthGateway } from "./healthTool.js";`
2. `CloudSessionOpts` 里（`alert?` 之后）加：

```ts
  /** Apple 健康（#1656）：读说话人自己手机的那条通道（daemon 给 healthBroker）。可选：缺席 = 不挂 read_health，
      与改动前逐字相同（测试与冒烟装配不必关心）。接线有一条读 daemon.ts 源码的断言（tests/runtime/daemonHealthWiring.test.ts） */
  health?: HealthGateway;
```

3. `let routineTurn = false;`（:1004）下面加：

```ts
  /** 这一轮能不能读健康数据（#1656）：runJob 起跑时按 healthTurnEligible 算、收口复位 */
  let healthTurn = false;
```

4. `const callUserTool = ...`（:1784）之前加：

```ts
    // read_health（#1656）：daemon 接了健康通道才建；挂不挂由 tools() 每圈按 healthTurn + 发起人此刻有没有能力连接现判
    const healthTool = opts.health === undefined ? null : createReadHealthTool({ gateway: opts.health, initiator: () => currentInitiator });
```

5. `tools()` 的 `list` 里，`...px,` 之前加：

```ts
          // 手机不在线时不亮（#1656）：亮出来只会换一句「没连着」；调用时仍会现选一次 cid（中途可能换了连接）
          ...(healthTool !== null && healthTurn && currentInitiator !== null && opts.health!.cidOf(currentInitiator) !== null ? [healthTool] : []),
```

6. `runJob` 里 `applyTraits(traitOpenings(job), openingDepth);` 之后加：

```ts
    healthTurn = healthTurnEligible({
      approveAll: opts.approveAll, ownerUid: opts.ownerUid, initiator: job.fromUid,
      depth: openingDepth, routine: routineTurn, report: reportTurn, rerun: rerunTurn,
    });
```

7. `finally` 复位块（`routineTurn = false;` 那一行，:3060 附近）加 `healthTurn = false;`

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/runtime/healthTool.test.ts tests/runtime/sessionService.health.test.ts tests/runtime/sessionService.routine.test.ts`
Expected: PASS

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit -p .`

```bash
git add services/runtime/src/healthTool.ts services/runtime/src/sessionService.ts tests/runtime/healthTool.test.ts tests/runtime/sessionService.health.test.ts
git commit -m "feat(runtime): read_health 工具与挂载判据（#1656）

只在人亲口、非接力 / 定时 / 汇报 / 补跑、主场里限主人的轮里挂，且发起人此刻有能力连接；
cid 调用时现选，因为手机回前台会换连接。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: daemon 接线

**Files:**
- Modify: `services/runtime/src/daemon.ts`（`globalSend` 定义 :531 之后；`createCloudSession({` :995；`const frameHandlerDeps: FrameHandlerDeps = {` :1418）
- Test: `tests/runtime/daemonHealthWiring.test.ts`

**Interfaces:**
- Consumes: Task 3 `createHealthBroker`；Task 4 `FrameHandlerDeps.health`；Task 5 `CloudSessionOpts.health`

- [ ] **Step 1: 写失败测试** `tests/runtime/daemonHealthWiring.test.ts`

```ts
// daemon.ts 进不了 vitest（import 即连 docker / Supabase）。健康通道（#1656）在它身上的接线漏了是安静的：
// frameHandler 与 sessionService 的 health 都是可选的，漏接 = read_health 永远不亮、caps 照收照丢。判据落在源码上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：Apple 健康的接线（#1656）", () => {
  it("建一个 broker，发帧走 globalSend", () => {
    expect(src).toMatch(/const healthBroker = createHealthBroker\(\{ send: globalSend \}\);/);
  });
  it("frameHandler 与每条会话都接上同一个 broker", () => {
    expect(src.match(/health: healthBroker,/g)?.length).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/daemonHealthWiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

import：`import { createHealthBroker } from "./healthBroker.js";`

`function globalSend(...) { ... }` 结束之后加：

```ts
  // Apple 健康（#1656）：能力表与定向往返。发帧走 globalSend（按 cid 单发，不广播）
  const healthBroker = createHealthBroker({ send: globalSend });
```

`createCloudSession({` 的参数里（`workspaceId,` 那几格旁）加 `health: healthBroker,`；`frameHandlerDeps` 对象里（`log:` 之后）加 `health: healthBroker,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/runtime/daemonHealthWiring.test.ts && npx tsc --noEmit -p .`
Expected: PASS，tsc 无错（若 `healthBroker` 在 `createCloudSession` 调用处尚未定义——那段在 globalSend 之后的函数体内，按行号应已定义；若报 used-before-assign，把 broker 的建立挪到 globalSend 定义紧后即可，正则不变）

- [ ] **Step 5: commit**

```bash
git add services/runtime/src/daemon.ts tests/runtime/daemonHealthWiring.test.ts
git commit -m "feat(runtime): daemon 接上健康通道（#1656）

两处 health 都是可选的，漏接是安静的，所以加读源码的接线断言。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 共享客户端 `cloudSessionClient`：发 caps、答 health_query、`refreshCaps()`

**Files:**
- Modify: `src/shared/remote/cloudSessionClient.ts`（`CloudSessionClientDeps` :129；`CloudSessionClient` 接口 :190；`handleSessionFrame` 的 `case "welcome"` :648；`createCloudSessionClient` 返回对象）
- Test: `tests/shared/remote/cloudSessionClientHealth.test.ts`

**Interfaces:**
- Consumes: Task 1 `HealthQuery`, `HealthResult`；Task 2 帧
- Produces:
  - `CloudSessionClientDeps.deviceCaps?: () => { health: boolean }`
  - `CloudSessionClientDeps.onHealthQuery?: (query: HealthQuery) => Promise<HealthResult>`
  - `CloudSessionClient.refreshCaps(): void`

- [ ] **Step 1: 写失败测试** `tests/shared/remote/cloudSessionClientHealth.test.ts`——把 `tests/shared/remote/cloudSessionClient.test.ts` 顶部的 `tick` / `fakeTransport` / `harness` 三段原样复制进来（只复制这三段与它们的 import），再写：

```ts
const WELCOME: CsDown = { t: "welcome", v: CS_PROTOCOL_VERSION, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: null, ownerUid: "owner", modelRoute: null };

async function ready(h: ReturnType<typeof harness>) {
  await h.client.join("w1", "cloud-s1");
  const t = h.transports[0]!;
  t.emitPeer();
  await tick();
  t.emitDown(WELCOME);
  await tick();
  return t;
}

describe("Apple 健康（#1656）", () => {
  it("welcome 之后发一次 caps", async () => {
    const h = harness({ deviceCaps: () => ({ health: true }) });
    const t = await ready(h);
    expect(t.decoded()).toContainEqual({ t: "caps", health: true });
  });
  it("没给 deviceCaps（桌面）：不发 caps", async () => {
    const h = harness();
    const t = await ready(h);
    expect(t.decoded().some((m) => m?.t === "caps")).toBe(false);
  });
  it("refreshCaps：welcome 之后才发；之前是空操作", async () => {
    let on = false;
    const h = harness({ deviceCaps: () => ({ health: on }) });
    h.client.refreshCaps(); // 还没 join
    const t = await ready(h);
    on = true;
    h.client.refreshCaps();
    expect(t.decoded().filter((m) => m?.t === "caps")).toEqual([{ t: "caps", health: false }, { t: "caps", health: true }]);
  });
  it("health_query → onHealthQuery → health_result 带同一个 reqId", async () => {
    const h = harness({ onHealthQuery: async () => ({ ok: true, days: [], workouts: [] }) });
    const t = await ready(h);
    t.emitDown({ t: "health_query", reqId: "r1", query: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } });
    await tick();
    expect(t.decoded()).toContainEqual({ t: "health_result", reqId: "r1", result: { ok: true, days: [], workouts: [] } });
  });
  it("没给 onHealthQuery：回 ok:false", async () => {
    const h = harness();
    const t = await ready(h);
    t.emitDown({ t: "health_query", reqId: "r1", query: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } });
    await tick();
    expect(t.decoded()).toContainEqual({ t: "health_result", reqId: "r1", result: { ok: false, error: "这台设备不读健康数据" } });
  });
  it("onHealthQuery 抛错：回 ok:false 带原话", async () => {
    const h = harness({ onHealthQuery: async () => { throw new Error("boom"); } });
    const t = await ready(h);
    t.emitDown({ t: "health_query", reqId: "r1", query: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } });
    await tick();
    expect(t.decoded()).toContainEqual({ t: "health_result", reqId: "r1", result: { ok: false, error: "boom" } });
  });
});
```

（`WELCOME` 的必需字段以 `decodeCsDown` 的 welcome 分支为准；缺哪格补哪格。`ready()` 里 welcome 之后客户端会先发 backlog，断言用 `toContainEqual` 不依赖顺序。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/remote/cloudSessionClientHealth.test.ts`
Expected: FAIL（`refreshCaps` 不存在 / 没发 caps）

- [ ] **Step 3: 实现**

import：`import type { HealthQuery, HealthResult } from "../health.js";`

`CloudSessionClientDeps` 里（`log?` 之前）加：

```ts
  /** 这台设备此刻能替智能体做什么（协议 29，#1656）：welcome 之后发一次 `caps`，`refreshCaps()` 再发。
      不给 = 不发（桌面：它没有健康数据） */
  deviceCaps?: () => { health: boolean };
  /** runtime 要读这台手机的 Apple 健康（#1656）。不给 = 回 ok:false（没声明能力时 runtime 本不会来问） */
  onHealthQuery?: (query: HealthQuery) => Promise<HealthResult>;
```

`CloudSessionClient` 接口里加：

```ts
  /** 开关变了（#1656）：对当前会话房重发一次 caps。还没 welcome / 没有会话 = 空操作（welcome 那一刻会发） */
  refreshCaps(): void;
```

`case "welcome"` 里，`pushStatus(session);` 之后、发 backlog 的 `try` 之前加：

```ts
        if (deps.deviceCaps !== undefined) sendFrame(session, { t: "caps", ...deps.deviceCaps() });
```

`handleSessionFrame` 的 switch 里（把 Task 2 的占位换掉）加：

```ts
      case "health_query": {
        // 读手机的健康数据（#1656）：结果可能要几秒（HealthKit 查询），不阻塞这条连接的其余帧；
        // 期间人离开了这条会话就不回——runtime 那边会按断开收场
        const answer = deps.onHealthQuery ?? (async (): Promise<HealthResult> => ({ ok: false, error: "这台设备不读健康数据" }));
        void answer(msg.query)
          .catch((e: unknown): HealthResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          .then((result) => {
            if (active === session) sendFrame(session, { t: "health_result", reqId: msg.reqId, result });
          });
        return;
      }
```

返回对象里加：

```ts
    refreshCaps() {
      // ownerUid 由 welcome 填（之前是占位 ""）：welcome 之前发任何帧都会被当成未 hello 拒掉
      if (active === null || active.ownerUid === "" || deps.deviceCaps === undefined) return;
      sendFrame(active, { t: "caps", ...deps.deviceCaps() });
    },
```

（`sendFrame` 的签名是 `sendFrame(session, msg)`，返回值这里不看。若 `ownerUid` 的占位不是 `""`，照 `ActiveSession` 初始化处实际的占位改判据。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/remote/cloudSessionClientHealth.test.ts tests/shared/remote/cloudSessionClient.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/shared/remote/cloudSessionClient.ts tests/shared/remote/cloudSessionClientHealth.test.ts
git commit -m "feat(client): 云会话客户端声明健康能力、应答 health_query（#1656）

两个 dep 都可选：桌面不给就不发 caps；收到 health_query 不阻塞同连接的其余帧。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 手机聊天流画一行「读取了健康数据」

**Files:**
- Modify: `src/shared/mobileChat.ts`（`chatRows` 循环，:226 附近 `for (const e of o.events)` 之前建映射，循环内 `if (e.type === "outreach")` 之前加分支）
- Test: `tests/shared/mobileChat.test.ts`（末尾加 describe）

**Interfaces:**
- Consumes: Task 1 `healthReadLineText`, `READ_HEALTH_TOOL`（从 `src/shared/health.ts` 拿，**不要**从 services import）

- [ ] **Step 1: 写失败测试**——先读 `tests/shared/mobileChat.test.ts` 顶部现成的 `ws` 夹具与事件构造写法，照它加：

```ts
describe("read_health 的那一行（#1656）", () => {
  it("调用 + 成功结果 → 一行灰字 note；其他工具不画", () => {
    const events: SessionEvent[] = [
      { type: "assistant_message", sessionId: "s", seq: 1, ts: 10, agentId: "a1", content: "", toolCalls: [
        { id: "h1", name: "read_health", args: { metrics: ["sleep"], from: "2026-10-04", to: "2026-10-04" } },
        { id: "b1", name: "bash", args: { cmd: "ls" } },
      ] } as SessionEvent,
      { type: "tool_result", sessionId: "s", seq: 2, ts: 11, toolCallId: "h1", status: "ok", output: "…" } as SessionEvent,
      { type: "tool_result", sessionId: "s", seq: 3, ts: 12, toolCallId: "b1", status: "ok", output: "…" } as SessionEvent,
    ];
    const rows = chatRows({ events, ws: WS, selfUid: "me", now: 20 }).filter((r) => r.kind !== "time");
    expect(rows).toEqual([{ kind: "note", key: "health-2", ts: 11, text: "读取了健康数据：睡眠 · 10月4日", tone: "muted", detail: null }]);
  });
  it("失败 → 「没读到健康数据」", () => {
    const events: SessionEvent[] = [
      { type: "assistant_message", sessionId: "s", seq: 1, ts: 10, agentId: "a1", content: "", toolCalls: [{ id: "h1", name: "read_health", args: {} }] } as SessionEvent,
      { type: "tool_result", sessionId: "s", seq: 2, ts: 11, toolCallId: "h1", status: "error", output: "他的手机现在没连着" } as SessionEvent,
    ];
    const rows = chatRows({ events, ws: WS, selfUid: "me", now: 20 }).filter((r) => r.kind !== "time");
    expect(rows).toEqual([{ kind: "note", key: "health-2", ts: 11, text: "没读到健康数据", tone: "muted", detail: null }]);
  });
});
```

（`WS` 换成该文件里现成的 workspace 夹具名；`assistant_message` 的必需字段以 `events.ts` 为准补齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/mobileChat.test.ts -t "read_health"`
Expected: FAIL（rows 为空）

- [ ] **Step 3: 实现**

`mobileChat.ts` import：`import { healthReadLineText, READ_HEALTH_TOOL } from "./health.js";`

`chatRows` 里 `const requests = new Map...` 之前加：

```ts
  // 读健康数据那一行（#1656）：结果要对回调用时的参数（哪几类、哪几天），先把 read_health 的调用收一遍
  const healthCalls = new Map<string, unknown>();
  for (const e of o.events) {
    if (e.type === "assistant_message") for (const c of e.toolCalls ?? []) if (c.name === READ_HEALTH_TOOL) healthCalls.set(c.id, c.args);
  }
```

循环里、`if (e.type === "outreach")` 之前加：

```ts
    // 工具调用手机端一律不画，只有这一把例外（#1656）：读了人的健康数据要让他看得见，在结果那一条的位置画一行灰字
    if (e.type === "tool_result") {
      if (healthCalls.has(e.toolCallId)) {
        items.push({ kind: "note", key: `health-${e.seq}`, ts: e.ts, text: healthReadLineText(healthCalls.get(e.toolCallId), e.status), tone: "muted", detail: null });
      }
      continue;
    }
```

（`continue` 对非健康的 tool_result 与原行为等价：`rowOf` 对 `tool_result` 本来就回 null。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/mobileChat.test.ts tests/shared/health.test.ts tests/runtime/healthTool.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/shared/mobileChat.ts tests/shared/mobileChat.test.ts
git commit -m "feat(mobile-chat): 读了健康数据在聊天里画一行灰字（#1656）

复用 note 行不加新行种；工具调用手机端仍一律不画，只有这一把例外——读了人的健康数据要让他看得见。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 原生模块 `otto-health`（Swift / HealthKit）+ app.json

**Files:**
- Create: `mobile/modules/otto-health/expo-module.config.json`
- Create: `mobile/modules/otto-health/index.ts`
- Create: `mobile/modules/otto-health/ios/OttoHealth.podspec`
- Create: `mobile/modules/otto-health/ios/OttoHealthModule.swift`
- Create: `mobile/modules/otto-health/ios/HealthReader.swift`
- Modify: `mobile/app.json`（`ios.infoPlist`、`ios.entitlements`、`runtimeVersion`）
- Test: `tests/mobile/healthWiring.test.ts`（本 task 只写 app.json 与模块文件的断言；Task 10 往同一文件追加）

**Interfaces:**
- Produces（JS 门面）：

```ts
export interface OttoHealthNative {
  isAvailable(): boolean;
  requestAuthorization(): Promise<boolean>;
  query(metrics: string[], from: string, to: string): Promise<unknown>; // { days, workouts }，形状由 shared 的 parseHealthResult 再验
}
export const OttoHealth: OttoHealthNative | null;
```

- [ ] **Step 1: 写失败测试** `tests/mobile/healthWiring.test.ts`

```ts
// Apple 健康（#1656）手机端的接线。原生与 RN 进不了 vitest，这里读源码钉住安静出错的事：
// ① 权限文案与 entitlement 在 app.json 里（缺 entitlement 时 requestAuthorization 直接报错；缺文案 iOS 直接崩）；
// ② 只读：不出现写入权限文案、Swift 里 toShare 是空集；
// ③ 加了原生模块必须进位 runtimeVersion（publish-ota 据它判热更新能不能发）；
// ④ 模块名两端对得上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const app = JSON.parse(read("mobile/app.json")) as { expo: { runtimeVersion: string; ios: { infoPlist: Record<string, unknown>; entitlements: Record<string, unknown> } } };

describe("app.json", () => {
  it("HealthKit entitlement + 读取文案；没有写入文案", () => {
    expect(app.expo.ios.entitlements["com.apple.developer.healthkit"]).toBe(true);
    expect(app.expo.ios.infoPlist.NSHealthShareUsageDescription).toBe("你问智能体健康相关的问题时，读取你的步数、睡眠、心率、体重和体能训练来回答。");
    expect(app.expo.ios.infoPlist.NSHealthUpdateUsageDescription).toBeUndefined();
  });
  it("runtimeVersion 进位到 7（加了原生模块）", () => {
    expect(app.expo.runtimeVersion).toBe("7");
  });
});

describe("otto-health 模块", () => {
  const swift = read("mobile/modules/otto-health/ios/OttoHealthModule.swift");
  const reader = read("mobile/modules/otto-health/ios/HealthReader.swift");
  it("名字两端一致", () => {
    expect(swift).toMatch(/Name\("OttoHealth"\)/);
    expect(read("mobile/modules/otto-health/index.ts")).toMatch(/requireOptionalNativeModule<OttoHealthNative>\("OttoHealth"\)/);
    expect(read("mobile/modules/otto-health/expo-module.config.json")).toMatch(/"OttoHealthModule"/);
  });
  it("只读：toShare 为空", () => {
    expect(swift).toMatch(/requestAuthorization\(toShare: \[\], read: HealthReader\.readTypes\)/);
  });
  it("读的是 14 类里那些类型（每类一个标识）", () => {
    for (const id of ["stepCount", "distanceWalkingRunning", "activeEnergyBurned", "flightsClimbed", "appleExerciseTime", "appleStandHour",
      "sleepAnalysis", "heartRate", "restingHeartRate", "heartRateVariabilitySDNN", "oxygenSaturation", "bodyMass", "bodyFatPercentage", "workoutType"]) {
      expect(reader).toContain(id);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mobile/healthWiring.test.ts`
Expected: FAIL（文件不存在 / runtimeVersion 是 "6"）

- [ ] **Step 3: 实现**

`mobile/modules/otto-health/expo-module.config.json`：

```json
{
  "platforms": ["apple"],
  "apple": {
    "modules": ["OttoHealthModule"]
  }
}
```

`mobile/modules/otto-health/index.ts`：

```ts
// Apple 健康（#1656）原生模块的 JS 一侧：Swift 在 ios/，读 HealthKit 按天汇总。
//
// **Expo Go 里没有它**（同 otto-speech / otto-paste）：requireOptionalNativeModule 回 null，设置页的开关置灰。
// query 回来的东西不在这里信任——交给 shared 的 answerHealthQuery → parseHealthResult 再验一遍。
import { requireOptionalNativeModule } from "expo";

export interface OttoHealthNative {
  isAvailable(): boolean;
  requestAuthorization(): Promise<boolean>;
  query(metrics: string[], from: string, to: string): Promise<unknown>;
}

export const OttoHealth: OttoHealthNative | null = requireOptionalNativeModule<OttoHealthNative>("OttoHealth");
```

`mobile/modules/otto-health/ios/OttoHealth.podspec`：

```ruby
# Apple 健康（#1656）：读 HealthKit 按天汇总给智能体。Expo 本地模块，autolinking 从 mobile/modules/ 找到它。
Pod::Spec.new do |s|
  s.name           = 'OttoHealth'
  s.version        = '1.0.0'
  s.summary        = 'Mr Otto mobile: read Apple Health daily summaries for agents'
  s.description    = 'Read-only HealthKit queries aggregated per day, answered over the cloud session (#1656).'
  s.author         = ''
  s.homepage       = 'https://github.com/real-stanyan/Mr-Otto'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'HealthKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
```

`mobile/modules/otto-health/ios/OttoHealthModule.swift`：

```swift
import ExpoModulesCore
import HealthKit

// Apple 健康（#1656）：三个入口——有没有健康数据、请求读取授权、按天汇总查询。只读：toShare 永远是空集。
// 读权限被拒时 HealthKit 不告诉 App（查询照常成功、只是空），所以这里不区分「没授权」与「没数据」，交给模型照实说。
public class OttoHealthModule: Module {
  private let store = HKHealthStore()

  public func definition() -> ModuleDefinition {
    Name("OttoHealth")

    Function("isAvailable") { () -> Bool in
      HKHealthStore.isHealthDataAvailable()
    }

    AsyncFunction("requestAuthorization") { (promise: Promise) in
      guard HKHealthStore.isHealthDataAvailable() else {
        promise.reject("E_UNAVAILABLE", "这台设备没有健康数据")
        return
      }
      self.store.requestAuthorization(toShare: [], read: HealthReader.readTypes) { ok, error in
        if let error {
          promise.reject("E_AUTH", error.localizedDescription)
        } else {
          promise.resolve(ok)
        }
      }
    }

    AsyncFunction("query") { (metrics: [String], from: String, to: String) async throws -> [String: Any] in
      try await HealthReader(store: self.store).read(metrics: Set(metrics), from: from, to: to)
    }
  }
}
```

`mobile/modules/otto-health/ios/HealthReader.swift`：

```swift
import Foundation
import HealthKit

// 按天汇总（#1656，spec §3.3）：在手机当前时区按自然日切。
// · 累计类：HKStatisticsCollectionQuery .cumulativeSum
// · 心率 / 血氧：min / avg / max；静息心率、HRV：avg
// · 体重 / 体脂：每天最后一条
// · 站立小时：appleStandHour 里 stood 的样本数
// · 睡眠：样本按分期累加分钟，归到样本结束（醒来）那天；当天有 Apple Watch 来源时只用手表的（防手表 + 手机重复计）
// · 训练：HKWorkout 列表
// 输出 { days: [[String: Any]], workouts: [[String: Any]] }，键名对 src/shared/health.ts 的 HealthDay / HealthWorkout。
struct HealthReader {
  let store: HKHealthStore

  static let readTypes: Set<HKObjectType> = [
    HKQuantityType(.stepCount), HKQuantityType(.distanceWalkingRunning), HKQuantityType(.activeEnergyBurned),
    HKQuantityType(.flightsClimbed), HKQuantityType(.appleExerciseTime), HKCategoryType(.appleStandHour),
    HKCategoryType(.sleepAnalysis),
    HKQuantityType(.heartRate), HKQuantityType(.restingHeartRate), HKQuantityType(.heartRateVariabilitySDNN), HKQuantityType(.oxygenSaturation),
    HKQuantityType(.bodyMass), HKQuantityType(.bodyFatPercentage),
    HKObjectType.workoutType(),
  ]

  private var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = .current
    return c
  }

  private func dayKey(_ d: Date) -> String {
    let f = DateFormatter()
    f.calendar = calendar
    f.timeZone = .current
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: d)
  }

  private func parseDay(_ s: String) throws -> Date {
    let f = DateFormatter()
    f.calendar = calendar
    f.timeZone = .current
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    guard let d = f.date(from: s) else { throw NSError(domain: "OttoHealth", code: 1, userInfo: [NSLocalizedDescriptionKey: "日期不对：\(s)"]) }
    return calendar.startOfDay(for: d)
  }

  private static func round1(_ x: Double) -> Double { (x * 10).rounded() / 10 }

  func read(metrics: Set<String>, from: String, to: String) async throws -> [String: Any] {
    let start = try parseDay(from)
    let end = calendar.date(byAdding: .day, value: 1, to: try parseDay(to))!
    var days: [String: [String: Any]] = [:]
    func put(_ key: String, _ field: String, _ value: Any) { days[key, default: ["date": key]][field] = value }

    let sums: [(String, HKQuantityTypeIdentifier, HKUnit, String)] = [
      ("steps", .stepCount, .count(), "steps"),
      ("distance", .distanceWalkingRunning, .meter(), "distanceM"),
      ("activeEnergy", .activeEnergyBurned, .kilocalorie(), "activeKcal"),
      ("flights", .flightsClimbed, .count(), "flights"),
      ("exerciseMinutes", .appleExerciseTime, .minute(), "exerciseMin"),
    ]
    for (metric, id, unit, field) in sums where metrics.contains(metric) {
      for (day, s) in try await collection(id, .cumulativeSum, start: start, end: end) {
        if let q = s.sumQuantity() { put(day, field, Self.round1(q.doubleValue(for: unit))) }
      }
    }

    let bpm = HKUnit.count().unitDivided(by: .minute())
    if metrics.contains("heartRate") {
      for (day, s) in try await collection(.heartRate, [.discreteMin, .discreteAverage, .discreteMax], start: start, end: end) {
        if let mn = s.minimumQuantity(), let av = s.averageQuantity(), let mx = s.maximumQuantity() {
          put(day, "heartRate", ["min": Self.round1(mn.doubleValue(for: bpm)), "avg": Self.round1(av.doubleValue(for: bpm)), "max": Self.round1(mx.doubleValue(for: bpm))])
        }
      }
    }
    let averages: [(String, HKQuantityTypeIdentifier, HKUnit, String)] = [
      ("restingHeartRate", .restingHeartRate, bpm, "restingHeartRate"),
      ("hrv", .heartRateVariabilitySDNN, .secondUnit(with: .milli), "hrv"),
    ]
    for (metric, id, unit, field) in averages where metrics.contains(metric) {
      for (day, s) in try await collection(id, .discreteAverage, start: start, end: end) {
        if let q = s.averageQuantity() { put(day, field, Self.round1(q.doubleValue(for: unit))) }
      }
    }
    if metrics.contains("spo2") {
      for (day, s) in try await collection(.oxygenSaturation, [.discreteMin, .discreteAverage], start: start, end: end) {
        if let mn = s.minimumQuantity(), let av = s.averageQuantity() {
          put(day, "spo2", ["min": Self.round1(mn.doubleValue(for: .percent()) * 100), "avg": Self.round1(av.doubleValue(for: .percent()) * 100)])
        }
      }
    }

    let latest: [(String, HKQuantityTypeIdentifier, (HKQuantity) -> Double, String)] = [
      ("bodyMass", .bodyMass, { $0.doubleValue(for: .gramUnit(with: .kilo)) }, "bodyMassKg"),
      ("bodyFat", .bodyFatPercentage, { $0.doubleValue(for: .percent()) * 100 }, "bodyFatPct"),
    ]
    for (metric, id, value, field) in latest where metrics.contains(metric) {
      let samples = try await samples(HKQuantityType(id), start: start, end: end) as? [HKQuantitySample] ?? []
      for s in samples { put(dayKey(s.endDate), field, Self.round1(value(s.quantity))) } // 按 endDate 升序，后写的覆盖 = 当天最后一条
    }

    if metrics.contains("standHours") {
      let samples = try await samples(HKCategoryType(.appleStandHour), start: start, end: end) as? [HKCategorySample] ?? []
      var count: [String: Int] = [:]
      for s in samples where s.value == HKCategoryValueAppleStandHour.stood.rawValue { count[dayKey(s.startDate), default: 0] += 1 }
      for (day, n) in count { put(day, "standHours", n) }
    }

    if metrics.contains("sleep") {
      // 醒来那天算：取 [start-12h, end) 里结束于 [start, end) 的样本
      let raw = try await samples(HKCategoryType(.sleepAnalysis), start: start.addingTimeInterval(-12 * 3600), end: end) as? [HKCategorySample] ?? []
      let inRange = raw.filter { $0.endDate > start && $0.endDate <= end }
      let byDay = Dictionary(grouping: inRange) { dayKey($0.endDate.addingTimeInterval(-1)) }
      for (day, list) in byDay {
        let watch = list.filter { ($0.sourceRevision.productType ?? "").hasPrefix("Watch") }
        let use = watch.isEmpty ? list : watch
        var mins: [String: Double] = [:]
        for s in use {
          let m = s.endDate.timeIntervalSince(s.startDate) / 60
          guard let stage = HKCategoryValueSleepAnalysis(rawValue: s.value) else { continue }
          switch stage {
          case .inBed: mins["inBedMin", default: 0] += m
          case .awake: mins["awakeMin", default: 0] += m
          case .asleepCore: mins["coreMin", default: 0] += m; mins["asleepMin", default: 0] += m
          case .asleepDeep: mins["deepMin", default: 0] += m; mins["asleepMin", default: 0] += m
          case .asleepREM: mins["remMin", default: 0] += m; mins["asleepMin", default: 0] += m
          case .asleepUnspecified: mins["asleepMin", default: 0] += m
          @unknown default: break
          }
        }
        if !mins.isEmpty { put(day, "sleep", mins.mapValues { $0.rounded() }) }
      }
    }

    var workouts: [[String: Any]] = []
    if metrics.contains("workouts") {
      let iso = ISO8601DateFormatter()
      iso.timeZone = .current
      iso.formatOptions = [.withInternetDateTime]
      let list = try await samples(HKObjectType.workoutType(), start: start, end: end) as? [HKWorkout] ?? []
      for w in list {
        var o: [String: Any] = [
          "start": iso.string(from: w.startDate), "end": iso.string(from: w.endDate),
          "type": Self.typeName(w.workoutActivityType), "durationMin": Self.round1(w.duration / 60),
        ]
        for id in [HKQuantityTypeIdentifier.distanceWalkingRunning, .distanceCycling, .distanceSwimming] {
          if let q = w.statistics(for: HKQuantityType(id))?.sumQuantity() { o["distanceM"] = Self.round1(q.doubleValue(for: .meter())); break }
        }
        if let q = w.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity() { o["activeKcal"] = Self.round1(q.doubleValue(for: .kilocalorie())) }
        workouts.append(o)
      }
    }

    return ["days": days.keys.sorted().map { days[$0]! }, "workouts": workouts]
  }

  private func collection(_ id: HKQuantityTypeIdentifier, _ options: HKStatisticsOptions, start: Date, end: Date) async throws -> [String: HKStatistics] {
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    return try await withCheckedThrowingContinuation { cont in
      let q = HKStatisticsCollectionQuery(quantityType: HKQuantityType(id), quantitySamplePredicate: predicate, options: options,
                                          anchorDate: start, intervalComponents: DateComponents(day: 1))
      q.initialResultsHandler = { _, results, error in
        if let error {
          if (error as? HKError)?.code == .errorNoData { cont.resume(returning: [:]) } else { cont.resume(throwing: error) }
          return
        }
        var out: [String: HKStatistics] = [:]
        results?.enumerateStatistics(from: start, to: end) { s, _ in out[self.dayKey(s.startDate)] = s }
        cont.resume(returning: out)
      }
      store.execute(q)
    }
  }

  private func samples(_ type: HKSampleType, start: Date, end: Date) async throws -> [HKSample] {
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
    return try await withCheckedThrowingContinuation { cont in
      let q = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit,
                            sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)]) { _, results, error in
        if let error {
          if (error as? HKError)?.code == .errorNoData { cont.resume(returning: []) } else { cont.resume(throwing: error) }
          return
        }
        cont.resume(returning: results ?? [])
      }
      store.execute(q)
    }
  }

  static func typeName(_ t: HKWorkoutActivityType) -> String {
    switch t {
    case .running: return "running"
    case .walking: return "walking"
    case .cycling: return "cycling"
    case .swimming: return "swimming"
    case .hiking: return "hiking"
    case .yoga: return "yoga"
    case .functionalStrengthTraining: return "functionalStrengthTraining"
    case .traditionalStrengthTraining: return "traditionalStrengthTraining"
    case .highIntensityIntervalTraining: return "highIntensityIntervalTraining"
    case .elliptical: return "elliptical"
    case .rowing: return "rowing"
    case .stairClimbing: return "stairClimbing"
    case .dance: return "dance"
    case .pilates: return "pilates"
    case .coreTraining: return "coreTraining"
    default: return "other(\(t.rawValue))"
    }
  }
}
```

`mobile/app.json`：`ios.infoPlist` 里加一格（放在 `NSCameraUsageDescription` 之后）：

```json
"NSHealthShareUsageDescription": "你问智能体健康相关的问题时，读取你的步数、睡眠、心率、体重和体能训练来回答。"
```

`ios.entitlements` 加 `"com.apple.developer.healthkit": true`；`"runtimeVersion": "6"` 改 `"7"`。

- [ ] **Step 4: 跑测试确认通过 + Swift 编译自检**

Run: `npx vitest run tests/mobile/healthWiring.test.ts`
Expected: PASS

Swift 编译自检（不进门禁，但要真编一遍）：`cd mobile && npx expo prebuild --platform ios --no-install && cd ios && pod install && xcodebuild -workspace *.xcworkspace -scheme Otto -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO | tail -30`（`mobile/ios/` 是 gitignored 的生成物；scheme 名以 `xcodebuild -list` 为准）。
Expected: `** BUILD SUCCEEDED **`。编不过就按报错修 Swift（常见：`HKQuantityType(.x)` 便利构造要 iOS 15+，podspec 已是 16.4；`Promise` 名与 Swift 并发冲突时写 `ExpoModulesCore.Promise`）。

- [ ] **Step 5: commit**

```bash
git add mobile/modules/otto-health mobile/app.json tests/mobile/healthWiring.test.ts
git commit -m "feat(mobile): otto-health 原生模块——HealthKit 按天汇总（#1656）

只读（toShare 空集）；睡眠归醒来那天、有手表来源时只用手表的防重复；加原生模块所以 runtimeVersion 6 → 7。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 手机 JS：开关、cloudClient 接线、设置页

**Files:**
- Create: `mobile/src/health/healthPrefs.ts`
- Modify: `mobile/src/cloud/cloudClient.ts`（`createCloudSessionClient({...})` 参数 + 文件末尾订阅）
- Modify: `mobile/src/account/SettingsScreen.tsx`（「隐私」组之后加一组）
- Modify: `mobile/App.tsx`（`void loadThemePref();` :33 旁）
- Test: `tests/mobile/healthWiring.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `answerHealthQuery`；Task 7 `deviceCaps` / `onHealthQuery` / `refreshCaps`；Task 9 `OttoHealth`
- Produces（`mobile/src/health/healthPrefs.ts`）：

```ts
export function healthEnabled(): boolean;
export function healthAvailable(): boolean;
export function useHealthEnabled(): boolean;
export function onHealthPrefChange(cb: () => void): void;
export async function loadHealthPref(): Promise<void>;
export async function setHealthEnabled(on: boolean): Promise<void>; // 打开时先请求授权，失败抛错且保持关
export function readHealth(q: HealthQuery): Promise<unknown>;
```

- [ ] **Step 1: 写失败测试**——在 `tests/mobile/healthWiring.test.ts` 末尾追加：

```ts
describe("手机 JS 接线", () => {
  const prefs = read("mobile/src/health/healthPrefs.ts");
  const client = read("mobile/src/cloud/cloudClient.ts");
  const settings = read("mobile/src/account/SettingsScreen.tsx");
  it("开关存在这台手机的 kv-store、默认关", () => {
    expect(prefs).toMatch(/import AsyncStorage from "expo-sqlite\/kv-store";/);
    expect(prefs).toMatch(/const KEY = "otto\.health";/);
    expect(prefs).toMatch(/createStore<\{ on: boolean \}>\(\{ on: false \}\)/);
  });
  it("打开前先请求授权；不可用就不让开", () => {
    expect(prefs).toMatch(/await OttoHealth\.requestAuthorization\(\)/);
    expect(prefs).toMatch(/if \(!healthAvailable\(\)\) throw new Error/);
  });
  it("cloudClient：声明能力、应答走 answerHealthQuery、开关变了重发 caps", () => {
    expect(client).toMatch(/deviceCaps: \(\) => \(\{ health: healthEnabled\(\) \}\),/);
    expect(client).toMatch(/onHealthQuery: \(q\) => answerHealthQuery\(q, \{ enabled: healthEnabled, read: readHealth \}\),/);
    expect(client).toMatch(/onHealthPrefChange\(\(\) => cloudClient\.refreshCaps\(\)\);/);
  });
  it("设置页有 Apple 健康这一组", () => {
    expect(settings).toMatch(/header="Apple 健康"/);
    expect(settings).toMatch(/setHealthEnabled\(/);
  });
  it("冷启动读开关", () => {
    expect(read("mobile/App.tsx")).toMatch(/void loadHealthPref\(\);/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mobile/healthWiring.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现**

`mobile/src/health/healthPrefs.ts`：

```ts
// Apple 健康开关（#1656，spec §2.1）：默认关，存在这台手机的 kv-store（同外观偏好——属于这台手机，不跟账号走）。
// 打开 = 先弹 iOS 的 HealthKit 授权页，再向云端声明「这台能读健康」（cloudClient 订阅这里的变化重发 caps）。
// iOS 不告诉 App 哪几类被拒了：授权页点了「不允许」开关照样是开的，只是读出来是空——设置页的说明写清去哪改。
import AsyncStorage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import type { HealthQuery } from "../../../src/shared/health.js";
import { OttoHealth } from "../../modules/otto-health/index.js";
import { createStore } from "../externalStore.js";

const KEY = "otto.health";
const store = createStore<{ on: boolean }>({ on: false });
const listeners = new Set<() => void>();

export function healthAvailable(): boolean {
  return OttoHealth !== null && OttoHealth.isAvailable();
}

export function healthEnabled(): boolean {
  return store.get().on && healthAvailable();
}

export function useHealthEnabled(): boolean {
  return useSyncExternalStore(store.subscribe, () => store.get().on);
}

/** 开关变了（cloudClient 用它重发 caps）。不回退订：订阅方是模块顶层，活到进程结束 */
export function onHealthPrefChange(cb: () => void): void {
  listeners.add(cb);
}

function apply(on: boolean): void {
  store.set({ on });
  for (const cb of listeners) cb();
}

/** 冷启动读一次（App.tsx 顶层调）；读不到 = 关 */
export async function loadHealthPref(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch {
    // 读不到 = 关
  }
  apply(raw === "1");
}

/** 打开时先请求授权：抛错 = 没打开（调用方把 message 画出来） */
export async function setHealthEnabled(on: boolean): Promise<void> {
  if (on) {
    if (!healthAvailable()) throw new Error("这台设备读不了健康数据");
    await OttoHealth!.requestAuthorization();
  }
  apply(on);
  try {
    if (on) await AsyncStorage.setItem(KEY, "1");
    else await AsyncStorage.removeItem(KEY);
  } catch {
    // 存不下：这一次照样生效，下次冷启动回到关
  }
}

export function readHealth(q: HealthQuery): Promise<unknown> {
  if (OttoHealth === null) return Promise.reject(new Error("这个版本的 App 没有健康模块"));
  return OttoHealth.query(q.metrics, q.from, q.to);
}
```

（`createStore` 的签名以 `mobile/src/externalStore.ts` 为准——`themePref.ts` 就是这样用的。`setHealthEnabled` 里 `healthAvailable()` 的检查写法要能匹配测试正则 `if (!healthAvailable()) throw new Error`。）

`mobile/src/cloud/cloudClient.ts`：import

```ts
import { answerHealthQuery } from "../../../src/shared/health.js";
import { healthEnabled, onHealthPrefChange, readHealth } from "../health/healthPrefs.js";
```

`createCloudSessionClient({` 参数里 `deviceTz` 之后加：

```ts
  // Apple 健康（#1656）：开着才声明能力；runtime 来问时开关再判一次（问的那一刻可能刚关）
  deviceCaps: () => ({ health: healthEnabled() }),
  onHealthQuery: (q) => answerHealthQuery(q, { enabled: healthEnabled, read: readHealth }),
```

文件末尾加：

```ts
// 开关变了当场告诉 runtime（#1656）：不然要等下次进房 welcome 才更新，关掉之后那段时间它还会来问
onHealthPrefChange(() => cloudClient.refreshCaps());
```

`mobile/App.tsx`：`import { loadHealthPref } from "./src/health/healthPrefs.js";`，`void loadThemePref();` 下一行加 `void loadHealthPref();`

`mobile/src/account/SettingsScreen.tsx`：import

```ts
import { healthAvailable, setHealthEnabled, useHealthEnabled } from "../health/healthPrefs.js";
```

组件内（`const notify = useNotify();` 之后）加：

```ts
  const healthOn = useHealthEnabled();
  const [healthError, setHealthError] = useState<string | null>(null);
  const toggleHealth = (v: boolean): void => {
    setHealthError(null);
    void setHealthEnabled(v).catch((e: unknown) => setHealthError(e instanceof Error ? e.message : String(e)));
  };
```

「隐私」那组之后加：

```tsx
      <Group
        header="Apple 健康"
        footer={
          healthAvailable()
            ? "打开后，你问智能体健康相关的问题时，它会从这台手机读取步数、睡眠、心率、体重和体能训练（按天汇总）。只在 Otto 开着时能读。哪几类能读，在 iOS「健康」App → 共享 → App → Otto 里改。"
            : "这台设备读不了健康数据。"
        }
      >
        {healthAvailable() ? toggle("允许智能体读取", healthOn, toggleHealth) : null}
      </Group>
      {healthError !== null ? <Inset><Note tone="error">{healthError}</Note></Inset> : null}
```

- [ ] **Step 4: 跑测试确认通过 + 手机 tsc**

Run: `npx vitest run tests/mobile/healthWiring.test.ts && npx tsc --noEmit -p mobile`
Expected: PASS，无类型错误（`mobile/node_modules` 缺就先 `npm --prefix mobile ci`）

- [ ] **Step 5: commit**

```bash
git add mobile/src/health mobile/src/cloud/cloudClient.ts mobile/src/account/SettingsScreen.tsx mobile/App.tsx tests/mobile/healthWiring.test.ts
git commit -m "feat(mobile): Apple 健康开关与接线（#1656）

默认关；打开先弹授权；开关一变当场重发 caps，不等下次进房。iOS 不告诉 App 哪类被拒，说明里写清去哪改。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: ADR + 索引 + 词汇

**Files:**
- Create: `docs/adr/NNNN-device-executed-tool-channel.md`（`NNNN` = `ls docs/adr | sort | tail -1` 的号 + 1；合并前 re-fetch，撞号按 ADR-0074 改号）
- Modify: `docs/where-to-find-things.md`（照现有条目格式加一条）
- Modify: `CONTEXT.md`（产品/技术术语那一节加「设备能力（caps）」）
- Test: `tests/docs/adrNumbers.test.ts`（现成，不改）

- [ ] **Step 1: 写 ADR**

```markdown
# NNNN. 手机端执行的工具通道（Apple 健康读取）

- 状态：已采纳
- 日期：2026-10-05
- Issue：#1656；spec：docs/superpowers/specs/2026-10-05-apple-health-design.md

## 背景

维护者要智能体能读手机的 Apple 健康数据，选了「按需拉取、工具在手机上跑」与「只读说话人自己的手机」。此前没有任何在手机上执行的工具：
手机只是云 runtime 的 guest 连接（ADR-0317），跨设备工具只有借来工具 px（ADR-0151 / ADR-0197），都不在手机上跑。

## 决定

1. **能力声明 + 定向请求帧**（协议 29）：手机 welcome 后发 `caps{health}`，开关变动再发；runtime 的 healthBroker 记「哪条 cid 能读」，
   `read_health` 调用时按这一轮的发起人现选该 uid 最近声明的那条 cid，单发 `health_query`，只认那条 cid 回的 `health_result`。
   30 秒超时、cid 断开、turn 中断都收成 ok:false 抛给模型。
2. **cid 调用时现选**：手机切后台即断 WS、回前台换新 cid，turn 开始时那条可能已经没了。
3. **挂载判据** `healthTurnEligible`：人亲口、非接力 / 定时 / 汇报 / 补跑；主场（approveAll）里只认主人；团队会话里任一成员（读他自己的）。
   且发起人此刻有能力连接才亮。
4. **结果照常落盘**：作为普通 `tool_result` 进事件日志（Hard rule「先落盘再喂模型」），只回按天汇总减少落盘量。
5. 不弹审批；手机聊天流对这一把工具例外地画一行灰字，让人看得见读了什么。

## 否掉的

- **事件日志驱动（仿审批卡）**：请求广播全房、桌面也收到、要客户端过滤；而发问的人此刻必在前台，重连补答价值低。
- **复用 px 通道**：那是 MCP server + 凭据托管的形状，手机两样都不是。
- **手机定期同步到云端**：健康数据长期存服务端，维护者没选。
- **手动附带**：智能体不能主动看，维护者没选。

## 后果

- 健康数据会留在云端会话库（随会话删除而删除）；隐私政策与 App Review 备注要写明（维护者操作）。
- 这是第一条「runtime → 指定设备 → runtime」的工具通道；以后再加设备端工具（定位、日历…）照这个形状加能力位与请求帧，不另起炉灶。
- 推翻前提：若要在手机锁屏 / 后台时也能读（例如定时任务汇报健康），需要静默推送唤醒 + 新的授权模型，另立 ADR。
```

- [ ] **Step 2: 索引与词汇**——`docs/where-to-find-things.md` 先 `grep -n "pxTools\|healthBroker" docs/where-to-find-things.md` 看现有条目格式，照格式加：

```markdown
- `services/runtime/src/healthBroker.ts` / `healthTool.ts`、`src/shared/health.ts`、`mobile/modules/otto-health/` — Apple 健康按需读取：手机声明能力（caps）、runtime 定向发 health_query、read_health 调用时现选 cid；挂载判据 healthTurnEligible（ADR-NNNN，#1656）
```

`CONTEXT.md` 产品/技术术语节加：

```markdown
- **设备能力（caps）**：手机经 `caps` 帧向云 runtime 声明「这条连接能替智能体做什么」（目前只有读 Apple 健康）。runtime 只向声明了能力的连接发对应请求帧（ADR-NNNN）。
```

- [ ] **Step 3: 跑 ADR 编号测试**

Run: `npx vitest run tests/docs/adrNumbers.test.ts`
Expected: PASS

- [ ] **Step 4: commit**

```bash
git add docs/adr CONTEXT.md docs/where-to-find-things.md
git commit -m "docs(adr): 手机端执行的工具通道（#1656）

第一条 runtime → 指定设备 → runtime 的工具通道；以后的设备端工具照这个形状加能力位。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 门禁、PR、交付清单

- [ ] **Step 1: 全量门禁**

Run: `npm test > /tmp/claude-gate.log 2>&1; echo GATE_EXIT=$?` 然后 `tail -40 /tmp/claude-gate.log`
Expected: `GATE_EXIT=0`（不接 `| tail` 跑门禁本身：管道吞退出码）

- [ ] **Step 2: 推送 + 开 PR**（合并前 re-fetch，核对 origin/main 的 `CS_PROTOCOL_VERSION` 与 ADR 最大号；撞了按 Global Constraints 改号）

```bash
git fetch origin
git push -u origin HEAD
gh pr create --title "feat: 手机上接 Apple 健康，智能体按需读说话人自己的数据（#1656）" --body-file /tmp/claude-pr-body.md
```

PR body 写：做了什么（引用 spec / ADR）、协议 29 需与 runtime 同发、维护者待办（Apple 开发者后台 App ID 勾 HealthKit、隐私政策补段、送审备注、TestFlight build 10 上传前确认）、真机冒烟步骤（见 Step 3）。结尾 `Closes #1656` + `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

- [ ] **Step 3: 真机 / 模拟器冒烟（门禁之外，记进 PR）**
  1. 模拟器：「健康」App 手动加步数、睡眠、心率样本。
  2. dev 构建跑起来 → 设置 → Apple 健康 → 打开 → 授权页全允许。
  3. 私聊里问「我今天走了多少步、昨晚睡得怎样」→ 聊天里出现「读取了健康数据：活动、睡眠 · …」灰字，回答里数字与「健康」App 一致。
  4. 关掉开关再问 → 智能体说读不到（工具不亮或回「关掉了」）。
  5. 切后台再从桌面端问 → 智能体说手机没连着。
  需要部署 runtime 才能在云上测（见 memory「云 UI 真机验收怎么跑」）；部署与 TestFlight 上传都先问维护者。
