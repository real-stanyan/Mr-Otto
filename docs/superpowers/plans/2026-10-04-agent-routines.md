# 智能体的定时任务（routine）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每只账号级智能体能记住用户口头交代的定时任务（一次性 / 每天 / 每周几），到点由云 runtime 替主人在它的私聊里起一轮去执行；手机端智能体资料页能看、改、停、删这些任务。

**Architecture:** 一张 `agent_routines` 表 + `src/shared/routines.ts` 一份纯函数（下一跳 / 校验 / 文案，runtime 与手机共用）。runtime daemon 里一条 30 秒 tick 的调度器，原子认领到点的行，然后走现成那条自起 turn 的路（`user_message{greeting:"routine"}` → `coordinator.enqueue` → `startDrain`）。模型侧三把刀（`schedule_task` / `list_schedules` / `update_schedule`）写同一张表。时区由手机 `say` 帧带上、落在 `user_message.tz`，模型投影的「今天是」按它算。

**Tech Stack:** TypeScript strict（`exactOptionalPropertyTypes` 开着：可选字段只能「不写」不能塞 `undefined`）、vitest（测试在 `tests/` 镜像 `src/`）、Supabase（migration 手动跑）、Expo / React Native（手机端，纯 JS，不加原生依赖）。

**Spec:** `docs/superpowers/specs/2026-10-04-agent-routines-design.md`（下文「spec §n」指它的章节）。

## Global Constraints

- 硬规则：append-only 日志是唯一事实来源；模型可见的内容必须已落盘（routine 开场白正文里带时间与时区，不从库注入提示词）。
- 硬规则：工具实现只依赖注入的接口，不 import fs / child_process / supabase（`routineTools.ts` 只认 `RoutineStore`）。
- `SessionEvent` schema 只能加可选字段 / 加 `ignorable: true` 的新事件；旧日志必须照常重放。
- 不造第二种起 turn 的机制（ADR-0223）：routine 轮与 `greetNewAgent` / `reportOutreach` 同一条路。
- `greeting` 加取值**不进协议位**；`say` 帧的 `tz` 是可选字段，`CS_PROTOCOL_VERSION`（现为 24）**不升**。
- 手机端不加原生依赖（ADR-0340：原生改动走不了热更新）；表单类流程用居中 `Dialog`，不用底部抽屉。
- 数字常量（spec §2–§5）：标题 ≤ 40 字、任务原话 ≤ 2000 字、每只启用中 ≤ 20 条、一次性漏跑宽限 2 小时、重复漏跑宽限 10 分钟、同一任务两次执行间隔 ≥ 60 秒、routine 轮圈数上限 40、额度门 = 剩余周额度 < `limitMicro * RELAY_BUDGET_FRACTION_OF_REMAINING`（0.1）、已完成的一次性任务留 7 天。
- 最新 migration 是 0055 → 本期是 **0056**；最新 ADR 是 0352 → 本期 **0353**（合并前按 ADR-0074 重核编号）。（合并主干后实际号：migration 先改为 0057——0056 被共享车道占了；ADR 先改为 0356。再次合并主干又撞：0356 / 0057 被「公开智能体」占了，终版 migration **0058**；ADR 第三次撞——0357 被「人与人电话」占了——终版 ADR **0358**。）
- 门禁：`npm test`（`tsc --noEmit` + 手机端 `tsc --noEmit` + `vitest run`）。跑之前 `npm --prefix mobile ci` 一次。
- 提交信息写**为什么**，中文，结尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## 对 spec 的三处小修（实现时以本计划为准，Task 14 把它们写回 spec）

1. spec §5.4 说圈数到数「追加一条 assistant_message」。改为**抛错走既有的 `turn_ended{outcome:"error"}` 收口路径**（与 `loopGuardMaxNudges` 同一条路，不新造事件、不伪造模型发言）。手机上它画成「「x」这一轮出错」那条灰条，错误文案里写清是定时任务的硬上限。
2. spec §2.1 的 `session_id` 列**去掉**：runtime 到点用 `findDmSession(workspaceId, [agentId])`（0037 的唯一索引是权威）现查私聊；查不到 = `failed` 并停用。手机手动新建任务前先 `cloudClient.create(ws, {kind:"dm", agentId})`（runtime 对私聊幂等）保证私聊存在。
3. spec §4.3「桌面云会话时间线同一条规则」改为：**桌面照旧藏**（`hiddenFromCloudTimeline` 对 `greeting` 一族与 `routine_note` 都回 true），只有手机画灰条——桌面不在本期。spec §2.3 的夏令时「顺延到跳过后的第一个合法时刻」改为「按跳过的长度后移（02:30 → 03:30，ICU / Java 的惯例）」。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/shared/routines.ts`（新） | 类型、常量、`parseRoutineSchedule`、`routineErrors`、`isIanaTimeZone`、`zonedParts` / `wallClockToUtc`（夏令时）、`nextRunAt`、`scheduleText` / `formatInTz` / `routineOpeningText` / `routineNoteText`、工具名常量。**纯函数，零依赖** |
| `src/shared/supabaseRoutinesApi.ts`（新） | 手机（将来桌面）直接读写 `agent_routines` 与 `profiles.timezone` 的薄封装 + 行映射 `routineRowOf` |
| `supabase/migrations/0057_agent_routines.sql`（新） | 表 + 索引 + RLS + `profiles.timezone` |
| `src/session/events.ts` | `UserMessageEvent.greeting` 加 `"routine"`、加 `routine?` / `tz?`；新 `RoutineNoteEvent`；`KNOWN_EVENT_TYPES_MAP` 登记 |
| `src/shared/sessionPackage.ts` / `src/shared/taskSync.ts` / `src/shared/cloudTimeline.ts` | 三张穷举表给 `routine_note` 表态 |
| `src/shared/outreach.ts` | `openingTraits` 对 `greeting:"routine"` 的 `ownerSpoke` 放行 |
| `src/shared/mobileChat.ts` | routine 开场白 → 居中灰条；`routine_note` → 灰条 |
| `src/session/deriveMessages.ts` / `src/shared/contextEstimate.ts` | 「今天是」按最近一条 `user_message.tz` 算 |
| `src/shared/remote/cloudSession.ts` / `cloudSessionClient.ts` | `say` 帧可选 `tz` 的编解码与发送 |
| `src/loop/engine.ts` | 可选 `maxRounds` |
| `services/runtime/src/routineStore.ts`（新） | `RoutineStore` 接口 + Supabase 实现 + 内存实现（测试用） |
| `services/runtime/src/routineTools.ts`（新） | 三把刀 |
| `services/runtime/src/routineScheduler.ts`（新） | tick / 认领 / 漏跑 / 额度门 / 清理，全部依赖注入 |
| `services/runtime/src/routineRun.ts`（新） | daemon 侧「找私聊 → 开房 → runRoutine / logRoutineNote」那一段编排（进得了 vitest） |
| `services/runtime/src/sessionService.ts` | `runRoutine` / `logRoutineNote`、挂刀、`routineTurn` 旗与 `maxRounds`、`say()` 的 `tz`、`tightenSupervision` |
| `services/runtime/src/frameHandler.ts` | `say` 帧的 `tz` 透传 |
| `services/runtime/src/daemon.ts` | 接线：store、scheduler、session opts |
| `mobile/src/agent/routinesStore.ts`（新） | 手机侧按 (ws, agent) 拉列表的小 store + hook |
| `mobile/src/agent/RoutinesScreen.tsx`（新） | 列表页（重复 / 一次性 / 已完成 + 开关 + 「+」） |
| `mobile/src/agent/RoutineEditDialog.tsx`（新） | 居中编辑弹窗（含时区选择） |
| `mobile/src/agent/TimeWheel.tsx`（新） | 纯 JS 时 / 分两列滚轮 |
| `mobile/src/agent/AgentRows.tsx` / `mobile/src/nav/types.ts` / `mobile/src/nav/RootNavigator.tsx` | 入口行 + 路由 |
| `mobile/src/cloud/cloudClient.ts` / `mobile/src/me/profileStore.ts` / `mobile/src/tabs/ChatsScreen.tsx` | 设备时区：`say` 帧带、前台时写 `profiles.timezone` |
| `docs/adr/0353-*.md` / `docs/where-to-find-things.md` / `CONTEXT.md` / spec | 文档 |

---

### Task 1: `src/shared/routines.ts` —— 形状、校验、下一跳（纯函数）

**Files:**
- Create: `src/shared/routines.ts`
- Test: `tests/shared/routines.test.ts`

**Interfaces:**
- Produces（后续所有任务都靠这些名字）：

```ts
export type RoutineSchedule =
  | { kind: "once"; at: string }                       // "YYYY-MM-DDTHH:mm"（tz 里的墙上时间）
  | { kind: "daily"; time: string }                    // "HH:mm"
  | { kind: "weekly"; days: number[]; time: string };  // days ⊂ 1..7（1 = 周一），非空、去重、升序
export type RoutineStatus = "done" | "skipped_quota" | "missed" | "failed";
export interface RoutineRow {
  id: string; workspaceId: string; agentId: string; ownerUid: string;
  title: string; instruction: string; schedule: RoutineSchedule; tz: string; enabled: boolean;
  nextRunAt: number | null; lastRunAt: number | null; lastStatus: RoutineStatus | null;
  createdBy: "user" | "agent"; createdAt: number; updatedAt: number;
}
export const ROUTINE_TITLE_MAX = 40, ROUTINE_INSTRUCTION_MAX = 2000, ROUTINES_ENABLED_MAX = 20;
export const ROUTINE_ONCE_GRACE_MS = 2 * 3_600_000, ROUTINE_RECURRING_GRACE_MS = 10 * 60_000, ROUTINE_MIN_GAP_MS = 60_000;
export const ROUTINE_MAX_ROUNDS = 40, ROUTINE_KEEP_DONE_MS = 7 * 86_400_000;
export const SCHEDULE_TASK_TOOL_NAME = "schedule_task", LIST_SCHEDULES_TOOL_NAME = "list_schedules", UPDATE_SCHEDULE_TOOL_NAME = "update_schedule";
export function isIanaTimeZone(v: unknown): v is string;
export function parseRoutineSchedule(v: unknown): RoutineSchedule;      // 不合法抛 Error（人话）
export function routineErrors(f: { title: string; instruction: string; schedule: unknown; tz: string }): string | null;
export function zonedParts(ts: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; weekday: number };
export function wallClockToUtc(w: { y: number; m: number; d: number; hh: number; mm: number }, tz: string): number;
export function nextRunAt(schedule: RoutineSchedule, tz: string, afterMs: number): number | null;
export function formatInTz(ts: number, tz: string): string;             // "2026-10-05 09:00（Asia/Shanghai，周一）"
export function scheduleText(schedule: RoutineSchedule, tz: string): string; // "每天 09:00 · Asia/Shanghai" / "每周一、三 09:00 · …" / "10-05 15:00 · …"
export function routineOpeningText(o: { title: string; instruction: string; firedAt: number; tz: string }): string;
export function routineNoteText(o: { title: string; reason: "missed" | "skipped_quota"; plannedAt: number; tz: string }): string;
```

- [ ] **Step 1: 写失败的测试**

`tests/shared/routines.test.ts`：

```ts
// 定时任务的纯函数（#1283，spec §2）：runtime 算下一跳、手机画「下次」、工具回显都用这一份。
import { describe, expect, it } from "vitest";
import {
  formatInTz, isIanaTimeZone, nextRunAt, parseRoutineSchedule, routineErrors, routineOpeningText, scheduleText,
  wallClockToUtc, zonedParts, ROUTINES_ENABLED_MAX, ROUTINE_TITLE_MAX,
} from "../../src/shared/routines.js";

const SH = "Asia/Shanghai";
const utc = (y: number, m: number, d: number, hh: number, mm: number) => Date.UTC(y, m - 1, d, hh, mm);

describe("zonedParts / wallClockToUtc", () => {
  it("上海 = UTC+8，周几按 ISO（1 = 周一）", () => {
    // 2026-10-05 是周一；01:00Z = 09:00 上海
    expect(zonedParts(utc(2026, 10, 5, 1, 0), SH)).toEqual({ y: 2026, m: 10, d: 5, hh: 9, mm: 0, weekday: 1 });
    expect(wallClockToUtc({ y: 2026, m: 10, d: 5, hh: 9, mm: 0 }, SH)).toBe(utc(2026, 10, 5, 1, 0));
    // 周日 = 7
    expect(zonedParts(utc(2026, 10, 4, 1, 0), SH).weekday).toBe(7);
  });
  it("夏令时：跳过的那一小时按跳过的长度后移；重复的那一小时取第一次", () => {
    // 悉尼 2026-10-04 02:00 → 03:00（春季跳一小时）：02:30 不存在 → 03:30（= 16:30Z 前一天）
    const gap = wallClockToUtc({ y: 2026, m: 10, d: 4, hh: 2, mm: 30 }, "Australia/Sydney");
    expect(zonedParts(gap, "Australia/Sydney")).toMatchObject({ d: 4, hh: 3, mm: 30 });
    // 悉尼 2026-04-05 03:00 → 02:00（秋季重复 02:00–03:00）：02:30 出现两次，取先到的那一个（+11 那次 = 15:30Z 前一天）
    const dup = wallClockToUtc({ y: 2026, m: 4, d: 5, hh: 2, mm: 30 }, "Australia/Sydney");
    expect(dup).toBe(utc(2026, 4, 4, 15, 30));
    expect(zonedParts(dup, "Australia/Sydney")).toMatchObject({ d: 5, hh: 2, mm: 30 });
  });
});

describe("nextRunAt", () => {
  it("once：还没到就是那一刻；到了 / 过了回 null", () => {
    const s = { kind: "once" as const, at: "2026-10-05T09:00" };
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 0, 59))).toBe(utc(2026, 10, 5, 1, 0));
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 1, 0))).toBeNull();
    expect(nextRunAt(s, SH, utc(2026, 10, 6, 0, 0))).toBeNull();
  });
  it("daily：今天还没到取今天，到了取明天，跨月跨年都对", () => {
    const s = { kind: "daily" as const, time: "09:00" };
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 0, 0))).toBe(utc(2026, 10, 5, 1, 0));
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 1, 0))).toBe(utc(2026, 10, 6, 1, 0));
    expect(nextRunAt(s, SH, utc(2026, 12, 31, 1, 0))).toBe(utc(2027, 1, 1, 1, 0));
  });
  it("weekly：从 after 起找最近的命中日；当天命中但时刻过了就跳到下一个命中日", () => {
    const s = { kind: "weekly" as const, days: [1, 3], time: "09:00" }; // 周一、周三
    // 2026-10-05 周一 08:00 上海 → 当天 09:00
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 0, 0))).toBe(utc(2026, 10, 5, 1, 0));
    // 周一 09:00 整 → 周三
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 1, 0))).toBe(utc(2026, 10, 7, 1, 0));
    // 周四 → 下周一
    expect(nextRunAt(s, SH, utc(2026, 10, 8, 1, 0))).toBe(utc(2026, 10, 12, 1, 0));
  });
  it("daily 跨夏令时切换：墙上的九点还是九点", () => {
    // 悉尼 2026-10-04 02:00 春季跳：10-03 09:00 本地 = 10-02 23:00Z（+10）；10-04 09:00 本地 = 10-03 22:00Z（+11）
    const s = { kind: "daily" as const, time: "09:00" };
    expect(nextRunAt(s, "Australia/Sydney", utc(2026, 10, 2, 23, 0))).toBe(utc(2026, 10, 3, 22, 0));
  });
});

describe("parseRoutineSchedule / routineErrors / isIanaTimeZone", () => {
  it("三种形状过；days 去重升序；坏的抛人话", () => {
    expect(parseRoutineSchedule({ kind: "weekly", days: [3, 1, 3], time: "09:00" })).toEqual({ kind: "weekly", days: [1, 3], time: "09:00" });
    expect(() => parseRoutineSchedule({ kind: "weekly", days: [], time: "09:00" })).toThrow("至少选一天");
    expect(() => parseRoutineSchedule({ kind: "daily", time: "9:00" })).toThrow("HH:mm");
    expect(() => parseRoutineSchedule({ kind: "once", at: "2026-10-05 09:00" })).toThrow("YYYY-MM-DDTHH:mm");
    expect(() => parseRoutineSchedule({ kind: "hourly" })).toThrow("once / daily / weekly");
  });
  it("时区只认 Intl 认得的 IANA 名", () => {
    expect(isIanaTimeZone("Asia/Shanghai")).toBe(true);
    expect(isIanaTimeZone("Beijing")).toBe(false);
    expect(isIanaTimeZone(8)).toBe(false);
  });
  it("表单错误：标题空 / 超长、原话超长、时区坏，第一条毛病先说；都好回 null", () => {
    const ok = { title: "早报", instruction: "看一眼报表", schedule: { kind: "daily", time: "09:00" }, tz: SH };
    expect(routineErrors(ok)).toBeNull();
    expect(routineErrors({ ...ok, title: " " })).toContain("标题");
    expect(routineErrors({ ...ok, title: "x".repeat(ROUTINE_TITLE_MAX + 1) })).toContain(`${ROUTINE_TITLE_MAX}`);
    expect(routineErrors({ ...ok, tz: "Mars/Olympus" })).toContain("时区");
    expect(ROUTINES_ENABLED_MAX).toBe(20);
  });
});

describe("文案", () => {
  it("formatInTz / scheduleText / routineOpeningText 带时区与周几，开场白带任务原话与两把刀的名字", () => {
    expect(formatInTz(utc(2026, 10, 5, 1, 0), SH)).toBe("2026-10-05 09:00（Asia/Shanghai，周一）");
    expect(scheduleText({ kind: "daily", time: "09:00" }, SH)).toBe("每天 09:00 · Asia/Shanghai");
    expect(scheduleText({ kind: "weekly", days: [1, 3, 5], time: "18:30" }, SH)).toBe("每周一、三、五 18:30 · Asia/Shanghai");
    expect(scheduleText({ kind: "once", at: "2026-10-05T15:00" }, SH)).toBe("2026-10-05 15:00 · Asia/Shanghai");
    const text = routineOpeningText({ title: "早报", instruction: "看一眼报表", firedAt: utc(2026, 10, 5, 1, 0), tz: SH });
    expect(text).toContain("【定时任务到点】现在是 2026-10-05 09:00（Asia/Shanghai，周一）");
    expect(text).toContain("任务：看一眼报表");
    expect(text).toContain("call_user");
    expect(text).toContain("call_friend");
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/shared/routines.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/shared/routines.ts`**

```ts
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
    if (typeof o.at !== "string" || !AT_RE.test(o.at)) throw new Error("once 的 at 要写成 YYYY-MM-DDTHH:mm（墙上时间，不带时区）");
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
    做法：拿前后 12 小时的两个偏移各算一个候选，先用「切换前」那个偏移——正常日子两个候选相同；
    重复时「切换前」的偏移给的是先到的那次；跳过时两个都对不上，「切换前」的偏移正好把它后移一个跳跃 */
export function wallClockToUtc(w: { y: number; m: number; d: number; hh: number; mm: number }, tz: string): number {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
  const before = offsetMinutesAt(guess - 12 * 3_600_000, tz);
  const after = offsetMinutesAt(guess + 12 * 3_600_000, tz);
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
    `任务「${o.title}」：${o.instruction}\n` +
    `按任务去做。要叫我接电话就用 call_user；要打给好友用 call_friend。做完在这里说一句结果。`
  );
}

/** 没跑成的那条灰条文案（spec §4.3） */
export function routineNoteText(o: { title: string; reason: "missed" | "skipped_quota"; plannedAt: number; tz: string }): string {
  const when = formatInTz(o.plannedAt, o.tz);
  return o.reason === "missed"
    ? `定时任务「${o.title}」错过了（原定 ${when}，服务那会儿没在线）`
    : `定时任务「${o.title}」这次没跑（原定 ${when}，本周额度快用完了）`;
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/shared/routines.test.ts`
Expected: PASS（夏令时那两条若在本机 ICU 下失败，先核 `Australia/Sydney` 2026 年的切换日：10-04 与 04-05；别改成跳过）

- [ ] **Step 5: 提交**

```bash
git add src/shared/routines.ts tests/shared/routines.test.ts
git commit -m "feat(shared): 定时任务的形状、校验与下一跳——墙上时间 + IANA 时区，一份纯函数（#1283）

存墙上时间不存 UTC cron：人改时区、夏令时切换，墙上的九点还是九点。夏令时边角按 ICU 的惯例
（跳过的后移、重复的取先到的），nextRunAt 严格大于 after，调度器与手机都靠它。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: migration 0057 —— `agent_routines` + `profiles.timezone`

**Files:**
- Create: `supabase/migrations/0057_agent_routines.sql`
- Modify: `CONTEXT.md`（「产品 / 技术术语」一节加「定时任务（routine）」）

**Interfaces:**
- Produces：表 `public.agent_routines`（列见下）、`public.profiles.timezone text null`。后续 `routineStore.ts` / `supabaseRoutinesApi.ts` 按这些列名读写。

- [ ] **Step 1: 写 migration**

```sql
-- 0057_agent_routines.sql —— 智能体的定时任务（#1283，ADR-0356）。幂等，重跑不炸。
-- 同 0049 的约定：Supabase SQL editor / Management API 手动执行一次（那个端点只回最后一条语句的结果，逐条发）。
-- **部署顺序：先跑这份、再部署 runtime、再发手机热更新**——反过来 runtime 的调度器每 30 秒读一次不存在的表、
-- 只记一行日志；手机的「定时任务」那一行读不到表就整行不画。**还没有在生产执行**。
--
-- 一行 = 一只智能体的一条任务。调度器只看 next_run_at（部分索引），认领是
--   update … set next_run_at = <下一跳> where id = $1 and next_run_at = $2 returning *
-- 两个 runtime 实例同时 tick 只有一个 returning 有行。墙上时间 + tz 存在 schedule / tz 里，
-- next_run_at 是按它们算出来的绝对时刻缓存（runtime 认领时按 schedule 重算，手机算错最多早 / 晚一次）。
-- 没有 session_id：私聊按 0037 的唯一索引 (workspace_id, agent_ids[1]) where chat_kind='dm' 现查。

create table if not exists public.agent_routines (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  agent_id      text not null,
  owner_uid     uuid not null references auth.users(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 40),
  instruction   text not null check (char_length(instruction) between 1 and 2000),
  schedule      jsonb not null,
  tz            text not null,
  enabled       boolean not null default true,
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_status   text check (last_status in ('done', 'skipped_quota', 'missed', 'failed')),
  created_by    text not null check (created_by in ('user', 'agent')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (workspace_id, agent_id) references public.workspace_agents(workspace_id, agent_id) on delete cascade
);

create index if not exists agent_routines_due on public.agent_routines (next_run_at) where next_run_at is not null;
create index if not exists agent_routines_agent on public.agent_routines (workspace_id, agent_id);

alter table public.agent_routines enable row level security;

drop policy if exists ar_select_owner on public.agent_routines;
create policy ar_select_owner on public.agent_routines for select to authenticated using (owner_uid = auth.uid());
drop policy if exists ar_insert_owner on public.agent_routines;
create policy ar_insert_owner on public.agent_routines for insert to authenticated with check (owner_uid = auth.uid());
drop policy if exists ar_update_owner on public.agent_routines;
create policy ar_update_owner on public.agent_routines for update to authenticated using (owner_uid = auth.uid()) with check (owner_uid = auth.uid());
drop policy if exists ar_delete_owner on public.agent_routines;
create policy ar_delete_owner on public.agent_routines for delete to authenticated using (owner_uid = auth.uid());

-- 不进 supabase_realtime：只有本人读，而 Realtime 对 DELETE 不查 RLS（同 chat_mutes 的理由）。

-- 主人的设备时区（spec §6.3）：手机前台时写，调度器建任务时 tz 省略就用它。IANA 名字，由客户端校验。
alter table public.profiles add column if not exists timezone text;
```

- [ ] **Step 2: 用本机 postgres 语法检查（没有就跳过，CI 不跑 SQL）**

Run: `which psql >/dev/null && psql --version || echo "no psql, skip"`。有 psql 也不要连生产库——这一步只是读一遍文件确认没有拼写错误。

- [ ] **Step 3: `CONTEXT.md` 加术语**

在「## 产品 / 技术术语（Mr Otto）」那一节末尾（`## Key invariants` 之前）加：

```markdown
- **定时任务（routine）**：一只账号级智能体记住的一条「到点自己起一轮」的任务（#1283，ADR-0356）。两类：**永久**（`daily` / `weekly`，墙上时间固定）与**日抛**（`once`，跑完即停用、列表里留 7 天）。存 `agent_routines`，调度器在云 runtime 里（30 秒 tick + 原子认领），到点在它的私聊里落一条 `greeting:"routine"` 的开场白起 turn——与回电 / 外联汇报同一条路。routine 轮视同主人亲口（免审、`call_friend` 亮），刹车是额度门 + 圈数上限。模型侧三把刀 `schedule_task` / `list_schedules` / `update_schedule`。
```

- [ ] **Step 4: 提交**

```bash
git add supabase/migrations/0057_agent_routines.sql CONTEXT.md
git commit -m "feat(db): agent_routines 表 + profiles.timezone（0057，#1283）

调度器只看 next_run_at 那一列、认领靠 where next_run_at = 读到的值；不存 session_id，
私聊按 0037 的唯一索引现查。还没在生产执行，部署顺序写在文件头。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 事件 schema —— `greeting:"routine"`、`routine` / `tz` 两格、新事件 `routine_note`

**Files:**
- Modify: `src/session/events.ts`（`UserMessageEvent` 的 `greeting` 联合 ~`:108`；`CallRingEvent` 之后加 `RoutineNoteEvent`；`SessionEvent` 联合 ~`:1258`；`KNOWN_EVENT_TYPES_MAP` ~`:1325`）
- Modify: `src/shared/sessionPackage.ts:160` 附近（`PRIVACY_VERDICTS`）、`src/shared/taskSync.ts:69` 附近（`PEN_VERDICTS`）、`src/shared/cloudTimeline.ts:115`（`hiddenFromCloudTimeline`）
- Test: `tests/session/routineEvents.test.ts`

**Interfaces:**
- Produces：

```ts
// UserMessageEvent 新增
greeting?: "voice_call" | "new_agent" | "callback" | "outreach" | "outreach_report" | "admin_intro" | "routine";
routine?: { id: string; title: string };   // 只在 greeting === "routine" 时在场
tz?: string;                                // 发话人设备的 IANA 时区（协议 24 的 say 帧可选格），缺席 = 旧日志 / 桌面
// 新事件
export interface RoutineNoteEvent extends SessionEventBase {
  type: "routine_note"; routineId: string; title: string; reason: "missed" | "skipped_quota"; plannedAt: number; tz: string; ignorable: true;
}
```

- [ ] **Step 1: 写失败的测试**

`tests/session/routineEvents.test.ts`（照 `tests/session/callRingEvent.test.ts` 的形状）：

```ts
// routine_note 与 greeting:"routine" 的登记（#1283）：新事件类型在每一张穷举表里都要表态。
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type RoutineNoteEvent, type UserMessageEvent } from "../../src/session/events.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { PEN_VERDICTS } from "../../src/shared/taskSync.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

const note: RoutineNoteEvent = {
  sessionId: "s", seq: 2, ts: 1, type: "routine_note", routineId: "r1", title: "早报", reason: "missed", plannedAt: 0, tz: "Asia/Shanghai", ignorable: true,
};
const opening: UserMessageEvent = {
  sessionId: "s", seq: 1, ts: 1, type: "user_message", content: "【定时任务到点】…", fromUid: "owner", mentions: ["ops"],
  greeting: "routine", routine: { id: "r1", title: "早报" }, tz: "Asia/Shanghai",
};

describe("routine 事件的登记（#1283）", () => {
  it("routine_note 是已知事件类型、分享包里剥掉、要握笔才落得了、桌面不画", () => {
    expect(KNOWN_EVENT_TYPES.has("routine_note")).toBe(true);
    expect(PRIVACY_VERDICTS.routine_note).toBe("strip");
    expect(PEN_VERDICTS.routine_note).toBe("executor");
    expect(hiddenFromCloudTimeline(note)).toBe(true);
  });
  it("routine 开场白：桌面照 greeting 一族藏；模型照普通 user 消息读（正文原样进上下文）", () => {
    expect(hiddenFromCloudTimeline(opening)).toBe(true);
    const created = { sessionId: "s", seq: 0, ts: 0, type: "session_created", workspace: "/work", cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true } } as const;
    const msgs = deriveMessages([created, opening, note]);
    expect(msgs.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["【定时任务到点】…"]);
    expect(JSON.stringify(msgs)).not.toContain("错过");
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/session/routineEvents.test.ts`
Expected: FAIL（tsc 层：`"routine"` 不在联合里 / `routine_note` 不是已知类型）

- [ ] **Step 3: 改 `src/session/events.ts`**

在 `greeting` 那条注释末尾（`"admin_intro"` 那段之后）追加一段，并改联合：

```ts
      `"routine"`（#1283，ADR-0356）：定时任务到点，runtime 替主人落的开场白（`mentions` 是那只，`fromUid` 是主人）。
      与别的 greeting 两处不同：① 它**算主人亲口**（openingTraits 的 ownerSpoke 放行它——任务原话是主人写的）；
      ② 手机时间线**画它**（一条居中灰条「⏰ 定时任务「x」」）：别的 greeting 都有前一条可见事件解释「为什么它开口了」，
      这条没有。桌面照旧藏。同样不进协议位 */
  greeting?: "voice_call" | "new_agent" | "callback" | "outreach" | "outreach_report" | "admin_intro" | "routine";
  /** 哪条定时任务（#1283）：只在 greeting === "routine" 时在场。时间线的灰条要标题，日志里得有——任务可能已被删 */
  routine?: { id: string; title: string };
  /** 发话人设备的 IANA 时区（#1283，spec §6）：手机的 say 帧带、runtime 校验是合法时区后原样落。缺席 = 旧日志 / 桌面。
      **只影响投影里「今天是」那一行**（deriveMessages 按最近一条带 tz 的人话算日期）；起 turn、排队、护栏一个判断都不读它 */
  tz?: string;
```

在 `CallRingEvent` 定义之后加：

```ts
/** 定时任务没跑成的那一笔（#1283，spec §4.3）：错过了 / 额度不够跳过。模型不可见（`ignorable`），只画一条灰条。
    **不带 agentId**：带的话 openTurns / 活动折叠会把它认成那只的一轮（同 call_ring 的纪律） */
export interface RoutineNoteEvent extends SessionEventBase {
  type: "routine_note";
  routineId: string;
  title: string;
  reason: "missed" | "skipped_quota";
  /** 原定的那一刻（UTC 毫秒）与它的时区——文案按时区格式化 */
  plannedAt: number;
  tz: string;
  ignorable: true;
}
```

`SessionEvent` 联合里 `| CallRingEvent` 之后加 `| RoutineNoteEvent`；`KNOWN_EVENT_TYPES_MAP` 里 `call_ring: true,` 之后加 `routine_note: true,`。

- [ ] **Step 4: 三张穷举表表态**

`src/shared/sessionPackage.ts` 的 `PRIVACY_VERDICTS` 里 `call_ring: "strip",` 之后加：

```ts
  routine_note: "strip", // 定时任务的标题是主人私事，不是这段对话（#1283）
```

`src/shared/taskSync.ts` 的 `PEN_VERDICTS` 里 `call_ring: "executor",` 之后加 `routine_note: "executor",`。

`src/shared/cloudTimeline.ts` 的 `hiddenFromCloudTimeline` 返回那串里 `e.type === "call_ring" ||` 之后加：

```ts
    e.type === "routine_note" || // 定时任务没跑成的灰条（#1283）：手机画，桌面等微信式布局
```

（`user_message` 那一行 `e.greeting !== undefined` 已经把 routine 开场白藏了，不动。）

- [ ] **Step 5: 跑测试 + tsc**

Run: `npx vitest run tests/session/routineEvents.test.ts tests/session/callRingEvent.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 若报别的穷举表（`Record<SessionEvent["type"], …>`）缺 `routine_note`，照那张表的口径补一行（投影 / 重放都不该为它多做事）。

- [ ] **Step 6: 提交**

```bash
git add src/session/events.ts src/shared/sessionPackage.ts src/shared/taskSync.ts src/shared/cloudTimeline.ts tests/session/routineEvents.test.ts
git commit -m "feat(events): greeting 加 routine、user_message 加 routine / tz 两格、新事件 routine_note（#1283）

routine 开场白与回电 / 外联汇报同一族记号，不进协议位；routine_note 是 ignorable 的注记，
不带 agentId 免得被当成那只的一轮。tz 落在日志里，投影的「今天是」才能从日志推导。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 手机时间线 —— routine 开场白与 `routine_note` 画成居中灰条

**Files:**
- Modify: `src/shared/mobileChat.ts`（`chatRows` 主循环里 `if (e.type === "call_ring")` 那一块之前，~`:222`）
- Test: `tests/shared/mobileChat.test.ts`（追加一个 describe）

**Interfaces:**
- Consumes：Task 3 的 `greeting:"routine"` / `routine` / `RoutineNoteEvent`；Task 1 的 `routineNoteText`。
- Produces：两种情况都是既有的 `{ kind: "note", tone: "muted" }` 行，key 分别为 `routine-${seq}` 与 `rnote-${seq}`。手机 `Bubbles.tsx` 的 `case "note"` 已经画 `NotePill`，不改手机渲染层。

- [ ] **Step 1: 写失败的测试**

在 `tests/shared/mobileChat.test.ts` 末尾追加：

```ts
describe("定时任务的灰条（#1283）", () => {
  it("routine 开场白不藏，画「⏰ 定时任务「x」」；routine_note 画原因；两条都是 muted 的 note 行", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "session_created" }),
        e({ type: "user_message", content: "【定时任务到点】…", fromUid: "me", mentions: ["a_000000000001"], greeting: "routine", routine: { id: "r1", title: "早报" } }),
        e({ type: "assistant_message", content: "报表看完了", model: "m", agentId: "a_000000000001" }),
        e({ type: "routine_note", routineId: "r1", title: "早报", reason: "skipped_quota", plannedAt: DAY, tz: "Asia/Shanghai", ignorable: true }),
      ],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows.map((r) => r.kind)).toEqual(["time", "note", "agent", "note"]);
    expect(rows[1]).toMatchObject({ kind: "note", key: "routine-1", text: "⏰ 定时任务「早报」", tone: "muted" });
    expect(rows[3]).toMatchObject({ kind: "note", key: "rnote-3", tone: "muted" });
    expect((rows[3] as { text: string }).text).toContain("早报");
    expect((rows[3] as { text: string }).text).toContain("额度");
  });
  it("别的 greeting 照旧藏（new_agent）", () => {
    seq = 0;
    const rows = chatRows({
      events: [e({ type: "session_created" }), e({ type: "user_message", content: "x", fromUid: "me", mentions: ["a_000000000001"], greeting: "new_agent" })],
      ws: WS, selfUid: "me", now: DAY,
    });
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/shared/mobileChat.test.ts -t "定时任务"`
Expected: FAIL（routine 开场白被藏、routine_note 被藏）

- [ ] **Step 3: 实现**

`src/shared/mobileChat.ts` 顶部 import 加 `import { routineNoteText } from "./routines.js";`。在 `chatRows` 主循环里、`if (e.type === "call_ring") {` 之前加：

```ts
    // 定时任务（#1283）：开场白是 greeting 一族里唯一要画的——别的 greeting 都有前一条可见事件解释「为什么它开口了」
    // （名单变了 / 新建了它 / 电话接通了），这条没有，藏了就是回话凭空冒出来。要在 rowOf 之前认出来：
    // rowOf 先问 hiddenFromCloudTimeline，而桌面把 greeting 一族整条藏了
    if (e.type === "user_message" && e.greeting === "routine") {
      items.push({ kind: "note", key: `routine-${e.seq}`, ts: e.ts, text: `⏰ 定时任务「${e.routine?.title ?? "定时任务"}」`, tone: "muted", detail: null });
      continue;
    }
    if (e.type === "routine_note") {
      items.push({ kind: "note", key: `rnote-${e.seq}`, ts: e.ts, text: routineNoteText(e), tone: "muted", detail: null });
      continue;
    }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/shared/mobileChat.test.ts`
Expected: PASS（含既有用例——「藏起来的一律不画」那条里 greeting 用的不是 routine，不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/shared/mobileChat.ts tests/shared/mobileChat.test.ts
git commit -m "feat(mobileChat): 定时任务的开场白与没跑成的注记画成居中灰条（#1283）

greeting 一族里只画这一种：别的都有前一条可见事件解释它为什么开口，这条没有，
藏了回话就凭空冒出来。桌面照旧藏（hiddenFromCloudTimeline 不动）。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 模型投影的「今天是」按最近一条 `user_message.tz` 算

**Files:**
- Modify: `src/session/deriveMessages.ts`（`dayOf` ~`:44`、`dayOfLastEvent` ~`:52`、`systemPromptText` ~`:63`、调用点 ~`:702` / ~`:909`）
- Modify: `src/shared/contextEstimate.ts:319-322`
- Test: `tests/session/deriveMessages.today.test.ts`

**Interfaces:**
- Produces：`export function userTzOf(events: readonly { type: string; tz?: string }[]): string | undefined`（最近一条带 `tz` 的 `user_message`）；`systemPromptText(workspace, today?, workspaceKind?, isolated?, cloud?, todayTz?: string)`——第 6 个参数在场时括号里写它，缺席逐字节 `（本机时区）`。
- 不变量：没有任何 `tz` 的日志（本机 / 旧日志）投影逐字节不变。

- [ ] **Step 1: 写失败的测试**

```ts
// 「今天是」按人的时区算（#1283，spec §6.2）：云 runtime 在 VPS 上是 UTC，上海的早上八点在那儿还是昨天。
import { describe, expect, it } from "vitest";
import { dayOfLastEvent, deriveMessages, systemPromptText, userTzOf } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 2026-10-05 00:30 上海 = 2026-10-04 16:30Z
const TS = Date.UTC(2026, 9, 4, 16, 30);
const created: SessionEvent = { seq: 1, sessionId: "s", ts: TS, type: "session_created", workspace: "/w", cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true } };

describe("今天是：按最近一条 user_message.tz", () => {
  it("没有 tz：逐字节 = 老投影（进程时区），括号写「本机时区」", () => {
    const plain: SessionEvent = { seq: 2, sessionId: "s", ts: TS, type: "user_message", content: "hi", fromUid: "u", mentions: [] };
    expect(userTzOf([created, plain])).toBeUndefined();
    const content = (deriveMessages([created, plain])[0] as { content: string }).content;
    expect(content).toBe(systemPromptText("/w", dayOfLastEvent([created, plain]), undefined, undefined, created.cloud));
    expect(content).toContain("（本机时区）");
  });
  it("有 tz：日期按那个时区，括号写时区名；最近一条胜出", () => {
    const sh: SessionEvent = { seq: 2, sessionId: "s", ts: TS, type: "user_message", content: "hi", fromUid: "u", mentions: [], tz: "Asia/Shanghai" };
    expect(userTzOf([created, sh])).toBe("Asia/Shanghai");
    expect(dayOfLastEvent([created, sh])).toBe("2026-10-05");
    const content = (deriveMessages([created, sh])[0] as { content: string }).content;
    expect(content).toContain("今天是 2026-10-05（Asia/Shanghai）");
    const la: SessionEvent = { seq: 3, sessionId: "s", ts: TS, type: "user_message", content: "hi", fromUid: "u", mentions: [], tz: "America/Los_Angeles" };
    expect(dayOfLastEvent([created, sh, la])).toBe("2026-10-04");
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/session/deriveMessages.today.test.ts`
Expected: FAIL（`userTzOf` 不存在）

- [ ] **Step 3: 实现**

`src/session/deriveMessages.ts`：

```ts
/** 最近一条带 tz 的人话的时区（#1283）：云会话里手机的 say 帧带设备时区落到 user_message.tz。
    没有 = 本机会话 / 旧日志 / 桌面发的 */
export function userTzOf(events: readonly { type: string; tz?: string }[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user_message" && e.tz !== undefined) return e.tz;
  }
  return undefined;
}

function dayOf(ts: number, tz?: string): string {
  if (tz !== undefined) {
    // en-CA 的 dateStyle 短格就是 YYYY-MM-DD；Intl 认不得的时区名在落盘前已被 runtime 挡掉，这里兜一层回进程时区
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
    } catch { /* 回落到下面 */ }
  }
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayOfLastEvent(events: { ts: number; type?: string; tz?: string }[]): string | undefined {
  const last = events[events.length - 1];
  return last ? dayOf(last.ts, userTzOf(events as { type: string; tz?: string }[])) : undefined;
}
```

`systemPromptText` 加第 6 个参数 `todayTz?: string`，两处 `今天是 ${today}（本机时区）` 改成 `今天是 ${today}（${todayTz ?? "本机时区"}）`。`deriveMessages` 里 `const today = dayOfLastEvent(events);` 之后加 `const todayTz = userTzOf(events);`，~`:909` 的调用改为 `systemPromptText(event.workspace, today, event.workspaceKind, event.isolated, event.cloud, todayTz)`。`src/shared/contextEstimate.ts` ~`:322` 同样补 `userTzOf(events)`（import 它），估算与真实请求一个口径。

注意 `dayOfLastEvent` 的参数类型放宽后，既有调用传的 `{ ts }[]` 仍能过（`type` / `tz` 可选）。

- [ ] **Step 4: 跑全部投影测试确认绿**

Run: `npx vitest run tests/session tests/shared/contextEstimate.test.ts 2>/dev/null || npx vitest run tests/session`
Expected: PASS（旧投影逐字节不变那几条尤其要绿）

- [ ] **Step 5: 提交**

```bash
git add src/session/deriveMessages.ts src/shared/contextEstimate.ts tests/session/deriveMessages.today.test.ts
git commit -m "feat(deriveMessages): 「今天是」按最近一条 user_message.tz 算（#1283）

云 runtime 在 VPS 上是 UTC，上海的早上在那儿还是昨天；人说「今天下午三点」模型会算错一天。
时区从日志里取，不读库：投影仍是纯函数。没有 tz 的日志逐字节不变。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `say` 帧带设备时区，一路落到 `user_message.tz`

**Files:**
- Modify: `src/shared/remote/cloudSession.ts:352`（`CsUp` 的 say 形状）、`:764-780`（`decodeCsUp` 的 say 分支）
- Modify: `src/shared/remote/cloudSessionClient.ts:128`（`CloudSessionClientDeps`）、`:1063-1083`（`say()`）
- Modify: `services/runtime/src/frameHandler.ts:810-812`（透传）
- Modify: `services/runtime/src/sessionService.ts:562-572`（`CloudSession.say` 签名）、`:2740`（实现签名）、`:3005-3022`（落盘）
- Modify: `mobile/src/cloud/cloudClient.ts:43`（注入 `deviceTz`）
- Test: `tests/shared/cloudSessionTz.test.ts`、`tests/runtime/sessionService.tz.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `isIanaTimeZone`。
- Produces：`CsUp` say 帧多一格 `tz?: string`；`CloudSessionClientDeps.deviceTz?: () => string | undefined`；`CloudSession.say(..., media?, tz?)`（**第 10 个位置参数，放最后**——同 `voice` 那条纪律：既有调用方不受影响）。

- [ ] **Step 1: 写失败的测试（帧编解码）**

`tests/shared/cloudSessionTz.test.ts`：

```ts
// say 帧的可选 tz（#1283，spec §6.1）：合法 IANA 名才进帧 / 才被读；脏值当缺席不拒帧（同 voice 那一格的口径）。
import { describe, expect, it } from "vitest";
import { CS_PROTOCOL_VERSION, decodeCsUp, encodeCs, type CsUp } from "../../src/shared/remote/cloudSession.js";

const say = (extra: Record<string, unknown>): CsUp | null =>
  decodeCsUp(encodeCs({ t: "say", text: "hi", mention: true, ...extra } as unknown as CsUp));

describe("say 帧的 tz", () => {
  it("合法时区原样进帧", () => {
    expect(say({ tz: "Asia/Shanghai" })).toMatchObject({ t: "say", tz: "Asia/Shanghai" });
  });
  it("脏值 / 不是字符串：当缺席，整帧照收", () => {
    expect(say({ tz: "Beijing" })).toEqual({ t: "say", text: "hi", mention: true });
    expect(say({ tz: 8 })).toEqual({ t: "say", text: "hi", mention: true });
  });
  it("协议号不动（可选字段）", () => {
    expect(CS_PROTOCOL_VERSION).toBe(24);
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/shared/cloudSessionTz.test.ts`
Expected: FAIL（第一条：解出来没有 tz）

- [ ] **Step 3: 帧形状与解码**

`src/shared/remote/cloudSession.ts:352` 的 say 形状末尾加 `tz?: string`：

```ts
  | { t: "say"; text: string; mention: boolean; mentions?: string[]; memberMentions?: string[]; voice?: true; media?: ChatMediaRef[]; tz?: string }
```

`decodeCsUp` 的 say 分支里 `if (obj.voice === true) say.voice = true;` 之后加（文件顶部 `import { isIanaTimeZone } from "../routines.js";`）：

```ts
        // tz 只认 Intl 认得的 IANA 名（#1283）：它只影响投影里「今天是」那一行，脏值退化成「不带」= 改动前的行为，
        // 为它拒掉一句真话更糟（同 voice 那一格的口径）
        if (isIanaTimeZone(obj.tz)) say.tz = obj.tz;
```

`src/shared/remote/cloudSessionClient.ts` 的 `CloudSessionClientDeps` 加：

```ts
  /** 这台设备的 IANA 时区（#1283）：每次 say 现取、带在帧上，runtime 落到 user_message.tz。
      不给 = 不带（桌面：它的「今天是」本来就按本机算） */
  deviceTz?: () => string | undefined;
```

`say()` 里 `if (media !== undefined && media.length > 0) frame.media = media;` 之后加：

```ts
    const tz = deps.deviceTz?.();
    if (tz !== undefined && tz !== "") frame.tz = tz;
```

- [ ] **Step 4: 跑帧测试确认绿**

Run: `npx vitest run tests/shared/cloudSessionTz.test.ts tests/shared/chatMediaRefs.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败的测试（runtime 落盘）**

`tests/runtime/sessionService.tz.test.ts`（装配照 `tests/runtime/sessionService.pair.test.ts` 的 `open()`，但 `chat.kind` 用 `dm`、`pairMessages: null`）：

```ts
// say() 的第 10 个参数 tz 原样落到开场白上（#1283）；不给就没有这一格。
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
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { UserMessageEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const OWNER = "owner";
const SID = "s-tz";
const HELPER = { agentId: "a_000000000001", name: "助手", description: "", instructions: "", models: ["fake-model"], tools: [] };
const fakeWorld: ExecutionWorld = { fs: { read: async () => "", write: async () => {} }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), http: { postJson: async () => ({}) } };

function open() {
  const store = new EventStore(join(tempDir("mrotto-runtime-tz-"), "session.db"));
  store.append({ sessionId: SID, ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "home", home: true, chat: { kind: "dm" } } });
  const adapter: ModelAdapter = { model: "fake-model", async chat() { return { content: "好的" }; } };
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "home", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => [HELPER], adapterFor: () => adapter, px: { edgeBase: "https://edge.example", runtimeSecret: "sek" },
    hostUids: async () => [OWNER], onEvent: () => {}, onUsage: () => {},
    wiki: createWikiService({ workspaceId: "home", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true }),
    mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, approveAll: true, callback: null,
    routines: null,
  };
  return { session: createCloudSession(opts), store };
}

describe("say() 的 tz", () => {
  it("给了就落在开场白上；不给就没有这一格", async () => {
    const { session, store } = open();
    await session.say(OWNER, "小明", "早", true, [HELPER.agentId], undefined, [], undefined, undefined, "Asia/Shanghai");
    await session.settled();
    await session.say(OWNER, "小明", "晚", true, [HELPER.agentId], undefined, []);
    await session.settled();
    const openings = store.load(SID).filter((e): e is UserMessageEvent => e.type === "user_message");
    expect(openings[0]?.tz).toBe("Asia/Shanghai");
    expect("tz" in openings[1]!).toBe(false);
    store.close();
  });
});
```

（`routines: null` 是 Task 10 要加的必需字段；在 Task 10 之前这一行会让 tsc 报「多余属性」——**本任务先不写它**，Task 10 回来补。）

- [ ] **Step 6: 跑一遍确认红**

Run: `npx vitest run tests/runtime/sessionService.tz.test.ts`
Expected: FAIL（第 10 个参数被忽略 / tsc 报参数个数）

- [ ] **Step 7: runtime 透传与落盘**

`services/runtime/src/sessionService.ts` 的 `CloudSession.say` 签名（`:562-572`）末尾加 `tz?: string`，注释补一句「`tz`（#1283）：发话人设备的时区，原样落到 user_message.tz；同 voice 只往下传到落盘那一格」。实现 `async say(fromUid, label, text, mention, mentions, budget, memberMentions, voice, media, tz)`；`:3021` 的 `...(voice !== undefined ? { voice } : {}),` 之后加：

```ts
        // 设备时区（#1283）：只给投影里「今天是」那一行用，起 turn 那一路一个判断都不读它
        ...(tz !== undefined ? { tz } : {}),
```

`services/runtime/src/frameHandler.ts:810-812` 的调用末尾加 `msg.tz`：

```ts
            await session.say(
              entry.uid, entry.label, msg.text, msg.mention, msg.mentions, budget, msg.memberMentions, msg.voice, msg.media, msg.tz
            );
```

`tests/runtime/frameHandler.test.ts` 的 `fakeSession` 不用改（`say: async () => {}` 接受任意参数）。

- [ ] **Step 8: 手机注入设备时区**

`mobile/src/cloud/cloudClient.ts` 的 `createCloudSessionClient({ … })` 里 `selfUid: () => uid,` 之后加：

```ts
  // 设备时区（#1283）：每句话带上，runtime 落到 user_message.tz，模型投影的「今天是」才按人在的地方算
  deviceTz: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
```

- [ ] **Step 9: 跑测试 + 两端 tsc**

Run: `npx vitest run tests/runtime/sessionService.tz.test.ts tests/runtime/frameHandler.test.ts && npx tsc --noEmit && npm --prefix mobile run typecheck 2>/dev/null || (cd mobile && npx tsc --noEmit)`
Expected: PASS / 零错误

- [ ] **Step 10: 提交**

```bash
git add src/shared/remote/cloudSession.ts src/shared/remote/cloudSessionClient.ts services/runtime/src/frameHandler.ts services/runtime/src/sessionService.ts mobile/src/cloud/cloudClient.ts tests/shared/cloudSessionTz.test.ts tests/runtime/sessionService.tz.test.ts
git commit -m "feat(cloud): say 帧带设备时区，落到 user_message.tz（#1283）

可选字段、协议号不升：旧 runtime 忽略、旧客户端不发。脏值当缺席不拒帧——它只影响
「今天是」那一行，为它拒掉一句真话更糟。第 10 个位置参数放最后，同 voice 那条纪律。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: engine 可选 `maxRounds`

**Files:**
- Modify: `src/loop/engine.ts`（`LoopEngineOptions` 的 `loopGuardMaxNudges` 之后 ~`:137`；`loop()` 的 `while (true) {` 之后 ~`:792`）
- Test: `tests/loop/engineMaxRounds.test.ts`

**Interfaces:**
- Produces：`LoopEngineOptions.maxRounds?: () => number | undefined`——每轮起跑时现取；回 `undefined` / `0` / 负数 = 不封顶（老行为逐字节不变）；到数抛 `Error`，走既有的 `turn_ended{outcome:"error"}`。错误文案含「跑满 N 步」。

- [ ] **Step 1: 写失败的测试**

```ts
// routine 轮的圈数硬上限（#1283，spec §5.4）。同 loopGuardMaxNudges：缺席 = 现状（永不停，ADR-0006 那句
// 「无步数天花板」对有人在场的会话仍成立）；配了就在第 N 圈之前抛错，走既有的 turn_ended{outcome:"error"}。
import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

/** 每圈换一条不同的命令（不触发退化循环护栏），giveUpAfter 圈后自己收口 */
function busyAdapter(giveUpAfter: number) {
  let n = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(): Promise<ModelReply> {
      if (n >= giveUpAfter) return { content: "做完了" };
      n++;
      return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: `echo ${n}` } }] };
    },
  };
  return { adapter, calls: () => n };
}

function run(maxRounds: (() => number | undefined) | undefined) {
  const store = new EventStore(":memory:");
  const { adapter, calls } = busyAdapter(12);
  const engine = new LoopEngine({
    store, adapter, tools: [bashTool], world, sessionId: "s", workspace: "/w",
    ...(maxRounds ? { maxRounds } : {}),
  });
  return { engine, store, calls };
}

describe("maxRounds（#1283）", () => {
  it("配了 5：第 5 圈之后抛错收口，turn_ended outcome=error，文案说清是跑满了", async () => {
    const { engine, store, calls } = run(() => 5);
    await engine.runTurn("跑一下").catch(() => {});
    const ended = store.load("s").filter((e) => e.type === "turn_ended").at(-1) as { outcome: string; error?: string };
    expect(ended.outcome).toBe("error");
    expect(ended.error).toContain("跑满 5 步");
    expect(calls()).toBe(5);
  });
  it("缺席 / 回 undefined / 回 0：不封顶，模型自己收口", async () => {
    for (const cap of [undefined, () => undefined, () => 0]) {
      const { engine, store, calls } = run(cap);
      await engine.runTurn("跑一下");
      expect(calls()).toBe(12);
      expect((store.load("s").filter((e) => e.type === "turn_ended").at(-1) as { outcome: string }).outcome).toBe("completed");
    }
  });
});
```

（`LoopEngine` 构造参数的确切形状看 `tests/loop/engineLoopGuardCap.test.ts` 第 44–60 行照抄：`sessionId` / `workspace` 两个字段名以那里为准，`runTurn` 的调用形状也以那里为准。）

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/loop/engineMaxRounds.test.ts`
Expected: FAIL（第一条：跑了 12 圈）

- [ ] **Step 3: 实现**

`LoopEngineOptions` 里 `loopGuardMaxNudges?: number;` 之后加：

```ts
  /** 单 turn 模型步数硬上限（#1283，spec §5.4）：**每轮起跑时现取**，回 undefined / 0 / 负数 = 不封顶
      （缺席 = 现状，ADR-0006「无步数天花板」对有人在场的会话仍成立）。给没人在场的 routine 轮用：
      没人按停止键，一条跑 300 圈的 turn 没有任何终点。到数抛错，走 runFrom 既有的
      turn_ended{outcome:"error"}，不新造 outcome 也不新造事件类型（同 loopGuardMaxNudges） */
  maxRounds?: () => number | undefined;
```

`loop()` 里 `let rounds = 0;` 之后加 `const roundCap = this.opts.maxRounds?.() ?? 0;`；`while (true) {` 的 `signal.throwIfAborted();` 之后加：

```ts
      if (roundCap > 0 && rounds >= roundCap) {
        throw new Error(`这一轮已经跑满 ${roundCap} 步还没收口，先停在这里（没人在场的那一轮有圈数上限）`);
      }
```

- [ ] **Step 4: 跑 engine 全部测试确认绿**

Run: `npx vitest run tests/loop`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/loop/engine.ts tests/loop/engineMaxRounds.test.ts
git commit -m "feat(engine): 可选的 maxRounds——没人在场的那一轮要有圈数上限（#1283）

缺席 = 现状（有人在场自己会按停止，ADR-0006 那句仍成立）；到数抛错走既有的
turn_ended{outcome:\"error\"}，同 loopGuardMaxNudges，不新造事件。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: routine 开场白算主人亲口（`openingTraits` + `tightenSupervision`）

**Files:**
- Modify: `src/shared/outreach.ts:135-144`
- Modify: `services/runtime/src/sessionService.ts:896-912`（`tightenSupervision`）
- Test: `tests/shared/outreach.test.ts`（`openingTraits` 那个 describe 里加两条）

**Interfaces:**
- Consumes：Task 3 的 `greeting:"routine"`。
- Produces：`openingTraits` 的 `ownerSpoke` 对 `{ fromUid: owner, greeting: "routine" }` 为真；其余 greeting 仍为假。

- [ ] **Step 1: 写失败的测试**

在 `describe("openingTraits…")` 里加：

```ts
  it("routine 开场白算主人亲口（#1283）：任务原话是主人写的；混进别的 greeting 仍为假", () => {
    const routine = { fromUid: OWNER, greeting: "routine" };
    expect(o.openingTraits([routine], OWNER)).toEqual({ report: false, ownerSpoke: true, nonOwner: false });
    expect(o.openingTraits([plain, routine], OWNER).ownerSpoke).toBe(true);
    expect(o.openingTraits([routine, { fromUid: OWNER, greeting: "callback" }], OWNER).ownerSpoke).toBe(false);
    expect(o.openingTraits([{ fromUid: "guest", greeting: "routine" }], OWNER)).toMatchObject({ ownerSpoke: false, nonOwner: true });
  });
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/shared/outreach.test.ts -t "routine"`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/shared/outreach.ts` 的 `openingTraits`：

```ts
    // routine 开场白（#1283）是 greeting 一族里唯一算「主人亲口」的：正文是主人自己写的任务原话，
    // 与他当场说一句逐字等价；不放行的话定时轮里 call_friend 永远灭着（spec §5.2 的已知代价）
    ownerSpoke: openings.length > 0 && openings.every((o) => o.fromUid === ownerUid && o.relay === undefined && (o.greeting === undefined || o.greeting === "routine")),
```

`services/runtime/src/sessionService.ts` 的 `tightenSupervision`：

```ts
      } else if ((e.greeting !== undefined && e.greeting !== "routine") || e.relay !== undefined) {
        ownerSpoke = false;
      }
```

并在那段注释里补一句「routine 开场白不收紧（#1283）：同 openingTraits」。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/shared/outreach.test.ts tests/runtime/sessionService.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/outreach.ts services/runtime/src/sessionService.ts tests/shared/outreach.test.ts
git commit -m "feat(supervision): 定时任务的开场白算主人亲口——任务原话是他写的（#1283）

不放行的话 routine 轮里 call_friend 永远灭着，「定时打给好友」做不成。这是本设计
唯一放宽的一处，代价写在 spec §5.2 / ADR-0356。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `RoutineStore`（接口 + Supabase + 内存）与三把刀

**Files:**
- Create: `services/runtime/src/routineStore.ts`
- Create: `services/runtime/src/routineTools.ts`
- Test: `tests/runtime/routineStore.test.ts`、`tests/runtime/routineTools.test.ts`

**Interfaces:**
- Consumes：Task 1 全部。
- Produces：

```ts
// routineStore.ts
export type RoutineInsert = Pick<RoutineRow, "workspaceId" | "agentId" | "ownerUid" | "title" | "instruction" | "schedule" | "tz" | "createdBy"> & { nextRunAt: number | null };
export type RoutinePatch = Partial<Pick<RoutineRow, "title" | "instruction" | "schedule" | "tz" | "enabled" | "nextRunAt">>;
export interface RoutineStore {
  list(workspaceId: string, agentId: string): Promise<RoutineRow[]>;                 // 按 createdAt 升序
  get(id: string): Promise<RoutineRow | null>;
  insert(row: RoutineInsert): Promise<RoutineRow>;
  update(id: string, ownerUid: string, patch: RoutinePatch): Promise<RoutineRow | null>; // 不是他的 / 没有 → null
  remove(id: string, ownerUid: string): Promise<boolean>;
  due(nowMs: number, limit: number): Promise<RoutineRow[]>;                           // next_run_at <= now，升序
  claim(id: string, expectedNextRunAt: number, next: { nextRunAt: number | null; lastRunAt: number }): Promise<boolean>;
  setStatus(id: string, status: RoutineStatus, enabled?: boolean): Promise<void>;
  purge(beforeMs: number): Promise<number>;                                           // enabled=false 且 last_status in (done,missed) 且 last_run_at < before
  ownerTimezone(ownerUid: string): Promise<string | null>;                            // profiles.timezone
}
export function createSupabaseRoutineStore(supabase: SupabaseClient): RoutineStore;
export function createInMemoryRoutineStore(): RoutineStore & { rows(): RoutineRow[]; setTimezone(uid: string, tz: string | null): void };
export function routineRowOf(raw: Record<string, unknown>): RoutineRow;              // 列名 → 字段名；schedule 过 parseRoutineSchedule

// routineTools.ts
export interface RoutineToolDeps {
  workspaceId: string; agentId: string; ownerUid: string;
  store: RoutineStore;
  now: () => number;
  /** 此刻亮不亮（sessionService 给：主人亲口的轮 && 不受监督） */
  available: () => boolean;
}
export function createRoutineTools(deps: RoutineToolDeps): Tool[];   // [schedule_task, list_schedules, update_schedule]
```

- [ ] **Step 1: 写失败的测试（store 的内存实现 + 行映射）**

`tests/runtime/routineStore.test.ts`：

```ts
// RoutineStore 的内存实现——调度器与工具的测试都踩它，所以它自己的语义先钉死（认领的原子性、due 的排序、purge 的判据）。
import { describe, expect, it } from "vitest";
import { createInMemoryRoutineStore, routineRowOf } from "../../services/runtime/src/routineStore.js";

const base = { workspaceId: "w", agentId: "ops", ownerUid: "owner", title: "早报", instruction: "看报表", tz: "Asia/Shanghai", createdBy: "agent" as const };

describe("createInMemoryRoutineStore", () => {
  it("insert / list / get / update（只有本人）/ remove（只有本人）", async () => {
    const s = createInMemoryRoutineStore();
    const r = await s.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: 100 });
    expect(r.id).toBeTruthy();
    expect((await s.list("w", "ops")).map((x) => x.id)).toEqual([r.id]);
    expect(await s.update(r.id, "someone-else", { title: "x" })).toBeNull();
    expect((await s.update(r.id, "owner", { title: "晚报", enabled: false, nextRunAt: null }))?.title).toBe("晚报");
    expect((await s.get(r.id))?.enabled).toBe(false);
    expect(await s.remove(r.id, "someone-else")).toBe(false);
    expect(await s.remove(r.id, "owner")).toBe(true);
    expect(await s.list("w", "ops")).toEqual([]);
  });
  it("due 只给到点的、按 next_run_at 升序、limit 生效；claim 只认读到的那个 next_run_at", async () => {
    const s = createInMemoryRoutineStore();
    const a = await s.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: 200 });
    const b = await s.insert({ ...base, title: "b", schedule: { kind: "daily", time: "08:00" }, nextRunAt: 100 });
    await s.insert({ ...base, title: "c", schedule: { kind: "daily", time: "10:00" }, nextRunAt: 900 });
    expect((await s.due(300, 10)).map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await s.due(300, 1)).map((x) => x.id)).toEqual([b.id]);
    expect(await s.claim(b.id, 100, { nextRunAt: 86_500_000, lastRunAt: 300 })).toBe(true);
    expect(await s.claim(b.id, 100, { nextRunAt: 86_500_000, lastRunAt: 300 })).toBe(false); // 第二个实例晚一步
    expect((await s.get(b.id))?.nextRunAt).toBe(86_500_000);
  });
  it("setStatus 可顺手停用；purge 只清 enabled=false 且 done/missed 且够久的", async () => {
    const s = createInMemoryRoutineStore();
    const done = await s.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: null });
    await s.claim(done.id, 0, { nextRunAt: null, lastRunAt: 0 }).catch(() => {});
    await s.update(done.id, "owner", { nextRunAt: null });
    await s.setStatus(done.id, "done", false);
    const failed = await s.insert({ ...base, title: "f", schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: null });
    await s.setStatus(failed.id, "failed", false);
    expect(await s.purge(1)).toBe(0); // last_run_at 还没写（null 不算够久）
    await s.update(done.id, "owner", {});
    (await s.get(done.id))!.lastRunAt; // 内存实现里 setStatus 不改 lastRunAt
    const s2 = createInMemoryRoutineStore();
    const r = await s2.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: 50 });
    await s2.claim(r.id, 50, { nextRunAt: null, lastRunAt: 60 });
    await s2.setStatus(r.id, "done", false);
    expect(await s2.purge(59)).toBe(0);
    expect(await s2.purge(61)).toBe(1);
    expect(await s2.get(r.id)).toBeNull();
  });
  it("routineRowOf：列名翻字段名，时间戳翻毫秒，schedule 过校验", () => {
    const row = routineRowOf({
      id: "r1", workspace_id: "w", agent_id: "ops", owner_uid: "owner", title: "早报", instruction: "看报表",
      schedule: { kind: "weekly", days: [3, 1], time: "09:00" }, tz: "Asia/Shanghai", enabled: true,
      next_run_at: "2026-10-05T01:00:00+00:00", last_run_at: null, last_status: null, created_by: "user",
      created_at: "2026-10-04T00:00:00+00:00", updated_at: "2026-10-04T00:00:00+00:00",
    });
    expect(row).toMatchObject({ id: "r1", workspaceId: "w", agentId: "ops", schedule: { kind: "weekly", days: [1, 3], time: "09:00" }, nextRunAt: Date.UTC(2026, 9, 5, 1), lastRunAt: null, createdBy: "user" });
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/runtime/routineStore.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `services/runtime/src/routineStore.ts`**

```ts
// agent_routines 那张表的读写口（#1283，spec §2.1 / §3）。两份实现：Supabase（daemon 用 service key）与内存
// （调度器 / 工具的测试踩它）。调度器与工具只认这个接口——工具那边是硬规则「工具只依赖接口」，
// 调度器那边是 daemon.ts 进不了 vitest。
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseRoutineSchedule, type RoutineRow, type RoutineStatus } from "../../../src/shared/routines.js";

export type RoutineInsert = Pick<RoutineRow, "workspaceId" | "agentId" | "ownerUid" | "title" | "instruction" | "schedule" | "tz" | "createdBy"> & { nextRunAt: number | null };
export type RoutinePatch = Partial<Pick<RoutineRow, "title" | "instruction" | "schedule" | "tz" | "enabled" | "nextRunAt">>;

export interface RoutineStore {
  list(workspaceId: string, agentId: string): Promise<RoutineRow[]>;
  get(id: string): Promise<RoutineRow | null>;
  insert(row: RoutineInsert): Promise<RoutineRow>;
  update(id: string, ownerUid: string, patch: RoutinePatch): Promise<RoutineRow | null>;
  remove(id: string, ownerUid: string): Promise<boolean>;
  /** next_run_at <= nowMs 的行，按 next_run_at 升序 */
  due(nowMs: number, limit: number): Promise<RoutineRow[]>;
  /** 原子认领：只有 next_run_at 仍等于读到的那个值才改。回 false = 另一个实例先到 */
  claim(id: string, expectedNextRunAt: number, next: { nextRunAt: number | null; lastRunAt: number }): Promise<boolean>;
  setStatus(id: string, status: RoutineStatus, enabled?: boolean): Promise<void>;
  /** 清掉 enabled=false 且 last_status in (done, missed) 且 last_run_at < beforeMs 的行，回清了几条 */
  purge(beforeMs: number): Promise<number>;
  ownerTimezone(ownerUid: string): Promise<string | null>;
}

const ms = (v: unknown): number | null => (typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : null);
const iso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());

export function routineRowOf(raw: Record<string, unknown>): RoutineRow {
  return {
    id: String(raw.id), workspaceId: String(raw.workspace_id), agentId: String(raw.agent_id), ownerUid: String(raw.owner_uid),
    title: String(raw.title ?? ""), instruction: String(raw.instruction ?? ""), schedule: parseRoutineSchedule(raw.schedule), tz: String(raw.tz),
    enabled: raw.enabled === true, nextRunAt: ms(raw.next_run_at), lastRunAt: ms(raw.last_run_at),
    lastStatus: (raw.last_status as RoutineStatus | null) ?? null, createdBy: raw.created_by === "user" ? "user" : "agent",
    createdAt: ms(raw.created_at) ?? 0, updatedAt: ms(raw.updated_at) ?? 0,
  };
}

const COLS = "id,workspace_id,agent_id,owner_uid,title,instruction,schedule,tz,enabled,next_run_at,last_run_at,last_status,created_by,created_at,updated_at";

function columnsOf(p: RoutinePatch): Record<string, unknown> {
  const c: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.title !== undefined) c.title = p.title;
  if (p.instruction !== undefined) c.instruction = p.instruction;
  if (p.schedule !== undefined) c.schedule = p.schedule;
  if (p.tz !== undefined) c.tz = p.tz;
  if (p.enabled !== undefined) c.enabled = p.enabled;
  if (p.nextRunAt !== undefined) c.next_run_at = iso(p.nextRunAt);
  return c;
}

export function createSupabaseRoutineStore(supabase: SupabaseClient): RoutineStore {
  const fail = (what: string, e: { message: string } | null): never => { throw new Error(`${what}：${e?.message ?? "no data"}`); };
  return {
    async list(workspaceId, agentId) {
      const r = await supabase.from("agent_routines").select(COLS).eq("workspace_id", workspaceId).eq("agent_id", agentId).order("created_at", { ascending: true });
      if (r.error) fail("定时任务读取失败", r.error);
      return ((r.data ?? []) as Record<string, unknown>[]).map(routineRowOf);
    },
    async get(id) {
      const r = await supabase.from("agent_routines").select(COLS).eq("id", id).maybeSingle();
      if (r.error) fail("定时任务读取失败", r.error);
      return r.data ? routineRowOf(r.data as Record<string, unknown>) : null;
    },
    async insert(row) {
      const r = await supabase.from("agent_routines").insert({
        workspace_id: row.workspaceId, agent_id: row.agentId, owner_uid: row.ownerUid, title: row.title, instruction: row.instruction,
        schedule: row.schedule, tz: row.tz, next_run_at: iso(row.nextRunAt), created_by: row.createdBy,
      }).select(COLS).single();
      if (r.error || !r.data) fail("定时任务写入失败", r.error);
      return routineRowOf(r.data as Record<string, unknown>);
    },
    async update(id, ownerUid, patch) {
      const r = await supabase.from("agent_routines").update(columnsOf(patch)).eq("id", id).eq("owner_uid", ownerUid).select(COLS).maybeSingle();
      if (r.error) fail("定时任务更新失败", r.error);
      return r.data ? routineRowOf(r.data as Record<string, unknown>) : null;
    },
    async remove(id, ownerUid) {
      const r = await supabase.from("agent_routines").delete().eq("id", id).eq("owner_uid", ownerUid).select("id");
      if (r.error) fail("定时任务删除失败", r.error);
      return (r.data ?? []).length > 0;
    },
    async due(nowMs, limit) {
      const r = await supabase.from("agent_routines").select(COLS).not("next_run_at", "is", null).lte("next_run_at", new Date(nowMs).toISOString())
        .order("next_run_at", { ascending: true }).limit(limit);
      if (r.error) fail("到点任务读取失败", r.error);
      return ((r.data ?? []) as Record<string, unknown>[]).map(routineRowOf);
    },
    async claim(id, expectedNextRunAt, next) {
      // where next_run_at = 读到的值：两个实例同时 tick 只有一个改得动（spec §3.2）
      const r = await supabase.from("agent_routines")
        .update({ next_run_at: iso(next.nextRunAt), last_run_at: iso(next.lastRunAt), updated_at: new Date().toISOString() })
        .eq("id", id).eq("next_run_at", new Date(expectedNextRunAt).toISOString()).select("id");
      if (r.error) fail("定时任务认领失败", r.error);
      return (r.data ?? []).length > 0;
    },
    async setStatus(id, status, enabled) {
      const r = await supabase.from("agent_routines").update({ last_status: status, ...(enabled !== undefined ? { enabled } : {}), updated_at: new Date().toISOString() }).eq("id", id);
      if (r.error) fail("定时任务状态写入失败", r.error);
    },
    async purge(beforeMs) {
      const r = await supabase.from("agent_routines").delete().eq("enabled", false).in("last_status", ["done", "missed"]).lt("last_run_at", new Date(beforeMs).toISOString()).select("id");
      if (r.error) fail("定时任务清理失败", r.error);
      return (r.data ?? []).length;
    },
    async ownerTimezone(ownerUid) {
      const r = await supabase.from("profiles").select("timezone").eq("id", ownerUid).maybeSingle();
      if (r.error) fail("时区读取失败", r.error);
      const tz = (r.data as { timezone?: string | null } | null)?.timezone;
      return typeof tz === "string" && tz !== "" ? tz : null;
    },
  };
}

export function createInMemoryRoutineStore(): RoutineStore & { rows(): RoutineRow[]; setTimezone(uid: string, tz: string | null): void } {
  const rows = new Map<string, RoutineRow>();
  const tzs = new Map<string, string | null>();
  let n = 0;
  return {
    rows: () => [...rows.values()],
    setTimezone: (uid, tz) => void tzs.set(uid, tz),
    async list(w, a) { return [...rows.values()].filter((r) => r.workspaceId === w && r.agentId === a).sort((x, y) => x.createdAt - y.createdAt); },
    async get(id) { return rows.get(id) ?? null; },
    async insert(row) {
      n++;
      const r: RoutineRow = { ...row, id: `r${n}`, enabled: true, lastRunAt: null, lastStatus: null, createdAt: n, updatedAt: n };
      rows.set(r.id, r);
      return r;
    },
    async update(id, ownerUid, patch) {
      const r = rows.get(id);
      if (!r || r.ownerUid !== ownerUid) return null;
      const next = { ...r, ...patch, updatedAt: r.updatedAt + 1 };
      rows.set(id, next);
      return next;
    },
    async remove(id, ownerUid) {
      const r = rows.get(id);
      if (!r || r.ownerUid !== ownerUid) return false;
      rows.delete(id);
      return true;
    },
    async due(nowMs, limit) {
      return [...rows.values()].filter((r) => r.nextRunAt !== null && r.nextRunAt <= nowMs).sort((x, y) => x.nextRunAt! - y.nextRunAt!).slice(0, limit);
    },
    async claim(id, expected, next) {
      const r = rows.get(id);
      if (!r || r.nextRunAt !== expected) return false;
      rows.set(id, { ...r, nextRunAt: next.nextRunAt, lastRunAt: next.lastRunAt });
      return true;
    },
    async setStatus(id, status, enabled) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, lastStatus: status, ...(enabled !== undefined ? { enabled } : {}) });
    },
    async purge(beforeMs) {
      let k = 0;
      for (const [id, r] of rows) {
        if (!r.enabled && (r.lastStatus === "done" || r.lastStatus === "missed") && r.lastRunAt !== null && r.lastRunAt < beforeMs) { rows.delete(id); k++; }
      }
      return k;
    },
    async ownerTimezone(uid) { return tzs.get(uid) ?? null; },
  };
}
```

- [ ] **Step 4: 跑 store 测试确认绿**

Run: `npx vitest run tests/runtime/routineStore.test.ts`
Expected: PASS（第三条里前半段那几行只是在摆弄状态、不断言；嫌啰嗦可以删到只剩 `s2` 那一段）

- [ ] **Step 5: 写失败的测试（三把刀）**

`tests/runtime/routineTools.test.ts`：

```ts
// 三把刀（#1283，spec §7）：只认 RoutineStore；tz 省略用主人的；回显带「下次执行」；20 条上限；不是自己的改不动。
import { describe, expect, it } from "vitest";
import { createRoutineTools } from "../../services/runtime/src/routineTools.js";
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";
import { LIST_SCHEDULES_TOOL_NAME, SCHEDULE_TASK_TOOL_NAME, UPDATE_SCHEDULE_TOOL_NAME } from "../../src/shared/routines.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;
// 2026-10-05 08:00 上海
const NOW = Date.UTC(2026, 9, 5, 0, 0);

function rig(tz: string | null = "Asia/Shanghai", available = true) {
  const store = createInMemoryRoutineStore();
  store.setTimezone("owner", tz);
  const tools = createRoutineTools({ workspaceId: "w", agentId: "ops", ownerUid: "owner", store, now: () => NOW, available: () => available });
  const by = (name: string) => tools.find((t) => t.def.name === name)!;
  return { store, schedule: by(SCHEDULE_TASK_TOOL_NAME), list: by(LIST_SCHEDULES_TOOL_NAME), update: by(UPDATE_SCHEDULE_TOOL_NAME), tools };
}
const text = (r: Awaited<ReturnType<ReturnType<typeof rig>["schedule"]["run"]>>): string => (typeof r === "string" ? r : r.output);

describe("routine 三把刀", () => {
  it("三把都不过审批门、available 跟注入的走、说明里有「先问城市」与「复述下次执行」", () => {
    const { tools } = rig("Asia/Shanghai", false);
    expect(tools.map((t) => t.def.name)).toEqual([SCHEDULE_TASK_TOOL_NAME, LIST_SCHEDULES_TOOL_NAME, UPDATE_SCHEDULE_TOOL_NAME]);
    for (const t of tools) { expect(t.requiresApproval).toBe(false); expect(t.available?.()).toBe(false); }
    expect(tools[0]!.def.description).toContain("城市");
    expect(tools[0]!.def.description).toContain("下次执行");
  });
  it("schedule_task：tz 省略用主人的；写一行 created_by=agent；回显 id 与下次执行", async () => {
    const { store, schedule } = rig();
    const out = text(await schedule.run({ title: "早报", instruction: "看报表", schedule: { kind: "daily", time: "09:00" } }, world));
    const row = store.rows()[0]!;
    expect(row).toMatchObject({ workspaceId: "w", agentId: "ops", ownerUid: "owner", createdBy: "agent", tz: "Asia/Shanghai", nextRunAt: Date.UTC(2026, 9, 5, 1, 0) });
    expect(out).toContain(row.id);
    expect(out).toContain("2026-10-05 09:00（Asia/Shanghai，周一）");
  });
  it("主人没有时区又没传 tz：拒绝并让它去问城市；传了坏时区也拒", async () => {
    const { schedule } = rig(null);
    await expect(schedule.run({ title: "x", instruction: "y", schedule: { kind: "daily", time: "09:00" } }, world)).rejects.toThrow("城市");
    await expect(schedule.run({ title: "x", instruction: "y", schedule: { kind: "daily", time: "09:00" }, tz: "Beijing" }, world)).rejects.toThrow("时区");
  });
  it("once 已经过了的时刻拒绝；启用中满 20 条拒绝", async () => {
    const { schedule } = rig();
    await expect(schedule.run({ title: "x", instruction: "y", schedule: { kind: "once", at: "2026-10-05T07:00" } }, world)).rejects.toThrow("已经过了");
    for (let i = 0; i < 20; i++) await schedule.run({ title: `t${i}`, instruction: "y", schedule: { kind: "daily", time: "09:00" } }, world);
    await expect(schedule.run({ title: "多了", instruction: "y", schedule: { kind: "daily", time: "09:00" } }, world)).rejects.toThrow("20");
  });
  it("list_schedules：空与非空各一句；update_schedule：改时间重算下一跳、停用清空下一跳、删除；不是自己的报错", async () => {
    const { store, schedule, list, update } = rig();
    expect(text(await list.run({}, world))).toContain("没有定时任务");
    await schedule.run({ title: "早报", instruction: "看报表", schedule: { kind: "daily", time: "09:00" } }, world);
    const id = store.rows()[0]!.id;
    expect(text(await list.run({}, world))).toContain("每天 09:00 · Asia/Shanghai");
    const moved = text(await update.run({ id, patch: { schedule: { kind: "daily", time: "10:00" } } }, world));
    expect(moved).toContain("10:00");
    expect(store.rows()[0]!.nextRunAt).toBe(Date.UTC(2026, 9, 5, 2, 0));
    await update.run({ id, enabled: false }, world);
    expect(store.rows()[0]).toMatchObject({ enabled: false, nextRunAt: null });
    await update.run({ id, enabled: true }, world);
    expect(store.rows()[0]!.nextRunAt).toBe(Date.UTC(2026, 9, 5, 2, 0));
    await expect(update.run({ id: "nope", enabled: false }, world)).rejects.toThrow("没有这条");
    expect(text(await update.run({ id, delete: true }, world))).toContain("已删除");
    expect(store.rows()).toEqual([]);
  });
});
```

- [ ] **Step 6: 跑一遍确认红**

Run: `npx vitest run tests/runtime/routineTools.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 7: 实现 `services/runtime/src/routineTools.ts`**

```ts
// 定时任务的三把刀（#1283，spec §7）：schedule_task / list_schedules / update_schedule。
// 只依赖注入的 RoutineStore（硬规则「工具只依赖接口」）：不知道 supabase、不知道表名。
// 都不过审批门（同 wikiTool 的「记忆写入」口径）；亮不亮由 sessionService 注入的 available 决定
// （主人亲口的轮 && 不受监督 && 私聊里）——群里一句「每天提醒大家」不该建到某只名下。
// 时间怎么算：模型只给墙上时间（"09:00" / "2026-10-05T15:00"），绝对时刻由这里按 tz 算并回显；
// 相对时间（「今天下午三点」）由模型按开场白 / 系统提示里的「现在是 / 今天是」换算成墙上时间。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import {
  formatInTz, isIanaTimeZone, LIST_SCHEDULES_TOOL_NAME, nextRunAt, parseRoutineSchedule, routineErrors, ROUTINES_ENABLED_MAX,
  ROUTINE_INSTRUCTION_MAX, ROUTINE_TITLE_MAX, SCHEDULE_TASK_TOOL_NAME, scheduleText, UPDATE_SCHEDULE_TOOL_NAME, type RoutineRow, type RoutineSchedule,
} from "../../../src/shared/routines.js";
import type { RoutineStore } from "./routineStore.js";

export interface RoutineToolDeps {
  workspaceId: string;
  agentId: string;
  ownerUid: string;
  store: RoutineStore;
  now: () => number;
  available: () => boolean;
}

const SCHEDULE_SCHEMA = {
  type: "object",
  description: "三种形状之一：{kind:'once', at:'YYYY-MM-DDTHH:mm'}（一次性，墙上时间）/ {kind:'daily', time:'HH:mm'} / {kind:'weekly', days:[1..7], time:'HH:mm'}（1 = 周一 … 7 = 周日）",
  properties: {
    kind: { type: "string", enum: ["once", "daily", "weekly"] },
    at: { type: "string" }, time: { type: "string" }, days: { type: "array", items: { type: "integer" } },
  },
  required: ["kind"],
};

const nextText = (r: RoutineRow): string => (r.nextRunAt === null ? "没有下一次" : `下次执行：${formatInTz(r.nextRunAt, r.tz)}`);
const lineOf = (r: RoutineRow): string =>
  `- [${r.id}]「${r.title}」${scheduleText(r.schedule, r.tz)}；${r.enabled ? "启用中" : "已停用"}；${nextText(r)}` +
  (r.lastStatus !== null ? `；上次：${r.lastStatus}` : "") + `\n  任务：${r.instruction}`;

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null) throw new Error("参数要是一个对象");
  return args as Record<string, unknown>;
}

export function createRoutineTools(deps: RoutineToolDeps): Tool[] {
  const resolveTz = async (given: unknown): Promise<string> => {
    if (given !== undefined) {
      if (!isIanaTimeZone(given)) throw new Error("tz 要是 IANA 时区名（比如 Asia/Shanghai、Australia/Sydney）");
      return given;
    }
    const own = await deps.store.ownerTimezone(deps.ownerUid);
    if (own === null) throw new Error("还不知道他在哪个时区：先问他在哪个城市，换成 IANA 时区名用 tz 传进来");
    return own;
  };
  const mine = async (id: unknown): Promise<RoutineRow> => {
    if (typeof id !== "string" || id === "") throw new Error("要带 id（先用 list_schedules 看）");
    const r = await deps.store.get(id);
    if (!r || r.ownerUid !== deps.ownerUid || r.workspaceId !== deps.workspaceId || r.agentId !== deps.agentId) throw new Error("没有这条定时任务（先用 list_schedules 看）");
    return r;
  };

  const schedule: Tool = {
    def: {
      name: SCHEDULE_TASK_TOOL_NAME,
      description:
        "给自己记一条定时任务：到点我会在这条私聊里收到一句「定时任务到点」，然后按任务去做。" +
        "一次性的（kind once）跑完就自动停用；每天 / 每周几的（daily / weekly）长期有效。" +
        "时间写**墙上时间**，不带时区；tz 不传 = 主人设备的时区。人说的是相对时间（「今天下午三点」「明早」）就按对话里的「现在是 / 今天是」换算。" +
        "**任务里要打给好友的，先问清好友在哪个城市，换成 IANA 时区名用 tz 传进来；没问到别建。**" +
        "建好之后用人话复述一遍「下次执行」的时间给用户确认。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: `一句话标题，≤ ${ROUTINE_TITLE_MAX} 字` },
          instruction: { type: "string", description: `到点要做什么，用户的原话，≤ ${ROUTINE_INSTRUCTION_MAX} 字` },
          schedule: SCHEDULE_SCHEMA,
          tz: { type: "string", description: "IANA 时区名；不传 = 主人的设备时区" },
        },
        required: ["title", "instruction", "schedule"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    available: deps.available,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = asRecord(args);
      const tz = await resolveTz(a.tz);
      const title = String(a.title ?? "").trim();
      const instruction = String(a.instruction ?? "").trim();
      const err = routineErrors({ title, instruction, schedule: a.schedule, tz });
      if (err !== null) throw new Error(err);
      const sched: RoutineSchedule = parseRoutineSchedule(a.schedule);
      const next = nextRunAt(sched, tz, deps.now());
      if (next === null) throw new Error("这个时刻已经过了，换一个将来的时间");
      const enabled = (await deps.store.list(deps.workspaceId, deps.agentId)).filter((r) => r.enabled).length;
      if (enabled >= ROUTINES_ENABLED_MAX) throw new Error(`启用中的定时任务已经有 ${ROUTINES_ENABLED_MAX} 条了，先停掉或删掉几条`);
      const row = await deps.store.insert({ workspaceId: deps.workspaceId, agentId: deps.agentId, ownerUid: deps.ownerUid, title, instruction, schedule: sched, tz, createdBy: "agent", nextRunAt: next });
      return `已记下「${row.title}」（id ${row.id}）：${scheduleText(row.schedule, row.tz)}。${nextText(row)}。请用人话复述给用户确认。`;
    },
  };

  const list: Tool = {
    def: { name: LIST_SCHEDULES_TOOL_NAME, description: "看我名下的全部定时任务（id、标题、形状、下次执行、启用否）。要改 / 停 / 删之前先用它拿 id。", parameters: { type: "object", properties: {} } },
    exposure: "direct",
    requiresApproval: false,
    parallelSafe: true,
    available: deps.available,
    async run() {
      const rows = await deps.store.list(deps.workspaceId, deps.agentId);
      return rows.length === 0 ? "我名下还没有定时任务。" : `我名下的定时任务：\n${rows.map(lineOf).join("\n")}`;
    },
  };

  const update: Tool = {
    def: {
      name: UPDATE_SCHEDULE_TOOL_NAME,
      description: "改一条定时任务：patch 里给要改的字段（title / instruction / schedule / tz），enabled 停用或启用，delete:true 删掉。改完复述新的「下次执行」。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          patch: { type: "object", properties: { title: { type: "string" }, instruction: { type: "string" }, schedule: SCHEDULE_SCHEMA, tz: { type: "string" } } },
          enabled: { type: "boolean" },
          delete: { type: "boolean" },
        },
        required: ["id"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    available: deps.available,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = asRecord(args);
      const r = await mine(a.id);
      if (a.delete === true) {
        await deps.store.remove(r.id, deps.ownerUid);
        return `已删除「${r.title}」。`;
      }
      const p = typeof a.patch === "object" && a.patch !== null ? (a.patch as Record<string, unknown>) : {};
      const title = p.title !== undefined ? String(p.title).trim() : r.title;
      const instruction = p.instruction !== undefined ? String(p.instruction).trim() : r.instruction;
      const tz = p.tz !== undefined ? await resolveTz(p.tz) : r.tz;
      const scheduleRaw = p.schedule !== undefined ? p.schedule : r.schedule;
      const err = routineErrors({ title, instruction, schedule: scheduleRaw, tz });
      if (err !== null) throw new Error(err);
      const sched = parseRoutineSchedule(scheduleRaw);
      const enabled = typeof a.enabled === "boolean" ? a.enabled : r.enabled;
      const next = enabled ? nextRunAt(sched, tz, deps.now()) : null;
      if (enabled && next === null) throw new Error("这个时刻已经过了，换一个将来的时间");
      if (enabled && !r.enabled) {
        const n = (await deps.store.list(deps.workspaceId, deps.agentId)).filter((x) => x.enabled && x.id !== r.id).length;
        if (n >= ROUTINES_ENABLED_MAX) throw new Error(`启用中的定时任务已经有 ${ROUTINES_ENABLED_MAX} 条了，先停掉或删掉几条`);
      }
      const row = await deps.store.update(r.id, deps.ownerUid, { title, instruction, schedule: sched, tz, enabled, nextRunAt: next });
      if (!row) throw new Error("没有这条定时任务（先用 list_schedules 看）");
      return `已更新「${row.title}」：${scheduleText(row.schedule, row.tz)}；${row.enabled ? "启用中" : "已停用"}。${nextText(row)}。`;
    },
  };

  return [schedule, list, update];
}
```

- [ ] **Step 8: 跑测试确认绿 + 架构测试**

Run: `npx vitest run tests/runtime/routineTools.test.ts tests/runtime/routineStore.test.ts tests/architecture.test.ts`
Expected: PASS（架构测试盯「工具不 import fs / child_process」——routineTools 只 import 类型与 shared）

- [ ] **Step 9: 提交**

```bash
git add services/runtime/src/routineStore.ts services/runtime/src/routineTools.ts tests/runtime/routineStore.test.ts tests/runtime/routineTools.test.ts
git commit -m "feat(runtime): RoutineStore（Supabase + 内存）与定时任务三把刀（#1283）

刀只认接口；时区省略用主人设备的，没有就让它去问城市；打给好友的任务说明里写死先问城市。
认领那条 update 带 where next_run_at = 读到的值，两个实例只有一个改得动。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `sessionService` —— `runRoutine` / `logRoutineNote`、挂刀、routine 轮的圈数上限

**Files:**
- Modify: `services/runtime/src/sessionService.ts`：`CloudSessionOpts`（`:509-526` 一带加 `routines`）、`CloudSession` 接口（`:673-683` 一带加两个方法）、`tightenSupervision` 附近的旗（`:880-920`）、工具表（`:1500-1546`）、`new LoopEngine({…})`（`:1526`）、`runJob` 里 `applyTraits(covered, depth)` 的调用处、`greetNewAgent` 之后（`:3208`）
- Modify: `tests/runtime/frameHandler.test.ts:20-45`（`fakeSession` 补两个方法）、`tests/runtime/sessionService.test.ts:55-66` 与 `tests/runtime/sessionService.pair.test.ts` 的 opts（补 `routines: null`）、`tests/runtime/sessionService.tz.test.ts`（补 `routines: null`）
- Test: `tests/runtime/sessionService.routine.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `routineOpeningText` / `ROUTINE_MAX_ROUNDS`；Task 3 的事件格；Task 7 的 `maxRounds`；Task 9 的 `RoutineStore` / `createRoutineTools`。
- Produces：

```ts
// CloudSessionOpts
/** 定时任务（#1283）。**必需**（同 agentWriter 的纪律）：null = 不挂刀（团队会话 / 0057 没跑 / 外联）。
    刀只挂在 approveAll 且 chat.kind === "dm" 的会话 */
routines: RoutineStore | null;
// CloudSession
runRoutine(r: { routineId: string; title: string; instruction: string; tz: string; firedAt: number; agentId: string }): Promise<"ok" | "archived" | "no_agent">;
logRoutineNote(n: { routineId: string; title: string; reason: "missed" | "skipped_quota"; plannedAt: number; tz: string }): void;
```

- [ ] **Step 1: 写失败的测试**

`tests/runtime/sessionService.routine.test.ts`（装配抄 `tests/runtime/sessionService.tz.test.ts` 的 `open()`，多两个可调参数）：

```ts
// runRoutine / logRoutineNote（#1283，spec §4.2 / §5）：开场白的形状、起 turn、ownerSpoke 为真（call_friend 亮）、圈数上限只对 routine 轮。
import { describe, expect, it } from "vitest";
// …（import 同 sessionService.tz.test.ts，另加：）
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";
import { ROUTINE_MAX_ROUNDS, SCHEDULE_TASK_TOOL_NAME } from "../../src/shared/routines.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { RoutineNoteEvent, TurnEndedEvent, UserMessageEvent } from "../../src/session/events.js";

const FIRED = Date.UTC(2026, 9, 5, 1, 0);
const ROUTINE = { routineId: "r1", title: "早报", instruction: "看一眼报表", tz: "Asia/Shanghai", firedAt: FIRED, agentId: HELPER.agentId };

/** 每圈都调 bash 的模型（永不收口），记下每圈看到的工具表 */
function busyAdapter(seenTools: string[][]): ModelAdapter {
  let n = 0;
  return {
    model: "fake-model",
    async chat(_messages, tools): Promise<ModelReply> {
      seenTools.push((tools ?? []).map((t) => t.name));
      n++;
      return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: `echo ${n}` } }] };
    },
  };
}

function open(o: { adapter?: ModelAdapter; routines?: ReturnType<typeof createInMemoryRoutineStore> | null } = {}) {
  // …同 tz 测试的 open()，但：
  //   adapterFor: () => o.adapter ?? 默认回「好的」的 adapter
  //   routines: o.routines === undefined ? createInMemoryRoutineStore() : o.routines
  //   approveAll: true, chat: { kind: "dm" }
}

describe("runRoutine", () => {
  it("落一条 greeting:'routine' 的开场白（fromUid 主人、mentions 那只、正文带时间与任务）并起 turn；回 ok", async () => {
    const { session, store } = open();
    expect(await session.runRoutine(ROUTINE)).toBe("ok");
    await session.settled();
    const log = store.load(SID);
    const opening = log.find((e): e is UserMessageEvent => e.type === "user_message")!;
    expect(opening).toMatchObject({ fromUid: OWNER, mentions: [HELPER.agentId], greeting: "routine", routine: { id: "r1", title: "早报" } });
    expect(opening.content).toContain("现在是 2026-10-05 09:00（Asia/Shanghai，周一）");
    expect(opening.content).toContain("看一眼报表");
    expect(log.some((e) => e.type === "assistant_message")).toBe(true);
    store.close();
  });
  it("那只不在名单里：不落任何事件，回 no_agent；归档了回 archived", async () => {
    const { session, store } = open();
    expect(await session.runRoutine({ ...ROUTINE, agentId: "a_nobody" })).toBe("no_agent");
    expect(store.load(SID).filter((e) => e.type === "user_message")).toEqual([]);
    session.archive();
    expect(await session.runRoutine(ROUTINE)).toBe("archived");
    store.close();
  });
  it("routine 轮里 schedule_task 亮着（主人亲口）；圈数到 ROUTINE_MAX_ROUNDS 以 error 收口；主人亲口的普通轮不封顶", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: busyAdapter(seen) });
    await session.runRoutine(ROUTINE);
    await session.settled();
    expect(seen[0]).toContain(SCHEDULE_TASK_TOOL_NAME);
    expect(seen).toHaveLength(ROUTINE_MAX_ROUNDS);
    const ended = store.load(SID).filter((e): e is TurnEndedEvent => e.type === "turn_ended").at(-1)!;
    expect(ended.outcome).toBe("error");
    expect(ended.error).toContain(`跑满 ${ROUTINE_MAX_ROUNDS} 步`);
    store.close();
  });
  it("routines 为 null：工具表里没有那三把刀", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: busyAdapter(seen), routines: null });
    await session.runRoutine(ROUTINE);
    await session.settled();
    expect(seen[0]).not.toContain(SCHEDULE_TASK_TOOL_NAME);
    store.close();
  });
});

describe("logRoutineNote", () => {
  it("落一条 ignorable 的 routine_note，不起 turn", async () => {
    const { session, store } = open();
    session.logRoutineNote({ routineId: "r1", title: "早报", reason: "skipped_quota", plannedAt: FIRED, tz: "Asia/Shanghai" });
    await session.settled();
    const note = store.load(SID).find((e): e is RoutineNoteEvent => e.type === "routine_note")!;
    expect(note).toMatchObject({ routineId: "r1", title: "早报", reason: "skipped_quota", plannedAt: FIRED, tz: "Asia/Shanghai", ignorable: true });
    expect(store.load(SID).some((e) => e.type === "assistant_message")).toBe(false);
    store.close();
  });
});
```

第三条用例「不封顶」那半句用 `say()`（主人亲口、`busyAdapter`）跑 `ROUTINE_MAX_ROUNDS + 5` 圈再让 adapter 收口即可；若嫌慢，断言 `seen.length > ROUTINE_MAX_ROUNDS` 后 `session.stop()`。

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/runtime/sessionService.routine.test.ts`
Expected: FAIL（tsc：`routines` / `runRoutine` 不存在）

- [ ] **Step 3: `CloudSessionOpts` 与 `CloudSession` 接口**

`CloudSessionOpts` 的 `diskUsage` 之后加（import `RoutineStore` 类型自 `./routineStore.js`）：

```ts
  /** 定时任务（#1283，spec §7）。**必需**（同 agentWriter / isMember 的纪律）：忘接线该编译不过。
      null = 不挂那三把刀（团队会话 / 外联 / 0057 没跑）。刀只在 approveAll 且 chat.kind === "dm" 的会话里挂 */
  routines: RoutineStore | null;
```

`CloudSession` 接口里 `reportOutreach` 之后加：

```ts
  /** 定时任务到点（#1283，spec §4.2）：替主人落一条 greeting:"routine" 的开场白并入队——与 greetNewAgent /
      reportOutreach 同一条路。名单现读：那只已删 / 已移出回 no_agent，一个事件都不落 */
  runRoutine(r: { routineId: string; title: string; instruction: string; tz: string; firedAt: number; agentId: string }): Promise<"ok" | "archived" | "no_agent">;
  /** 定时任务没跑成的注记（错过 / 额度不够，spec §4.3）：ignorable，不起 turn */
  logRoutineNote(n: { routineId: string; title: string; reason: "missed" | "skipped_quota"; plannedAt: number; tz: string }): void;
```

- [ ] **Step 4: 旗、刀、圈数上限**

在 `let rerunTurn = false;`（`:880` 一带）旁加：

```ts
  /** 这一轮是定时任务起的（#1283）：圈数上限只对它（没人在场按停止键）。按 job 覆盖的开场白算，同 reportTurn */
  let routineTurn = false;
```

找到 `runJob` 里每个 job 开跑前复位 `reportTurn = false;` 的那一处，紧跟着加 `routineTurn = false;`；找到 `applyTraits(covered, depth)` 的调用处，紧跟着加：

```ts
      routineTurn = routineTurn || covered.some((u) => u.greeting === "routine");
```

（`covered` 是那一处已有的 `UserMessageEvent[]`；如果变量名不同，以那一处为准。）

工具：在 `const callFriendTool = …` 之后加：

```ts
    // 定时任务三把刀（#1283）：只在主场私聊里挂；亮不亮按「主人亲口 && 不受监督」现算（routine 轮算主人亲口，Task 8）
    const routineTools =
      opts.routines === null || !opts.approveAll || chatKind !== "dm"
        ? []
        : createRoutineTools({
            workspaceId: opts.workspaceId, agentId: spec.agentId, ownerUid: opts.ownerUid, store: opts.routines,
            now: () => opts.now?.() ?? Date.now(),
            available: () => ownerSpoke && !supervisedTurn(),
          });
```

工具表 `list` 里 `...(spec.agentId === ADMIN_AGENT_ID ? [createAgentTool] : []),` 之后加 `...routineTools,`。

`new LoopEngine({ … })` 的选项里加：

```ts
      // 定时任务那一轮的圈数硬上限（#1283，spec §5.4）：没人在场按停止键。普通轮不封顶（ADR-0006）
      maxRounds: () => (routineTurn ? ROUTINE_MAX_ROUNDS : undefined),
```

（import `createRoutineTools` 自 `./routineTools.js`，`ROUTINE_MAX_ROUNDS` / `routineOpeningText` 自 `../../../src/shared/routines.js`。`chatKind` 是 `:752` 已有的常量。）

- [ ] **Step 5: 两个方法**

`greetNewAgent` 之后（`logOutreach` 之前）加：

```ts
    async runRoutine(r) {
      if (archived || isOutreach) return "archived";
      // 名单现读（同 reportOutreach）：任务建的时候那只还在，到点可能已删
      const roster = await rosterNow({ fresh: true });
      if (archived) return "archived";
      if (roster.some((a) => a.degraded) || !roster.some((a) => a.agentId === r.agentId)) return "no_agent";
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        content: routineOpeningText({ title: r.title, instruction: r.instruction, firedAt: r.firedAt, tz: r.tz }),
        fromUid: opts.ownerUid,
        mentions: [r.agentId],
        greeting: "routine",
        routine: { id: r.routineId, title: r.title },
        tz: r.tz,
      }) as UserMessageEvent;
      notify(opening);
      if (coordinator.enqueue({ agentId: r.agentId, fromUid: opts.ownerUid, opening }) === "start_turn") startDrain();
      return "ok";
    },

    logRoutineNote(n) {
      if (archived) return;
      notify(store.append({ sessionId, ts: Date.now(), type: "routine_note", ...n, ignorable: true }));
    },
```

- [ ] **Step 6: 既有测试补字段**

- `tests/runtime/frameHandler.test.ts` 的 `fakeSession` 里 `reportOutreach: () => {},` 之后加 `runRoutine: async () => "ok" as const, logRoutineNote: () => {},`。
- `tests/runtime/sessionService.test.ts` 的 `baseOpts` 与第 ① 条用例的字面 opts、`tests/runtime/sessionService.pair.test.ts` 的 `open()`、`tests/runtime/sessionService.tz.test.ts` 的 opts：各加 `routines: null,`。
- 其他 `createCloudSession({…})` 的调用点用 `grep -rn "createCloudSession(" tests services | grep -v "\.ts:.*import"` 找齐，都补 `routines: null`。

- [ ] **Step 7: 跑 runtime 全部测试 + tsc**

Run: `npx vitest run tests/runtime && npx tsc --noEmit`
Expected: PASS / 零错误

- [ ] **Step 8: 提交**

```bash
git add services/runtime/src/sessionService.ts tests/runtime
git commit -m "feat(runtime): 定时任务到点起 turn（runRoutine）+ 注记 + 挂刀 + routine 轮圈数上限（#1283）

与 greetNewAgent / reportOutreach 同一条路，不造第二种起 turn 机制。刀只在主场私聊里挂、
只在主人亲口的轮亮；maxRounds 只对 routine 轮——有人在场的轮不封顶（ADR-0006）。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: 调度器 `routineScheduler.ts`（全依赖注入）

**Files:**
- Create: `services/runtime/src/routineScheduler.ts`
- Test: `tests/runtime/routineScheduler.test.ts`

**Interfaces:**
- Consumes：Task 1 的常量与 `nextRunAt`；Task 9 的 `RoutineStore`；`RELAY_BUDGET_FRACTION_OF_REMAINING`（`src/shared/agentRelay.ts`）。
- Produces：

```ts
export type RoutineRunResult = "started" | "no_chat" | "archived" | "no_agent";
export interface RoutineSchedulerDeps {
  store: RoutineStore;
  /** 主人剩余周额度；null = 问不出来（照跑，同 ADR-0238 的降级） */
  quota(ownerUid: string): Promise<{ remainingMicro: number; limitMicro: number } | null>;
  run(r: RoutineRow, firedAt: number): Promise<RoutineRunResult>;
  note(r: RoutineRow, reason: "missed" | "skipped_quota", plannedAt: number): Promise<void>;
  now(): number;
  log(m: string): void;
}
export const ROUTINE_TICK_MS = 30_000, ROUTINE_TICK_LIMIT = 50;
export function createRoutineScheduler(deps: RoutineSchedulerDeps): { tick(): Promise<void>; start(periodMs?: number): () => void };
```

- [ ] **Step 1: 写失败的测试**

```ts
// 调度器（#1283，spec §3 / §5.3）：认领一次、漏跑两档宽限、额度门、清理。store 用内存实现，时钟手拨。
import { describe, expect, it } from "vitest";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "../../services/runtime/src/routineScheduler.js";
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";
import { ROUTINE_KEEP_DONE_MS, ROUTINE_MIN_GAP_MS, ROUTINE_ONCE_GRACE_MS, ROUTINE_RECURRING_GRACE_MS } from "../../src/shared/routines.js";

const SH = "Asia/Shanghai";
const T0 = Date.UTC(2026, 9, 5, 1, 0); // 上海 09:00
const base = { workspaceId: "w", agentId: "ops", ownerUid: "owner", title: "早报", instruction: "看报表", tz: SH, createdBy: "agent" as const };

function rig(over: Partial<RoutineSchedulerDeps> = {}) {
  const store = createInMemoryRoutineStore();
  const runs: { id: string; firedAt: number }[] = [];
  const notes: { id: string; reason: string }[] = [];
  const logs: string[] = [];
  let now = T0;
  const deps: RoutineSchedulerDeps = {
    store, quota: async () => null,
    run: async (r, firedAt) => (runs.push({ id: r.id, firedAt }), "started"),
    note: async (r, reason) => void notes.push({ id: r.id, reason }),
    now: () => now, log: (m) => void logs.push(m), ...over,
  };
  return { store, runs, notes, logs, sched: createRoutineScheduler(deps), setNow: (t: number) => { now = t; } };
}

describe("routineScheduler.tick", () => {
  it("到点的跑一次：daily 推到明天同一刻、last_status=done；没到点的不动", async () => {
    const { store, runs, sched } = rig();
    const a = await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await store.insert({ ...base, title: "晚", schedule: { kind: "daily", time: "21:00" }, nextRunAt: T0 + 12 * 3_600_000 });
    await sched.tick();
    expect(runs).toEqual([{ id: a.id, firedAt: T0 }]);
    expect(await store.get(a.id)).toMatchObject({ nextRunAt: T0 + 86_400_000, lastRunAt: T0, lastStatus: "done", enabled: true });
    await sched.tick();
    expect(runs).toHaveLength(1);
  });
  it("once 跑完：next_run_at 清空、停用、done", async () => {
    const { store, sched } = rig();
    const r = await store.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: T0 });
    await sched.tick();
    expect(await store.get(r.id)).toMatchObject({ nextRunAt: null, enabled: false, lastStatus: "done" });
  });
  it("两个调度器同一刻 tick（两个实例）：只跑一次", async () => {
    const a = rig();
    const r = await a.store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    const b = createRoutineScheduler({ store: a.store, quota: async () => null, run: async () => (a.runs.push({ id: r.id, firedAt: -1 }), "started"), note: async () => {}, now: () => T0, log: () => {} });
    await Promise.all([a.sched.tick(), b.tick()]);
    expect(a.runs).toHaveLength(1);
  });
  it("漏跑：once 晚 ≤ 2h 照跑；晚 > 2h 标 missed + 落注记 + 停用；daily 晚 > 10min 直接跳到下一跳、不跑不注记", async () => {
    const { store, runs, notes, sched, setNow } = rig();
    const okOnce = await store.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: T0 });
    const lateOnce = await store.insert({ ...base, title: "l", schedule: { kind: "once", at: "2026-10-05T06:00" }, nextRunAt: T0 - 3 * 3_600_000 });
    const lateDaily = await store.insert({ ...base, title: "d", schedule: { kind: "daily", time: "08:00" }, nextRunAt: T0 - 3_600_000 });
    setNow(T0 + ROUTINE_ONCE_GRACE_MS);
    await sched.tick();
    expect(runs.map((x) => x.id)).toEqual([okOnce.id]);
    expect(notes).toEqual([{ id: lateOnce.id, reason: "missed" }]);
    expect(await store.get(lateOnce.id)).toMatchObject({ lastStatus: "missed", enabled: false, nextRunAt: null });
    expect(await store.get(lateDaily.id)).toMatchObject({ lastStatus: null, enabled: true, nextRunAt: T0 - 3_600_000 + 86_400_000 });
    expect(ROUTINE_RECURRING_GRACE_MS).toBe(10 * 60_000);
  });
  it("额度门：剩余 < 10% 不跑、skipped_quota、注记；问不出来照跑；下一跳照常算", async () => {
    const low = rig({ quota: async () => ({ remainingMicro: 9, limitMicro: 100 }) });
    const r = await low.store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await low.sched.tick();
    expect(low.runs).toEqual([]);
    expect(low.notes).toEqual([{ id: r.id, reason: "skipped_quota" }]);
    expect(await low.store.get(r.id)).toMatchObject({ lastStatus: "skipped_quota", enabled: true, nextRunAt: T0 + 86_400_000 });
  });
  it("run 回 no_chat / no_agent / archived：failed + 停用", async () => {
    const { store, sched } = rig({ run: async () => "no_chat" });
    const r = await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await sched.tick();
    expect(await store.get(r.id)).toMatchObject({ lastStatus: "failed", enabled: false });
  });
  it("run 抛错：记日志、failed、不炸 tick；同一 tick 里后面的照跑", async () => {
    let k = 0;
    const { store, runs, logs, sched } = rig({ run: async (r) => { if (k++ === 0) throw new Error("boom"); runs.push({ id: r.id, firedAt: 0 }); return "started"; } });
    const a = await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 - 1 });
    await store.insert({ ...base, title: "b", schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await sched.tick();
    expect(logs.join("\n")).toContain("boom");
    expect(await store.get(a.id)).toMatchObject({ lastStatus: "failed" });
    expect(runs).toHaveLength(1);
  });
  it("下一跳至少隔 60 秒：now 在 nextRunAt 之前一点点（时钟抖）也不会算出同一刻", async () => {
    const { store, sched, setNow } = rig();
    const r = await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    setNow(T0 + 1);
    await sched.tick();
    expect((await store.get(r.id))!.nextRunAt).toBeGreaterThanOrEqual(T0 + ROUTINE_MIN_GAP_MS);
  });
  it("清理：停用且 done/missed 且过了 7 天的删掉", async () => {
    const { store, sched, setNow } = rig();
    const r = await store.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: T0 });
    await sched.tick();
    setNow(T0 + ROUTINE_KEEP_DONE_MS + 1);
    await sched.tick();
    expect(await store.get(r.id)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/runtime/routineScheduler.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// 定时任务的调度器（#1283，spec §3 / §5.3）。daemon 里一只 30 秒的 setInterval 调 tick()；判断全在这里、
// 数据源全靠注入（daemon.ts 进不了 vitest）。
// 顺序纪律：**先认领（推进 next_run_at）再起 turn**——起 turn 失败不会让它每 30 秒重试一次烧钱。
import { RELAY_BUDGET_FRACTION_OF_REMAINING } from "../../../src/shared/agentRelay.js";
import {
  nextRunAt, ROUTINE_KEEP_DONE_MS, ROUTINE_MIN_GAP_MS, ROUTINE_ONCE_GRACE_MS, ROUTINE_RECURRING_GRACE_MS, type RoutineRow,
} from "../../../src/shared/routines.js";
import type { RoutineStore } from "./routineStore.js";

export type RoutineRunResult = "started" | "no_chat" | "archived" | "no_agent";

export interface RoutineSchedulerDeps {
  store: RoutineStore;
  /** 主人剩余周额度；null = 问不出来——照跑（同 ADR-0238 的降级：问不出钱不等于没钱，且这是主人自己建的任务） */
  quota(ownerUid: string): Promise<{ remainingMicro: number; limitMicro: number } | null>;
  /** 找私聊 → 开房 → session.runRoutine（daemon 接 routineRun.ts 的 runRoutineInRoom） */
  run(r: RoutineRow, firedAt: number): Promise<RoutineRunResult>;
  /** 私聊里落一条 routine_note；开不出房就算了（调用方自己吞错） */
  note(r: RoutineRow, reason: "missed" | "skipped_quota", plannedAt: number): Promise<void>;
  now(): number;
  log(m: string): void;
}

export const ROUTINE_TICK_MS = 30_000;
/** 一次 tick 最多处理这么多条，顺序处理不并发——50 条 turn 同时起步就是 50 个容器抢 CPU（同启动错峰的理由） */
export const ROUTINE_TICK_LIMIT = 50;

export function createRoutineScheduler(deps: RoutineSchedulerDeps): { tick(): Promise<void>; start(periodMs?: number): () => void } {
  let ticking = false;

  async function handle(r: RoutineRow, now: number): Promise<void> {
    const planned = r.nextRunAt;
    if (planned === null) return;
    const once = r.schedule.kind === "once";
    // 下一跳：严格晚于 max(now, 原定 + 60s)——时钟抖到原定之前一点点也不会算出同一刻
    const next = nextRunAt(r.schedule, r.tz, Math.max(now, planned + ROUTINE_MIN_GAP_MS));
    if (!(await deps.store.claim(r.id, planned, { nextRunAt: next, lastRunAt: now }))) return; // 另一个实例先到
    const late = now - planned;
    if (late > (once ? ROUTINE_ONCE_GRACE_MS : ROUTINE_RECURRING_GRACE_MS)) {
      // 漏跑（spec §3.4）：一次性的标 missed + 注记 + 停用；重复的直接等下一跳，不解释（迟到三小时的早报不如不来）
      if (once) {
        await deps.store.setStatus(r.id, "missed", false);
        await safeNote(r, "missed", planned);
      }
      return;
    }
    const q = await deps.quota(r.ownerUid);
    if (q !== null && q.remainingMicro < q.limitMicro * RELAY_BUDGET_FRACTION_OF_REMAINING) {
      await deps.store.setStatus(r.id, "skipped_quota", once ? false : undefined);
      await safeNote(r, "skipped_quota", planned);
      return;
    }
    let result: RoutineRunResult;
    try {
      result = await deps.run(r, now);
    } catch (err) {
      deps.log(`定时任务起 turn 失败（id=${r.id}「${r.title}」）：${err instanceof Error ? err.message : String(err)}`);
      await deps.store.setStatus(r.id, "failed", once ? false : undefined);
      return;
    }
    if (result === "started") {
      await deps.store.setStatus(r.id, "done", once ? false : undefined);
    } else {
      // 私聊没了 / 那只没了 / 归档了：这条任务没有归宿，停掉（spec §3.5）
      deps.log(`定时任务没地方跑（id=${r.id}「${r.title}」）：${result}`);
      await deps.store.setStatus(r.id, "failed", false);
    }
  }

  async function safeNote(r: RoutineRow, reason: "missed" | "skipped_quota", planned: number): Promise<void> {
    try {
      await deps.note(r, reason, planned);
    } catch (err) {
      deps.log(`定时任务注记没落成（id=${r.id}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return; // 上一轮还没跑完（50 条 turn 起得慢）：这一拍跳过，下一拍再来
    ticking = true;
    try {
      const now = deps.now();
      let due: RoutineRow[];
      try {
        due = await deps.store.due(now, ROUTINE_TICK_LIMIT);
      } catch (err) {
        // 0057 没跑时这里每 30 秒报一次——只记日志，不炸进程
        deps.log(`到点任务读不出来：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      for (const r of due) await handle(r, now);
      try {
        const n = await deps.store.purge(now - ROUTINE_KEEP_DONE_MS);
        if (n > 0) deps.log(`清掉 ${n} 条跑完超过 7 天的一次性定时任务`);
      } catch (err) {
        deps.log(`定时任务清理失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start(periodMs = ROUTINE_TICK_MS) {
      // .catch 不能省：定时器回调里的 reject 会变成 unhandledRejection 带走整个进程（同 sweepIdle 那只）
      const h = setInterval(() => void tick().catch((err: unknown) => deps.log(`定时任务 tick 失败：${String(err)}`)), periodMs);
      return () => clearInterval(h);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/runtime/routineScheduler.test.ts`
Expected: PASS（「两个实例」那条靠内存 store 的 `claim` 同步判等；真库靠 `where next_run_at = …`）

- [ ] **Step 5: 提交**

```bash
git add services/runtime/src/routineScheduler.ts tests/runtime/routineScheduler.test.ts
git commit -m "feat(runtime): 定时任务调度器——30 秒 tick、原子认领、漏跑两档宽限、额度门、7 天清理（#1283）

先认领再起 turn：起不成不会每 30 秒重试烧钱。问不出额度照跑（同 ADR-0238 的降级）。
daemon.ts 进不了 vitest，判断全在这里、数据源全靠注入。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: `routineRun.ts` + daemon 接线

**Files:**
- Create: `services/runtime/src/routineRun.ts`
- Modify: `services/runtime/src/daemon.ts`：`assembleSessionRoom` 里 `createCloudSession({…})` 的 opts（`:1060-1075` 一带，加 `routines`）；启动末尾（`setInterval(… 5 * 60 * 1000)` 之后，`:1576` 一带，起调度器）
- Test: `tests/runtime/routineRun.test.ts`、`tests/runtime/daemonRoutineWiring.test.ts`

**Interfaces:**
- Consumes：Task 10 的 `runRoutine` / `logRoutineNote`；Task 11 的 `RoutineRunResult`；daemon 既有的 `findDmSession` / `openOriginRoom` / `openExistingRoom` / `discardRoom` / `activeSessions` / `hostedProbe.me`。
- Produces：

```ts
export interface RoutineRoom { isArchived(): boolean; runRoutine: CloudSession["runRoutine"]; logRoutineNote: CloudSession["logRoutineNote"]; }
export interface RoutineRunDeps<S extends RoutineRoom> {
  findDm(workspaceId: string, agentId: string): Promise<string | null>;
  room(workspaceId: string, sessionId: string): Promise<S | null>;   // daemon 接 openOriginRoom（开着就用、没开就开、归档回 null）
}
export function runRoutineInRoom<S extends RoutineRoom>(d: RoutineRunDeps<S>, r: RoutineRow, firedAt: number): Promise<RoutineRunResult>;
export function noteRoutineInRoom<S extends RoutineRoom>(d: RoutineRunDeps<S>, r: RoutineRow, reason: "missed" | "skipped_quota", plannedAt: number): Promise<void>;
```

- [ ] **Step 1: 写失败的测试**

`tests/runtime/routineRun.test.ts`：

```ts
// 到点 → 找私聊 → 开房 → runRoutine 那一段编排（#1283）。daemon 只接数据源。
import { describe, expect, it } from "vitest";
import { noteRoutineInRoom, runRoutineInRoom, type RoutineRoom } from "../../services/runtime/src/routineRun.js";
import type { RoutineRow } from "../../src/shared/routines.js";

const R: RoutineRow = {
  id: "r1", workspaceId: "w", agentId: "ops", ownerUid: "owner", title: "早报", instruction: "看报表", schedule: { kind: "daily", time: "09:00" },
  tz: "Asia/Shanghai", enabled: true, nextRunAt: 0, lastRunAt: null, lastStatus: null, createdBy: "agent", createdAt: 0, updatedAt: 0,
};
function room(result: "ok" | "archived" | "no_agent" = "ok") {
  const calls: unknown[] = [];
  const notes: unknown[] = [];
  const s: RoutineRoom = { isArchived: () => false, runRoutine: async (x) => (calls.push(x), result), logRoutineNote: (n) => void notes.push(n) };
  return { s, calls, notes };
}

describe("runRoutineInRoom", () => {
  it("找到私聊、开出房：runRoutine 带齐字段，回 started", async () => {
    const { s, calls } = room();
    const r = await runRoutineInRoom({ findDm: async () => "sid", room: async () => s }, R, 123);
    expect(r).toBe("started");
    expect(calls[0]).toEqual({ routineId: "r1", title: "早报", instruction: "看报表", tz: "Asia/Shanghai", firedAt: 123, agentId: "ops" });
  });
  it("没有私聊 → no_chat；房开不出来（归档）→ archived；那只没了 → no_agent", async () => {
    expect(await runRoutineInRoom({ findDm: async () => null, room: async () => room().s }, R, 1)).toBe("no_chat");
    expect(await runRoutineInRoom({ findDm: async () => "sid", room: async () => null }, R, 1)).toBe("archived");
    expect(await runRoutineInRoom({ findDm: async () => "sid", room: async () => room("no_agent").s }, R, 1)).toBe("no_agent");
  });
  it("noteRoutineInRoom：有房就落注记；没房静默", async () => {
    const { s, notes } = room();
    await noteRoutineInRoom({ findDm: async () => "sid", room: async () => s }, R, "missed", 99);
    expect(notes[0]).toEqual({ routineId: "r1", title: "早报", reason: "missed", plannedAt: 99, tz: "Asia/Shanghai" });
    await expect(noteRoutineInRoom({ findDm: async () => null, room: async () => s }, R, "missed", 99)).resolves.toBeUndefined();
  });
});
```

`tests/runtime/daemonRoutineWiring.test.ts`（照 `daemonNewAgentWiring.test.ts`，判据落在源码上）：

```ts
// daemon.ts 进不了 vitest；定时任务在它身上的接线漏了是**安静的**失败（永远不响），所以判据落在源码上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：定时任务的接线（#1283）", () => {
  it("每条会话房都接了 routines（Supabase store），团队会话 / 外联传 null 由 sessionService 自己按 approveAll + chatKind 判", () => {
    expect(src).toMatch(/const routineStore = createSupabaseRoutineStore\(supabase\)/);
    expect(src).toMatch(/routines: routineStore,/);
  });
  it("调度器在启动末尾起、quota 走 hostedProbe、run / note 走 routineRun 那两个函数", () => {
    expect(src).toMatch(/createRoutineScheduler\(\{[\s\S]*store: routineStore,[\s\S]*hostedProbe\.me\(/);
    expect(src).toMatch(/run: \(r, firedAt\) => runRoutineInRoom\(routineRooms, r, firedAt\)/);
    expect(src).toMatch(/note: \(r, reason, plannedAt\) => noteRoutineInRoom\(routineRooms, r, reason, plannedAt\)/);
    expect(src).toMatch(/routineScheduler\.start\(\)/);
  });
  it("找私聊走 findDmSession、开房走 openOriginRoom（开着就用、归档回 null）", () => {
    expect(src).toMatch(/const routineRooms = \{[\s\S]*findDm: \(w, a\) => findDmSession\(w, \[a\]\),[\s\S]*openOriginRoom<CloudSession>\(/);
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/runtime/routineRun.test.ts tests/runtime/daemonRoutineWiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `services/runtime/src/routineRun.ts`**

```ts
// 到点那一段编排（#1283）：找这只的私聊 → 取房（开着就用、没开就开）→ runRoutine。daemon 只接数据源。
import type { RoutineRow } from "../../../src/shared/routines.js";
import type { RoutineRunResult } from "./routineScheduler.js";
import type { CloudSession } from "./sessionService.js";

export interface RoutineRoom {
  isArchived(): boolean;
  runRoutine: CloudSession["runRoutine"];
  logRoutineNote: CloudSession["logRoutineNote"];
}

export interface RoutineRunDeps<S extends RoutineRoom> {
  /** 这只现成的那条私聊（daemon 的 findDmSession）。没有 = 任务没有归宿 */
  findDm(workspaceId: string, agentId: string): Promise<string | null>;
  /** 开着就用、没开就按启动补开的同一套步骤开；归档了回 null（daemon 的 openOriginRoom） */
  room(workspaceId: string, sessionId: string): Promise<S | null>;
}

export async function runRoutineInRoom<S extends RoutineRoom>(d: RoutineRunDeps<S>, r: RoutineRow, firedAt: number): Promise<RoutineRunResult> {
  const sessionId = await d.findDm(r.workspaceId, r.agentId);
  if (sessionId === null) return "no_chat";
  const room = await d.room(r.workspaceId, sessionId);
  if (room === null) return "archived";
  const res = await room.runRoutine({ routineId: r.id, title: r.title, instruction: r.instruction, tz: r.tz, firedAt, agentId: r.agentId });
  return res === "ok" ? "started" : res;
}

/** 注记：开得出房才落；没有私聊 / 归档了就算了——注记是给人看的，没地方给人看就不必落 */
export async function noteRoutineInRoom<S extends RoutineRoom>(d: RoutineRunDeps<S>, r: RoutineRow, reason: "missed" | "skipped_quota", plannedAt: number): Promise<void> {
  const sessionId = await d.findDm(r.workspaceId, r.agentId);
  if (sessionId === null) return;
  const room = await d.room(r.workspaceId, sessionId);
  if (room === null) return;
  room.logRoutineNote({ routineId: r.id, title: r.title, reason, plannedAt, tz: r.tz });
}
```

- [ ] **Step 4: daemon 接线**

`services/runtime/src/daemon.ts` 顶部 import：

```ts
import { createSupabaseRoutineStore } from "./routineStore.js";
import { createRoutineScheduler } from "./routineScheduler.js";
import { noteRoutineInRoom, runRoutineInRoom } from "./routineRun.js";
```

`const supabase = createClient(…)`（`:160`）之后加：

```ts
  // 定时任务（#1283）：一张表、一只调度器（启动末尾起）。每条会话房都接同一个 store，挂不挂刀由 sessionService
  // 按 approveAll + chatKind 判（团队会话 / 外联 / 私密车道都不挂）
  const routineStore = createSupabaseRoutineStore(supabase);
```

`assembleSessionRoom` 里 `createCloudSession({…})` 的 opts（`diskUsage: …` 那一行附近）加 `routines: routineStore,`。

启动末尾（5 分钟那只 `setInterval(...)` 之后、控制房之前）加：

```ts
  // ── 定时任务调度器（#1283，spec §3）：30 秒一拍、原子认领、先推进 next_run_at 再起 turn ─────────
  const routineRooms = {
    findDm: (w: string, a: string) => findDmSession(w, [a]),
    room: (w: string, id: string) =>
      openOriginRoom<CloudSession>(
        {
          active: (sid) => activeSessions.get(sid)?.session ?? null,
          row: async (sid) => {
            const { data, error } = await supabase.from("workspace_sessions").select("workspace_id,publisher_uid,archived").eq("id", sid).maybeSingle();
            if (error) throw new Error(error.message);
            if (!data) return null;
            const r = data as { workspace_id: string; publisher_uid: string; archived: boolean };
            return { workspace_id: r.workspace_id, archived: r.archived, publisherUid: r.publisher_uid };
          },
          open: (ww, sid, publisherUid) => openExistingRoom(ww, sid, publisherUid),
          discard: discardRoom,
        },
        w, id,
      ),
  };
  const routineScheduler = createRoutineScheduler({
    store: routineStore,
    // 额度门（spec §5.3）：与接力预算同一只探针；三种「没有数」一律 null = 照跑
    quota: async (ownerUid) => {
      const me = await hostedProbe.me(ownerUid);
      if (me === "unreachable" || me === null || me.windows === null) return null;
      return { remainingMicro: me.windows.week.limitMicro - me.windows.week.usedMicro, limitMicro: me.windows.week.limitMicro };
    },
    run: (r, firedAt) => runRoutineInRoom(routineRooms, r, firedAt),
    note: (r, reason, plannedAt) => noteRoutineInRoom(routineRooms, r, reason, plannedAt),
    now: Date.now,
    log: (m) => console.warn(`[otto-runtime] ${m}`),
  });
  routineScheduler.start();
```

`findDmSession` / `openExistingRoom` / `discardRoom` / `activeSessions` / `hostedProbe` 都是 `main()` 作用域里已有的名字（`:369` / `:574` / `:583` / `:464` / `:198`）；这段要放在它们的定义之后（启动末尾一定满足）。`openOriginRoom` 的 `row` 回调与外联那处（`:672-684`）逐字相同——**抽成一个 `sessionRowOf(sid)` 函数两处共用**，别复制两份。

- [ ] **Step 5: 跑测试 + tsc**

Run: `npx vitest run tests/runtime/routineRun.test.ts tests/runtime/daemonRoutineWiring.test.ts tests/runtime/daemonNewAgentWiring.test.ts && npx tsc --noEmit`
Expected: PASS / 零错误

- [ ] **Step 6: 提交**

```bash
git add services/runtime/src/routineRun.ts services/runtime/src/daemon.ts tests/runtime/routineRun.test.ts tests/runtime/daemonRoutineWiring.test.ts
git commit -m "feat(runtime): daemon 接上定时任务——每间房带 store、启动末尾起调度器、到点找私聊开房起 turn（#1283）

开房走 openOriginRoom（与外联汇报同一套：开着就用、归档回 null）；额度门与接力预算同一只探针。
daemon 进不了 vitest，接线判据落在源码上（同 daemonNewAgentWiring）。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: 手机端 —— 入口行、列表页、编辑弹窗、时区上报

**Files:**
- Create: `src/shared/supabaseRoutinesApi.ts`
- Create: `mobile/src/agent/routinesStore.ts`、`mobile/src/agent/RoutinesScreen.tsx`、`mobile/src/agent/RoutineEditDialog.tsx`、`mobile/src/agent/TimeWheel.tsx`
- Modify: `mobile/src/agent/AgentRows.tsx`（加一行）、`mobile/src/nav/types.ts:34`（加 `Routines`）、`mobile/src/nav/RootNavigator.tsx:92`（注册）、`mobile/src/me/profileStore.ts`（`syncDeviceTimezone`）、`mobile/src/tabs/ChatsScreen.tsx:92-98`（前台时调）
- Test: `tests/shared/supabaseRoutinesApi.test.ts`（只测纯函数 `routineInsertColumns` / `routinePatchColumns`）；UI 走 `mobile` 的 `tsc --noEmit` + 模拟器冒烟

**Interfaces:**
- Consumes：Task 1 全部、Task 9 的 `routineRowOf`（**搬到 `src/shared/supabaseRoutinesApi.ts`**，runtime 的 `routineStore.ts` 改成从那里 import——行映射两端一份）。
- Produces：

```ts
// src/shared/supabaseRoutinesApi.ts
export function routineRowOf(raw: Record<string, unknown>): RoutineRow;
export function routineInsertColumns(i: { workspaceId; agentId; ownerUid; title; instruction; schedule; tz; nextRunAt: number | null }): Record<string, unknown>; // created_by 固定 'user'
export function routinePatchColumns(p: Partial<Pick<RoutineRow, "title" | "instruction" | "schedule" | "tz" | "enabled" | "nextRunAt">>): Record<string, unknown>;
export async function listRoutines(client: SupabaseClient, workspaceId: string, agentId: string): Promise<RoutineRow[]>;
export async function insertRoutine(client, i): Promise<RoutineRow>;
export async function updateRoutine(client, id, p): Promise<RoutineRow>;
export async function deleteRoutine(client, id): Promise<void>;
export async function saveTimezone(client, uid: string, tz: string): Promise<void>;   // profiles.timezone
// mobile/src/agent/routinesStore.ts
export function useRoutines(workspaceId: string, agentId: string): { rows: RoutineRow[]; loaded: boolean; error: string | null; refresh(): Promise<void> };
// 路由
Routines: { agentId: string };
```

- [ ] **Step 1: 写失败的测试（列映射）**

```ts
// 手机 / 桌面直接写 agent_routines 的列映射（#1283）：字段名 ↔ 列名、毫秒 ↔ ISO、exactOptionalPropertyTypes 下不塞 undefined。
import { describe, expect, it } from "vitest";
import { routineInsertColumns, routinePatchColumns, routineRowOf } from "../../src/shared/supabaseRoutinesApi.js";

describe("supabaseRoutinesApi 的列映射", () => {
  it("insert：created_by 固定 user、next_run_at 转 ISO", () => {
    const c = routineInsertColumns({ workspaceId: "w", agentId: "ops", ownerUid: "me", title: "早报", instruction: "看", schedule: { kind: "daily", time: "09:00" }, tz: "Asia/Shanghai", nextRunAt: Date.UTC(2026, 9, 5, 1) });
    expect(c).toEqual({ workspace_id: "w", agent_id: "ops", owner_uid: "me", title: "早报", instruction: "看", schedule: { kind: "daily", time: "09:00" }, tz: "Asia/Shanghai", next_run_at: "2026-10-05T01:00:00.000Z", created_by: "user" });
  });
  it("patch：只带给了的格；nextRunAt null → next_run_at null", () => {
    expect(routinePatchColumns({ enabled: false, nextRunAt: null })).toMatchObject({ enabled: false, next_run_at: null });
    expect(Object.keys(routinePatchColumns({ title: "x" }))).toEqual(["title", "updated_at"]);
  });
  it("routineRowOf 从 runtime 搬过来之后两端一份", () => {
    expect(routineRowOf({ id: "r", workspace_id: "w", agent_id: "a", owner_uid: "o", title: "t", instruction: "i", schedule: { kind: "daily", time: "09:00" }, tz: "Asia/Shanghai", enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_by: "user", created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z" }).createdBy).toBe("user");
  });
});
```

- [ ] **Step 2: 跑一遍确认红**

Run: `npx vitest run tests/shared/supabaseRoutinesApi.test.ts`
Expected: FAIL

- [ ] **Step 3: `src/shared/supabaseRoutinesApi.ts`**

```ts
// agent_routines 的客户端读写（#1283）：手机（将来桌面）用登录者自己的 JWT 直接写表，RLS 兜底。
// 行映射 routineRowOf 从 runtime 的 routineStore 搬来放这里——runtime 与客户端一份。
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseRoutineSchedule, type RoutineRow, type RoutineSchedule, type RoutineStatus } from "./routines.js";

const ms = (v: unknown): number | null => (typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : null);
const iso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());
export const ROUTINE_COLUMNS = "id,workspace_id,agent_id,owner_uid,title,instruction,schedule,tz,enabled,next_run_at,last_run_at,last_status,created_by,created_at,updated_at";

export function routineRowOf(raw: Record<string, unknown>): RoutineRow {
  return {
    id: String(raw.id), workspaceId: String(raw.workspace_id), agentId: String(raw.agent_id), ownerUid: String(raw.owner_uid),
    title: String(raw.title ?? ""), instruction: String(raw.instruction ?? ""), schedule: parseRoutineSchedule(raw.schedule), tz: String(raw.tz),
    enabled: raw.enabled === true, nextRunAt: ms(raw.next_run_at), lastRunAt: ms(raw.last_run_at),
    lastStatus: (raw.last_status as RoutineStatus | null) ?? null, createdBy: raw.created_by === "user" ? "user" : "agent",
    createdAt: ms(raw.created_at) ?? 0, updatedAt: ms(raw.updated_at) ?? 0,
  };
}

export function routineInsertColumns(i: { workspaceId: string; agentId: string; ownerUid: string; title: string; instruction: string; schedule: RoutineSchedule; tz: string; nextRunAt: number | null }): Record<string, unknown> {
  return { workspace_id: i.workspaceId, agent_id: i.agentId, owner_uid: i.ownerUid, title: i.title, instruction: i.instruction, schedule: i.schedule, tz: i.tz, next_run_at: iso(i.nextRunAt), created_by: "user" };
}

export function routinePatchColumns(p: Partial<Pick<RoutineRow, "title" | "instruction" | "schedule" | "tz" | "enabled" | "nextRunAt">>): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (p.title !== undefined) c.title = p.title;
  if (p.instruction !== undefined) c.instruction = p.instruction;
  if (p.schedule !== undefined) c.schedule = p.schedule;
  if (p.tz !== undefined) c.tz = p.tz;
  if (p.enabled !== undefined) c.enabled = p.enabled;
  if (p.nextRunAt !== undefined) c.next_run_at = iso(p.nextRunAt);
  c.updated_at = new Date().toISOString();
  return c;
}

function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export async function listRoutines(client: SupabaseClient, workspaceId: string, agentId: string): Promise<RoutineRow[]> {
  const rows = unwrap(await client.from("agent_routines").select(ROUTINE_COLUMNS).eq("workspace_id", workspaceId).eq("agent_id", agentId).order("created_at", { ascending: true }));
  return ((rows ?? []) as Record<string, unknown>[]).map(routineRowOf);
}
export async function insertRoutine(client: SupabaseClient, i: Parameters<typeof routineInsertColumns>[0]): Promise<RoutineRow> {
  return routineRowOf(unwrap(await client.from("agent_routines").insert(routineInsertColumns(i)).select(ROUTINE_COLUMNS).single()) as Record<string, unknown>);
}
export async function updateRoutine(client: SupabaseClient, id: string, p: Parameters<typeof routinePatchColumns>[0]): Promise<RoutineRow> {
  return routineRowOf(unwrap(await client.from("agent_routines").update(routinePatchColumns(p)).eq("id", id).select(ROUTINE_COLUMNS).single()) as Record<string, unknown>);
}
export async function deleteRoutine(client: SupabaseClient, id: string): Promise<void> {
  unwrap(await client.from("agent_routines").delete().eq("id", id));
}
/** 设备时区写到账号上（spec §6.3）：runtime 建任务时 tz 省略就用它 */
export async function saveTimezone(client: SupabaseClient, uid: string, tz: string): Promise<void> {
  unwrap(await client.from("profiles").update({ timezone: tz }).eq("id", uid));
}
```

然后把 `services/runtime/src/routineStore.ts` 里的 `routineRowOf` 删掉、改为 `import { routineRowOf, ROUTINE_COLUMNS } from "../../../src/shared/supabaseRoutinesApi.js";`（`COLS` 换成 `ROUTINE_COLUMNS`），`tests/runtime/routineStore.test.ts` 里 `routineRowOf` 的 import 也改过去。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/shared/supabaseRoutinesApi.test.ts tests/runtime/routineStore.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: `mobile/src/agent/routinesStore.ts`**

```ts
// 一只智能体的定时任务列表（#1283）：进页现查、改完重拉。不走 realtime（表不进 publication，只有本人读）。
import { useCallback, useEffect, useState } from "react";
import { listRoutines } from "../../../src/shared/supabaseRoutinesApi.js";
import type { RoutineRow } from "../../../src/shared/routines.js";
import { supabase } from "../supabase.js";

export function useRoutines(workspaceId: string, agentId: string): { rows: RoutineRow[]; loaded: boolean; error: string | null; refresh: () => Promise<void> } {
  const [rows, setRows] = useState<RoutineRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setRows(await listRoutines(supabase, workspaceId, agentId));
      setError(null);
    } catch (e) {
      // 0057 没跑：整行不画（AgentRows 按 error !== null 判），不报红
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [workspaceId, agentId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { rows, loaded, error, refresh };
}

/** 入口行右边那句：「3 个 · 下次 10-05 09:00」/「没有」 */
export function routinesRowValue(rows: RoutineRow[], now: number): string {
  const enabled = rows.filter((r) => r.enabled && r.nextRunAt !== null);
  if (rows.length === 0) return "没有";
  const next = enabled.map((r) => r.nextRunAt!).filter((t) => t >= now).sort((a, b) => a - b)[0];
  if (next === undefined) return `${rows.length} 个`;
  const d = new Date(next);
  const pad = (n: number) => String(n).padStart(2, "0");
  // 设备本地时区画：人在哪儿看就按哪儿
  return `${rows.length} 个 · 下次 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

- [ ] **Step 6: `AgentRows.tsx` 加入口行**

import `useNavigation` 自 `@react-navigation/native`（`NativeStackNavigationProp<RootStackParams>`，照 `AgentScreen.tsx` 里 `navigation` 的取法）、`useRoutines` / `routinesRowValue`、`useNow` 自 `../ui.js`。在 `AgentRows` 函数体里：

```tsx
  const routines = useRoutines(ws.id, agent.agentId);
  const now = useNow(60_000);
  useFocusEffect(useCallback(() => { void routines.refresh(); }, [routines.refresh]));
```

`<Row label="说话的声音" … />` 之后加：

```tsx
        {routines.error === null ? (
          <Row label="定时任务" value={routines.loaded ? routinesRowValue(routines.rows, now) : ""} chevron onPress={() => navigation.navigate("Routines", { agentId: agent.agentId })} />
        ) : null}
```

（`AgentRows` 里已有一个 `useFocusEffect`（`:61`），把 `routines.refresh()` 并进那个回调里，不开第二个。）

- [ ] **Step 7: 路由**

`mobile/src/nav/types.ts` 的 `Agent: …` 之后加：

```ts
  /** 一只智能体的定时任务（#1283）：只有我主场里的有 */
  Routines: { agentId: string };
```

`mobile/src/nav/RootNavigator.tsx` import `RoutinesScreen`，`name="Agent"` 那行之后加：

```tsx
        <Root.Screen name="Routines" component={RoutinesScreen} options={{ title: "定时任务" }} />
```

- [ ] **Step 8: `TimeWheel.tsx`（纯 JS 时 / 分两列）**

```tsx
// 时 / 分两列滚轮（#1283）：纯 JS（ScrollView + snapToInterval），不加原生依赖——原生改动走不了热更新（ADR-0340）。
import { useEffect, useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { type as t, usePalette } from "../theme.js";

const ITEM = 36;
const VISIBLE = 5;

function Column({ count, value, onChange, pad }: { count: number; value: number; onChange: (v: number) => void; pad: boolean }) {
  const { c } = usePalette();
  const ref = useRef<ScrollView>(null);
  useEffect(() => { ref.current?.scrollTo({ y: value * ITEM, animated: false }); }, []); // 只在挂上时定位
  return (
    <ScrollView
      ref={ref}
      style={{ height: ITEM * VISIBLE, width: 72 }}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM}
      decelerationRate="fast"
      contentContainerStyle={{ paddingVertical: ITEM * 2 }}
      onMomentumScrollEnd={(e) => onChange(Math.max(0, Math.min(count - 1, Math.round(e.nativeEvent.contentOffset.y / ITEM))))}
    >
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ height: ITEM, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ ...t.body, fontSize: 20, color: i === value ? c.foreground : c.mutedForeground }}>{pad ? String(i).padStart(2, "0") : i}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

/** value / onChange 都是 "HH:mm" */
export function TimeWheel({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { c } = usePalette();
  const hh = Number(value.slice(0, 2)) || 0;
  const mm = Number(value.slice(3, 5)) || 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center" }}>
      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: ITEM * 2, height: ITEM, borderTopWidth: 0.5, borderBottomWidth: 0.5, borderColor: c.border }} />
      <Column count={24} value={hh} onChange={(h) => onChange(`${pad(h)}:${pad(mm)}`)} pad />
      <Text style={{ ...t.body, fontSize: 20, color: c.foreground, marginHorizontal: 4 }}>:</Text>
      <Column count={60} value={mm} onChange={(m) => onChange(`${pad(hh)}:${pad(m)}`)} pad />
    </View>
  );
}
```

（`theme.js` 的 `type` 导出名与字段以 `mobile/src/theme.ts` 为准；`c.border` / `c.mutedForeground` / `c.foreground` 是既有调色板键。）

- [ ] **Step 9: `RoutineEditDialog.tsx`**

```tsx
// 定时任务的编辑弹窗（#1283，spec §8.3）：居中 Dialog（表单类不用抽屉）。新建与编辑同一张；校验走 shared 的 routineErrors。
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  isIanaTimeZone, nextRunAt, parseRoutineSchedule, routineErrors, ROUTINE_INSTRUCTION_MAX, ROUTINE_TITLE_MAX, scheduleText,
  type RoutineRow, type RoutineSchedule,
} from "../../../src/shared/routines.js";
import { Dialog, DialogBody, DialogFooter, DialogTitle } from "../dialog.js";
import { type as t, usePalette } from "../theme.js";
import { Button, Field, Labeled } from "../ui.js";
import { TimeWheel } from "./TimeWheel.js";

type Kind = RoutineSchedule["kind"];
const KINDS: { k: Kind; label: string }[] = [{ k: "once", label: "一次" }, { k: "daily", label: "每天" }, { k: "weekly", label: "每周" }];
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

/** 今天起 30 天的 YYYY-MM-DD（设备本地） */
function dateOptions(): string[] {
  const out: string[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return out;
}

export interface RoutineDraft { title: string; instruction: string; schedule: RoutineSchedule; tz: string }

export function RoutineEditDialog({ visible, initial, onSave, onDelete, onClose, onExited }: {
  visible: boolean;
  /** null = 新建 */
  initial: RoutineRow | null;
  onSave: (d: RoutineDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [instruction, setInstruction] = useState(initial?.instruction ?? "");
  const [kind, setKind] = useState<Kind>(initial?.schedule.kind ?? "daily");
  const [time, setTime] = useState(initial?.schedule.kind === "once" ? initial.schedule.at.slice(11, 16) : initial && initial.schedule.kind !== "once" ? initial.schedule.time : "09:00");
  const [date, setDate] = useState(initial?.schedule.kind === "once" ? initial.schedule.at.slice(0, 10) : dateOptions()[0]!);
  const [days, setDays] = useState<number[]>(initial?.schedule.kind === "weekly" ? initial.schedule.days : [1, 2, 3, 4, 5]);
  const [tz, setTz] = useState(initial?.tz ?? deviceTz);
  const [tzOpen, setTzOpen] = useState(false);
  const [tzQuery, setTzQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schedule = useMemo((): unknown => (kind === "once" ? { kind, at: `${date}T${time}` } : kind === "daily" ? { kind, time } : { kind, days, time }), [kind, date, time, days]);
  const problem = routineErrors({ title, instruction, schedule, tz });
  const next = problem === null ? nextRunAt(parseRoutineSchedule(schedule), tz, Date.now()) : null;
  const tzList = useMemo(() => {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [deviceTz];
    const q = tzQuery.trim().toLowerCase();
    return (q === "" ? all : all.filter((z) => z.toLowerCase().includes(q))).slice(0, 40);
  }, [tzQuery, deviceTz]);

  const save = async (): Promise<void> => {
    if (problem !== null) { setError(problem); return; }
    if (next === null) { setError("这个时刻已经过了，换一个将来的时间"); return; }
    setBusy(true);
    try {
      await onSave({ title: title.trim(), instruction: instruction.trim(), schedule: parseRoutineSchedule(schedule), tz });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const chip = (label: string, on: boolean, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: on ? c.primary : c.muted }}>
      <Text style={{ ...t.caption, color: on ? c.primaryForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );

  return (
    <Dialog visible={visible} wide {...(onExited ? { onExited } : {})}>
      <DialogTitle>{initial === null ? "新建定时任务" : "定时任务"}</DialogTitle>
      <DialogBody>
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
          <Labeled label="标题" error={null}><Field value={title} onChangeText={setTitle} placeholder="比如：早报" maxLength={ROUTINE_TITLE_MAX} variant="dialog" /></Labeled>
          <Labeled label="到点要做什么" hint="它会照这段话去做" error={null}>
            <Field value={instruction} onChangeText={setInstruction} placeholder="比如：看一眼昨天的销售报表，有异常打电话给我" maxLength={ROUTINE_INSTRUCTION_MAX} variant="dialog" />
          </Labeled>
          <View style={{ flexDirection: "row", gap: 8 }}>{KINDS.map((k) => chip(k.label, kind === k.k, () => setKind(k.k)))}</View>
          {kind === "once" ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {dateOptions().map((d) => chip(d.slice(5), date === d, () => setDate(d)))}
            </ScrollView>
          ) : null}
          {kind === "weekly" ? (
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {WEEK.map((w, i) => chip(w, days.includes(i + 1), () => setDays((ds) => (ds.includes(i + 1) ? ds.filter((x) => x !== i + 1) : [...ds, i + 1].sort((a, b) => a - b)))))}
            </View>
          ) : null}
          <TimeWheel value={time} onChange={setTime} />
          <Pressable onPress={() => setTzOpen((v) => !v)}>
            <Text style={{ ...t.caption, color: c.mutedForeground }}>时区：{tz}{tz !== deviceTz ? "（不是这台设备的）" : ""} · 点一下换</Text>
          </Pressable>
          {tzOpen ? (
            <View style={{ gap: 6 }}>
              <Field value={tzQuery} onChangeText={setTzQuery} placeholder="搜城市 / 地区，比如 Sydney" variant="dialog" />
              <ScrollView style={{ maxHeight: 160 }}>
                {tzList.map((z) => (
                  <Pressable key={z} onPress={() => { if (isIanaTimeZone(z)) setTz(z); setTzOpen(false); }} style={{ paddingVertical: 8 }}>
                    <Text style={{ ...t.body, color: z === tz ? c.primary : c.foreground }}>{z}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
          <Text style={{ ...t.caption, color: error !== null ? c.destructive : c.mutedForeground }}>
            {error ?? (problem !== null ? problem : next !== null ? `${scheduleText(parseRoutineSchedule(schedule), tz)}；下次 ${new Date(next).toLocaleString()}` : "")}
          </Text>
          {initial !== null && onDelete ? <Button label="删除这条任务" variant="destructive" size="dialog" disabled={busy} onPress={() => { setBusy(true); onDelete().then(onClose).catch((e: unknown) => setError(String(e))).finally(() => setBusy(false)); }} /> : null}
        </ScrollView>
      </DialogBody>
      <DialogFooter left={{ label: "取消", onPress: onClose, disabled: busy }} right={{ label: initial === null ? "建好" : "保存", onPress: () => void save(), disabled: busy || problem !== null }} />
    </Dialog>
  );
}
```

（`DialogFooter` 的 `DialogAction` 形状、`Button` 的 `variant` 取值、调色板键 `c.primary` / `c.primaryForeground` / `c.muted` / `c.destructive` 以 `mobile/src/dialog.tsx` / `mobile/src/ui.tsx` / `mobile/src/theme.ts` 为准——名字对不上就换成那里有的，不要新造调色板键。）

- [ ] **Step 10: `RoutinesScreen.tsx`**

```tsx
// 一只智能体的定时任务列表（#1283，spec §8.2）：重复 / 一次性 / 已完成三段；开关直接拨；右上「+」手动新建。
import { useLayoutEffect, useState } from "react";
import { Pressable, Switch, Text } from "react-native";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { nextRunAt, scheduleText, ROUTINES_ENABLED_MAX, type RoutineRow } from "../../../src/shared/routines.js";
import { deleteRoutine, insertRoutine, updateRoutine } from "../../../src/shared/supabaseRoutinesApi.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { Group, Hint, ListPage, Row } from "../ui.js";
import { RoutineEditDialog, type RoutineDraft } from "./RoutineEditDialog.js";
import { useRoutines } from "./routinesStore.js";

const statusText = (r: RoutineRow): string =>
  r.lastStatus === "done" ? "已执行" : r.lastStatus === "missed" ? "错过了" : r.lastStatus === "skipped_quota" ? "额度不够没跑" : r.lastStatus === "failed" ? "没跑成" : "";

export function RoutinesScreen() {
  const { c } = usePalette();
  const route = useRoute<RouteProp<RootStackParams, "Routines">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const home = useHome();
  const ws = home.home;
  const agentId = route.params.agentId;
  const routines = useRoutines(ws?.id ?? "", agentId);
  const [editing, setEditing] = useState<{ row: RoutineRow | null; key: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => setEditing({ row: null, key: Date.now() })} hitSlop={10} accessibilityLabel="新建定时任务">
          <Text style={{ fontSize: 26, color: c.primary, lineHeight: 28 }}>＋</Text>
        </Pressable>
      ),
    });
  }, [navigation, c.primary]);

  if (ws === null || home.selfUid === null) return null;
  const selfUid = home.selfUid;

  const toggle = async (r: RoutineRow, on: boolean): Promise<void> => {
    try {
      if (on && routines.rows.filter((x) => x.enabled && x.id !== r.id).length >= ROUTINES_ENABLED_MAX) throw new Error(`启用中的最多 ${ROUTINES_ENABLED_MAX} 条`);
      const next = on ? nextRunAt(r.schedule, r.tz, Date.now()) : null;
      if (on && next === null) throw new Error("这个时刻已经过了，点进去改个时间");
      await updateRoutine(supabase, r.id, { enabled: on, nextRunAt: next });
      await routines.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const save = async (d: RoutineDraft, row: RoutineRow | null): Promise<void> => {
    const next = nextRunAt(d.schedule, d.tz, Date.now());
    if (row === null) {
      if (routines.rows.filter((x) => x.enabled).length >= ROUTINES_ENABLED_MAX) throw new Error(`启用中的最多 ${ROUTINES_ENABLED_MAX} 条`);
      // 先保证私聊存在（runtime 对私聊幂等）：到点 runtime 按私聊找房，没有私聊这条任务没有归宿
      const made = await cloudClient.create(ws.id, { kind: "dm", agentId });
      if (!made.ok) throw new Error(made.message);
      await insertRoutine(supabase, { workspaceId: ws.id, agentId, ownerUid: selfUid, ...d, nextRunAt: next });
    } else {
      await updateRoutine(supabase, row.id, { ...d, enabled: true, nextRunAt: next });
    }
    await routines.refresh();
  };

  const live = routines.rows.filter((r) => r.enabled || (r.lastStatus !== "done" && r.lastStatus !== "missed"));
  const recurring = live.filter((r) => r.schedule.kind !== "once");
  const once = live.filter((r) => r.schedule.kind === "once");
  const finished = routines.rows.filter((r) => !r.enabled && (r.lastStatus === "done" || r.lastStatus === "missed"));
  const rowOf = (r: RoutineRow, done = false) => (
    <Row
      key={r.id}
      label={r.title}
      detail={`${scheduleText(r.schedule, r.tz)}${done ? ` · ${statusText(r)}` : r.lastStatus !== null && r.lastStatus !== "done" ? ` · 上次${statusText(r)}` : ""}`}
      chevron
      onPress={() => setEditing({ row: r, key: Date.now() })}
      {...(done ? {} : { trailing: <Switch value={r.enabled} onValueChange={(v) => void toggle(r, v)} accessibilityLabel={`${r.title} 开关`} /> })}
    />
  );

  return (
    <ListPage>
      {routines.loaded && routines.rows.length === 0 ? <Hint>跟它说一句「每天早上九点……」就能建，也可以点右上角自己加。</Hint> : null}
      {recurring.length > 0 ? <Group header="重复">{recurring.map((r) => rowOf(r))}</Group> : null}
      {once.length > 0 ? <Group header="一次性">{once.map((r) => rowOf(r))}</Group> : null}
      {finished.length > 0 ? <Group header="已完成" footer="跑完的一次性任务留 7 天">{finished.map((r) => rowOf(r, true))}</Group> : null}
      {error !== null ? <Hint>{error}</Hint> : null}
      {editing !== null ? (
        <RoutineEditDialog
          key={editing.key}
          visible
          initial={editing.row}
          onSave={(d) => save(d, editing.row)}
          {...(editing.row !== null ? { onDelete: async () => { await deleteRoutine(supabase, editing.row!.id); await routines.refresh(); } } : {})}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </ListPage>
  );
}
```

（`Row` 的 `trailing` prop 名以 `mobile/src/ui.tsx:317-360` 为准——`ChatInfoScreen.tsx:105` 已经这样用；`Group` 的 `header` / `footer` 同 `:278`。`cloudClient.create` 的返回形状以 `startDm`（`chatStore.ts:267`）里的用法为准。）

- [ ] **Step 11: 设备时区上报**

`mobile/src/me/profileStore.ts` 末尾加：

```ts
let lastSyncedTz: string | null = null;
/** 设备时区写到账号上（#1283，spec §6.3）：前台时调，变了才写。写失败静默——下一次前台再试 */
export async function syncDeviceTimezone(): Promise<void> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tz || tz === lastSyncedTz) return;
  const uid = await uidNow();
  if (uid === null) return;
  try {
    await saveTimezone(supabase, uid, tz);
    lastSyncedTz = tz;
  } catch { /* 0057 没跑 / 网络抖：下次再写 */ }
}
```

（import `saveTimezone` 自 `../../../src/shared/supabaseRoutinesApi.js`。）`mobile/src/tabs/ChatsScreen.tsx:92-98` 的 `refreshAll()` 两处（进页 + `active`）旁各加一句 `void syncDeviceTimezone();`。

- [ ] **Step 12: 两端 tsc + 模拟器冒烟**

Run: `npx tsc --noEmit && (cd mobile && npx tsc --noEmit)`
Expected: 零错误。

模拟器冒烟（记录到 issue #1283 的评论里，不阻塞合并）：智能体资料页 → 「定时任务」→ 「+」→ 建一条 2 分钟后的一次性任务 → 回私聊等 → 到点看到灰条「⏰ 定时任务「…」」+ 它的回话 +（切后台时）一条推送；列表里那条进了「已完成」。runtime 要先部署（0057 → runtime → 热更新）。

- [ ] **Step 13: 提交**

```bash
git add src/shared/supabaseRoutinesApi.ts services/runtime/src/routineStore.ts tests/shared/supabaseRoutinesApi.test.ts tests/runtime/routineStore.test.ts mobile/src/agent mobile/src/nav mobile/src/me/profileStore.ts mobile/src/tabs/ChatsScreen.tsx
git commit -m "feat(mobile): 智能体资料页的「定时任务」——列表、居中编辑弹窗、纯 JS 时间滚轮、设备时区上报（#1283）

不加原生依赖，整包能走热更新。校验与下一跳用 shared 那一份；手动新建前先建私聊，
到点 runtime 才找得到房。行映射搬到 shared，runtime 与手机一份。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: 文档 —— ADR-0356、代码地图、spec 回写

**Files:**
- Create: `docs/adr/0353-智能体的定时任务-runtime-tick加一张表-起turn走现成那条路.md`
- Modify: `docs/where-to-find-things.md`（末尾加一条）、`docs/superpowers/specs/2026-10-04-agent-routines-design.md`（三处小修）
- Test: `tests/docs/adrNumbers.test.ts`（既有：编号唯一且不跳号）

- [ ] **Step 1: 写 ADR**

```markdown
# ADR-0356：智能体的定时任务——runtime 里一只 tick 加一张表，到点起 turn 走现成那条路

日期：2026-10-04 · issue #1283 · spec `docs/superpowers/specs/2026-10-04-agent-routines-design.md` · 维护者在会话里拍板

## 背景

维护者原话：「给每个智能体加一个定时任务的功能，用户可以口头描述要求，然后智能体记住定时时间，按照用户的要求去执行。
这个定时任务会在智能体的设置里面显示，用户后期可以点进去调整。」分两类：永久（每天 / 每周几固定时间）与日抛（一次性）。
ADR-0298 把个人主场的审批整个免掉时，点名说 routine 要重判——没人在场的那一轮，刀与钱怎么管。

## 决定

1. **调度器放云 runtime daemon**：`agent_routines` 一张表 + 30 秒一拍的 tick，`update … where next_run_at = 读到的值` 原子认领。
   否决 pg_cron + webhook（runtime 没有对外 HTTP 入口）与 edge cron / DO alarm（Quota DO 刻意无 alarm，最后还是要叫 runtime）。
   **先推进 `next_run_at` 再起 turn**：起不成不会每 30 秒重试烧钱。
2. **起 turn 不造第二种机制**（ADR-0223）：到点在它的私聊里落 `user_message{greeting:"routine", routine:{id,title}}`，
   `fromUid` 是主人，然后 `coordinator.enqueue` → `startDrain`——与回电开场白、外联汇报、新智能体问候同一条路。`greeting`
   加取值不进协议位。手机时间线**画**这条开场白（一条灰条）：别的 greeting 都有前一条可见事件解释它为什么开口，这条没有。
3. **routine 轮视同主人亲口**（维护者选的）：主场免审照旧；`openingTraits` 的 `ownerSpoke` 对 `greeting:"routine"` 放行，
   否则 `call_friend` 在定时轮里永远灭着，「定时打给好友」做不成。这是唯一放宽的一处。
4. **刹车不靠审批靠两道门**：起跑前剩余周额度 < 10%（沿用 `RELAY_BUDGET_FRACTION_OF_REMAINING`）不起、落 `routine_note`；
   engine 加可选 `maxRounds`，routine 轮 40 圈到数抛错走既有的 `turn_ended{outcome:"error"}`。有人在场的轮不封顶（ADR-0006 那句仍成立）。
5. **时区从日志来**：手机 `say` 帧带设备 IANA 时区，runtime 落到 `user_message.tz`；投影的「今天是」按最近一条带 tz 的人话算
   ——仍是纯函数、不读库。`profiles.timezone` 只给调度器建任务时当默认值。打给好友的任务，工具说明里写死「先问好友所在城市」。
6. **形状只到每天 + 每周几**，不做 cron；墙上时间 + IANA 时区，不存 UTC cron。夏令时按 ICU 惯例（跳过的后移、重复的取先到的）。
7. **漏跑宽限**：一次性 2 小时、重复 10 分钟；超了一次性标 `missed` + 注记 + 停用，重复直接等下一跳不解释。
8. **设置页只做手机**（维护者选的），纯 JS 时间滚轮、不加原生依赖；桌面另开 issue。

## 已知代价

- routine 轮里 `call_friend` 的监督与主人当场派它一样松。出事先收窄 routine 的刀（ADR-0298 的原话），不收窄私聊。
- VPS 停机半天，那天的早报不会来也不会解释（重复任务的漏跑不注记）。
- 模型知道的「现在」是最近一条人话的时区；人换了地方还没在这条聊天说过话，它看到的是上一地的。
- 工具只校验 IANA 合法，不校验「好友真在那个城市」。

## 推翻条件

- 改成按需开房（ADR-0297 的推翻条件）：`openOriginRoom` 仍幂等，只是 tick 的 limit 50 要再看。
- routine 轮真出了事：先给它一张比私聊窄的工具表（`available` 那个口子），不动审批。
- 引擎有了按钱停的机制：圈数上限换成花费上限。
```

- [ ] **Step 2: 代码地图加一条**

`docs/where-to-find-things.md` 末尾加：

```markdown
- `src/shared/routines.ts` / `supabaseRoutinesApi.ts` / `services/runtime/src/routineStore.ts` / `routineTools.ts` / `routineScheduler.ts` / `routineRun.ts` / `supabase/migrations/0057_agent_routines.sql` / `mobile/src/agent/RoutinesScreen.tsx` / `RoutineEditDialog.tsx` / `TimeWheel.tsx` — **智能体的定时任务**（ADR-0356，#1283）：墙上时间 + IANA 时区存 `agent_routines`，`nextRunAt` 一份纯函数（夏令时按 ICU 惯例），runtime 30 秒 tick 原子认领（`where next_run_at = 读到的值`，先推进再起 turn），到点落 `user_message{greeting:"routine"}` 走 `enqueue → startDrain`（与回电 / 外联汇报同一条路）。routine 轮算主人亲口（`openingTraits` 放行）、免审，刹车是额度门（剩余周额度 < 10%）+ `maxRounds` 40（抛错走 `turn_ended{outcome:"error"}`）。时区：手机 `say` 帧带 `tz` 落 `user_message.tz`，投影「今天是」按它算（`userTzOf`）；`profiles.timezone` 只给建任务当默认。三把刀 `schedule_task` / `list_schedules` / `update_schedule` 只在主场私聊、主人亲口的轮亮。手机灰条：开场白与 `routine_note` 都是 `note` 行；桌面照旧藏。**部署顺序 0057 → runtime → 手机热更新**
```

- [ ] **Step 3: spec 回写三处**

按本计划开头「对 spec 的三处小修」改 spec §5.4 / §2.1（删 `session_id` 行，加一句「私聊按 0037 唯一索引现查」）/ §4.3 / §2.3。

- [ ] **Step 4: 跑 ADR 编号测试**

Run: `npx vitest run tests/docs/adrNumbers.test.ts`
Expected: PASS（合并前再 `git fetch origin && git -c core.quotePath=false ls-tree --name-only origin/main docs/adr | tail -1` 核一次编号，撞了按 ADR-0074 改成 max+1 并在文件头加 `原为 ADR-0356`——改号只改自己这条，别全局替换）

- [ ] **Step 5: 提交**

```bash
git add docs/adr/0353-*.md docs/where-to-find-things.md docs/superpowers/specs/2026-10-04-agent-routines-design.md
git commit -m "docs: ADR-0356 智能体的定时任务 + 代码地图 + spec 回写三处小修（#1283）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: 门禁、PR、收尾

- [ ] **Step 1: 装手机端依赖（一次）并跑门禁**

Run: `npm --prefix mobile ci && npm test`
Expected: `tsc` 两份零错误、vitest 全绿。红了先修再往下。

- [ ] **Step 2: 合并前核两件会撞的事**

Run: `git fetch origin && git ls-tree --name-only origin/main supabase/migrations | tail -1 && git -c core.quotePath=false ls-tree --name-only origin/main docs/adr | tail -1`
Expected: 0055 / 0352。否则 migration 改号（文件名 + 文件头 + 代码地图 + ADR 里的引用）、ADR 按 ADR-0074 改号。

- [ ] **Step 3: push + PR**

```bash
git push -u origin claude/agent-scheduled-tasks-14de41
gh pr create --title "feat: 智能体的定时任务（routine）——到点自己起 turn，手机设置页能看能改（#1283）" --body-file /tmp/pr-body.md
```

PR 正文（写进 `/tmp/pr-body.md`，用 Write 工具，别用 heredoc）：

```markdown
Closes #1283

spec：`docs/superpowers/specs/2026-10-04-agent-routines-design.md` · ADR-0356 · plan：`docs/superpowers/plans/2026-10-04-agent-routines.md`

## 做了什么
- `agent_routines`（0057）+ `src/shared/routines.ts` 一份纯函数（下一跳 / 校验 / 文案，夏令时按 ICU 惯例）
- runtime：30 秒 tick 原子认领 → 找私聊 → 开房 → `runRoutine`（`greeting:"routine"` 开场白，与回电 / 外联汇报同一条路）；额度门 + `maxRounds` 40
- 三把刀 `schedule_task` / `list_schedules` / `update_schedule`，只在主场私聊、主人亲口的轮亮
- 时区：手机 `say` 帧带 `tz` → `user_message.tz` → 投影「今天是」按它算；`profiles.timezone` 当建任务默认
- 手机：智能体资料页「定时任务」行 → 列表（重复 / 一次性 / 已完成 + 开关）→ 居中编辑弹窗（纯 JS 时间滚轮）

## 维护者拍板（会话里）
两类任务；打给好友先问城市定时区；无人在场照主场免审；重复形状到每天 + 每周；设置页只做手机；调度器放 runtime。

## 部署顺序
0057 → runtime → 手机热更新。**三件都还没做**，真机冒烟记在 #1283。

## 对 spec 的三处小修
见 plan 开头（圈数到数走 error 收口；表不存 session_id；桌面照旧藏）。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 4: 等 CI 绿、按 merge commit 合并（不 squash 不 rebase）**

```bash
gh pr merge --merge --delete-branch
```

- [ ] **Step 5: 收工**

按 AGENTS.md「On ending a shift」：#1283 由 PR 关闭；开一条交接 issue（Task 型，标题「交接：#1283 定时任务已合，待 0057 / runtime 部署 / 手机热更新 / 真机冒烟」），正文列三件线上动作 + 桌面设置页另开的 issue 号；五段式 Memory 评论；`npm run lane:prune` 看一眼。

---

## Self-review（计划写完后对着 spec 过一遍）

**Spec coverage**

| spec | task |
|---|---|
| §2.1 表 / §2.2 形状 / §2.3 nextRunAt | Task 2 / Task 1 |
| §3 调度器（tick、认领、limit 50、漏跑、起 turn、清理） | Task 11 + Task 12 |
| §4.1 事件 / §4.2 runRoutine / §4.3 投影与推送 | Task 3 / Task 10 / Task 4（推送不加规则，ADR-0338 既有） |
| §5.1 免审（不改代码）/ §5.2 ownerSpoke / §5.3 额度门 / §5.4 maxRounds / §5.5 上限与间隔 | — / Task 8 / Task 11 / Task 7 + Task 10 / Task 9 + Task 11 |
| §6.1 say 帧 tz / §6.2 今天是 / §6.3 profiles.timezone / §6.4 好友问城市 | Task 6 / Task 5 / Task 2 + Task 13 / Task 9（工具说明） |
| §7 三把刀 | Task 9 + Task 10（挂刀与 available） |
| §8 手机 UI | Task 13 |
| §9 测试 | 每个 task 自带；§9 的「工具三件」= Task 9；「时间线灰条」= Task 4 |
| §10 部署顺序 / 已知代价 | Task 14（ADR）+ Task 15（PR 正文） |

**Placeholder scan**：Task 10 Step 1 的测试里 `open()` 写的是「同 tz 测试的 open()，但…」——那份 `open()` 在 Task 6 Step 5 里是完整的，照抄再改三行；Task 13 的几处「以 ui.tsx / theme.ts 为准」是 prop 名核对，不是留白。

**Type consistency**：`RoutineStore.claim(id, expectedNextRunAt, { nextRunAt, lastRunAt })` 在 Task 9 定义、Task 11 使用一致；`runRoutine` 的参数 `{ routineId, title, instruction, tz, firedAt, agentId }` 在 Task 10 / Task 12 一致；`RoutineRunResult` 在 Task 11 定义、Task 12 使用；`routineRowOf` Task 9 先放 runtime、Task 13 搬到 shared 并改 import——执行时若按顺序做，Task 13 Step 3 那段「搬」不能漏。

