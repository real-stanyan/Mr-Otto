# 手机端 M2：任务栏 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机上能看、能建、能接着聊电脑上的任务会话——列表 / 开局 / 会话 / 已归档 / 搜索五屏，直连 Supabase。

**Architecture:** 云端那份日志是事实，手机是**读写它的一个客户端**，不经中继（ADR-0291）。读 = `task_sessions` select + realtime（`last_seq` 变了再拉事件尾巴）；写 = `task_append` RPC，只发 human 类事件（手机从不握笔）。事件 → 一屏的投影是新的纯逻辑 `src/shared/taskTimeline.ts`，跟着根门禁跑。

**Tech Stack:** Expo SDK 57 / RN 0.86 / @react-navigation 7（已在）；supabase-js v2（已在）；**新增** `react-native-reanimated` + `react-native-gesture-handler`（底部抽屉，Task 1 先验前提）；`expo-crypto`（已在，附件内容寻址）。

**Spec:** `docs/superpowers/specs/2026-09-12-mobile-m2-tasks-design.md`（M2 本体）
上位：`docs/superpowers/specs/2026-09-11-mobile-app-redesign-design.md` §4.2 / §5、`docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md` §3.1–3.3 / §3.6 / §3.9
issue：#1254。demo：`.demo/mobile-app-redesign.html` 的 `tasks` / `taskNew` / `taskChat` / `archive` / `search` + `SHEETS.model` / `SHEETS.attach` / `SHEETS.ctx` / `SHEETS.sessionMenu`

## Global Constraints

每个任务的要求都隐含包含这一节。

- **门禁**：`npm test`（现已含 `npm --prefix mobile run typecheck`，#422 / ADR-0294）。没装手机依赖先 `npm --prefix mobile ci`。
- **纯逻辑进 `src/shared/`，测试进 `tests/shared/`**；`mobile/` 里不放值得单独跑的逻辑（总纲 §7）。`src/shared/` 不许 import node builtin / electron / react-native。
- **手机从不握笔**：只发 `PEN_VERDICTS` 里的 `human` 类事件。不调 `task_pen_acquire`。
- **四态分开说**：还没查到 / 读不到 / 没有 / 没权限（总纲 §5）。「读不到」时上一份内容留在原地、错误另起一行。
- **文案不出现「水獭」**：任务里对面叫 **Otto**（#1264 / spec §3.4）。同一件事与桌面同词：会话、归档、订阅额度、免审批。
- **颜色只用 `mobile/src/theme.ts`**；一屏只给一个蓝色主动作；彩色只用来说「出事了」（`warn` / `destructive`）。
- **表单与确认用居中弹窗**（`mobile/src/dialog.tsx`），**选择器用底部抽屉**（ADR-0293 决定 7）。弹窗自己持有 `open`，调用方在 `onExited` 里才卸载。
- **减弱动态效果**（`useReduceMotion`）开着时：推入 / 升起退成交叉淡入、弹簧不回弹、按压反馈退成 `opacity 0.7`。
- **触感只在四处**（`expo-haptics`）：批准 / 拒绝落定、发送、通话接通 / 挂断、抽屉吸附。M2 只用到「发送」(`hapticSent`) 与「抽屉吸附」。
- **错误按 SQLSTATE 认，不按文案**：`TASK_SQLSTATE`（`src/shared/taskSync.ts`）P0010 seq_conflict / P0011 pen_required / P0012 forbidden / P0013 no_session。
- **提交**：小步提交、`git add` 写显式路径、消息说清 **why**。

## File Structure

| 文件 | 责任 |
|---|---|
| `src/shared/taskTimeline.ts`（新） | 事件 → 手机时间线的投影。穷举 `Record`，纯 |
| `src/shared/taskPresence.ts`（新） | 「谁在跑」「没人会答」两句话的判据，纯 |
| `tests/shared/taskTimeline.test.ts` / `taskPresence.test.ts`（新） | 上面两份的可执行版 |
| `mobile/src/sheet.tsx`（新） | 底部抽屉原语（拖拽关闭 + 吸附 + 减弱动态效果退化） |
| `mobile/src/tasks/tasksApi.ts`（新） | 直连 Supabase 的薄查询层（形状照 `friendsApi.ts`） |
| `mobile/src/tasks/cache.ts`（新） | 列表与最近一条会话的离线副本（kv-store） |
| `mobile/src/tasks/TasksRootScreen.tsx`（新） | 列表屏。替换今天 `tabs/TasksRoot.tsx` 的空态 |
| `mobile/src/tasks/NewTaskScreen.tsx`（新） | 开局屏 |
| `mobile/src/tasks/TaskChatScreen.tsx`（新） | 会话屏 |
| `mobile/src/tasks/ArchiveScreen.tsx`（新） | 已归档 |
| `mobile/src/tasks/SearchScreen.tsx`（新） | 搜索（三栏共用，M2 只接任务栏） |
| `mobile/src/tasks/Composer.tsx`（新） | 输入框一条（附件 / 模型 / 上下文环 / 发送） |
| `mobile/src/tasks/sheets/*.tsx`（新） | 模型、附件、上下文、会话菜单四张抽屉 |
| `mobile/src/nav/types.ts`、`nav/RootNavigator.tsx`（改） | 任务栈三屏 + `initialRouteName` 改回 `TasksTab` |
| `AGENTS.md`（改，索引一行） | 新事件类型检查清单多一处（第 13 处） |

---

### Task 1: 底部抽屉原语（含 Expo Go 前提验证）

**Files:**
- Verify: 模拟器上跑一次，确认 Expo Go SDK 57 带得动这两个包
- Modify: `mobile/package.json`、`mobile/babel.config.js`（没有就建）
- Create: `mobile/src/sheet.tsx`

**Interfaces:**
- Produces: `<Sheet visible onClose onExited title? children />`；`useSheet()` 不做，调用方自己持 `open`（同 `dialog.tsx` 的规矩）

- [ ] **Step 1: 先验前提（这一步不写代码）**

spec §7 明写：ADR-0293 决定 3 的前提是「依赖只取 Expo Go 自带的原生模块」。装之前先证明它成立。

```bash
npm --prefix mobile install react-native-reanimated react-native-gesture-handler
npx --prefix mobile expo start --ios
```

在模拟器里打开 app。**判据**：app 起得来、控制台没有 `requireNativeComponent` / `TurboModuleRegistry` 类的红屏。
起不来 = 前提不成立 → **停下来在任务报告里写明**，改用 RN 自带 `Animated` + `PanResponder`（手感差一档，不换运行时），本 Task 其余步骤照做、只换实现。

- [ ] **Step 2: 接线 babel 插件**

`react-native-reanimated` 要一个 babel 插件才工作，漏了它的失败是**静默的**（动画不动，不报错）。

```js
// mobile/babel.config.js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // reanimated 的插件必须排在最后一个
    plugins: ["react-native-reanimated/plugin"],
  };
};
```

- [ ] **Step 3: 写 `mobile/src/sheet.tsx`**

要点（照 apple-design / ADR-0293）：
- `Modal transparent` + 暗幕（`c.scrim`），暗幕点了**不关**（同 `dialog.tsx`：弹层只由自己的钮或下拉手势关）；
- 手势：`Gesture.Pan()` 跟手 1:1；松手按**投影落点**判去留（`projectedEnd = y + v/1000 * 0.998/(1-0.998)`，超过高度的 1/3 就关），不是按拖了多远；
- 进退场用 `withSpring`，Apple 两参数口径经 `src/shared/appleSpring.ts` 换算；带动量的手势才给回弹；
- `useReduceMotion()` 为真：退成 200ms 交叉淡入，没有位移、没有回弹；
- 关闭动画**放完**才调 `onExited`（调用方在那里卸载；直接卸载的话退场是死代码——spec §10 第 7 条）；
- 吸附那一刻 `hapticSelection`（`mobile/src/haptics.ts` 里没有就加一个，用 `ImpactFeedbackStyle.Light`）。

- [ ] **Step 4: 手验**

临时在 `TasksRoot` 挂一颗钮开这张空抽屉：拖到底松手 → 关；拖一点松手 → 弹回；系统「减弱动态效果」开着 → 淡入淡出、无位移。验完把临时钮删掉。

- [ ] **Step 5: 提交**

```bash
git add mobile/package.json mobile/package-lock.json mobile/babel.config.js mobile/src/sheet.tsx mobile/src/haptics.ts
git commit -m "feat(mobile): 底部抽屉原语——跟手、按投影落点判去留、减弱动态效果退成淡入(#1254 M2)"
```

---

### Task 2: `src/shared/taskTimeline.ts` —— 事件投影成一屏

**Files:**
- Create: `src/shared/taskTimeline.ts`
- Test: `tests/shared/taskTimeline.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`（`src/session/events.ts`，只做**类型**导入）
- Produces: `taskTimeline(events: readonly SessionEvent[]): TaskTimelineItem[]`、`TaskTimelineItem`、`TIMELINE_VERDICTS`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/taskTimeline.test.ts
import { describe, expect, it } from "vitest";
import { taskTimeline } from "../../src/shared/taskTimeline.js";
import type { SessionEvent } from "../../src/session/events.js";

const ev = (e: Partial<SessionEvent> & { type: SessionEvent["type"] }, seq: number): SessionEvent =>
  ({ sessionId: "s-20260912000000-aabbccdd", seq, ts: 0, ...e } as SessionEvent);

describe("taskTimeline", () => {
  it("人话与 Otto 的话各成一段，空 content 的 assistant 不出气泡", () => {
    const out = taskTimeline([
      ev({ type: "user_message", content: "把这份 PDF 读成一页要点" }, 0),
      ev({ type: "assistant_message", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] }, 1),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "……" }, 2),
      ev({ type: "assistant_message", content: "读完了，三条要点：" }, 3),
    ]);
    expect(out.map((i) => i.kind)).toEqual(["say", "tools", "say"]);
  });

  it("连续的工具调用折成一组", () => {
    const out = taskTimeline([
      ev({ type: "assistant_message", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "a" }, 1),
      ev({ type: "tool_result", toolCallId: "c2", status: "ok", output: "b" }, 2),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "tools" });
  });

  it("executor_changed 画一行分隔，文案说清是谁接的", () => {
    const out = taskTimeline([ev({ type: "executor_changed", executor: "cloud", ignorable: true }, 0)]);
    expect(out[0]).toMatchObject({ kind: "divider" });
    expect((out[0] as { text: string }).text).toContain("云端");
  });

  it("审批画一张只读卡——手机从不握笔，批不了", () => {
    const out = taskTimeline([
      ev({ type: "approval_request", callId: "c1", toolName: "bash", argsSummary: "rm -rf /tmp/x",
           initiatorUid: "u1", expiresTs: 0 }, 0),
    ]);
    expect(out[0]).toMatchObject({ kind: "card", card: "approval", readOnly: true });
  });

  it("**不截断**：手机是完整客户端，不是投影窗口", () => {
    const long = "x".repeat(5000);
    const out = taskTimeline([ev({ type: "user_message", content: long }, 0)]);
    expect((out[0] as { text: string }).text).toHaveLength(5000);
  });

  it("reasoning 不画", () => {
    const out = taskTimeline([ev({ type: "assistant_message", content: "答案", reasoning: "想了很久" }, 0)]);
    expect(JSON.stringify(out)).not.toContain("想了很久");
  });
});
```

- [ ] **Step 2: 跑，确认它红**

```bash
npx vitest run tests/shared/taskTimeline.test.ts
```
Expected: FAIL，`Cannot find module '../../src/shared/taskTimeline.js'`

- [ ] **Step 3: 写实现**

```ts
// src/shared/taskTimeline.ts
// 任务会话的事件 → 手机上那一屏。**纯**：不许 import node builtin / electron / react-native。
//
// 为什么不复用 src/shared/remote/timeline.ts 的 projectTimelineForMobile：那份是 ADR-0094
// 那条链路上「什么东西离开这台机器」的收口闸，判据是隐私与带宽（只认三种事件、剥 reasoning、
// 正文 2000 字就截）。任务会话的事件是手机**自己**从 Supabase 读的，没有「离开电脑」这一步，
// 那些判据一条都不成立；而这一屏要画的 executor_changed 分隔、审批卡、收口，它全都丢掉了。
// 让一个函数回答两个不同的问题，是这仓里成本最高的那种复用（spec §3）。
import type { SessionEvent } from "../session/events.js";

export type TaskTimelineItem =
  | { kind: "say"; role: "user" | "otto"; text: string; seq: number }
  | { kind: "tools"; calls: { name: string; output: string; ok: boolean }[]; seq: number }
  | { kind: "divider"; text: string; seq: number }
  | { kind: "card"; card: "approval" | "ask"; readOnly: true; title: string; body: string; seq: number };

/** 这条事件上不上手机的时间线。**穷举 Record**：新事件类型不表态 tsc 直接红
    （同 PRIVACY_VERDICTS / OTHER_AGENT_VERDICTS / PEN_VERDICTS 的形状）。
    这是新事件类型检查清单的**第 13 处**。 */
export type TimelineVerdict = "say" | "tools" | "divider" | "card" | "skip";
export const TIMELINE_VERDICTS: Record<SessionEvent["type"], TimelineVerdict> = {
  // ── 画出来 ──
  user_message: "say",
  assistant_message: "say",       // content 为空（纯工具调用）时不出气泡，见下
  tool_result: "tools",
  executor_changed: "divider",
  approval_request: "card",
  // ── 不画（机器的内务；判据同 ADR-0235 ③：**用户能不能据此行动**）──
  session_created: "skip",
  // ↓ 其余类型在这里逐条补全，一条不许漏
};
```

**怎么把其余类型补全（不要凭记忆敲）**：这张表的全部意义就是「漏一条 tsc 就红」，所以先把清单取出来再逐条判：

```bash
grep -n 'PEN_VERDICTS: Record' -A 80 src/shared/taskSync.ts
```

`PEN_VERDICTS` 是同一个 union 的一份**已经穷举过**的表（`src/shared/taskSync.ts`），照它的键抄一份过来，再逐条改成本表的判据。判据只有一句话：**用户能不能据此行动**（ADR-0235 ③ 判过同一个问题）——
- `say` / `tools` / `divider` / `card`：上面五条已定；
- 其余一律 `skip`。典型的：`session_created`（必然是第一条，画出来等于每条会话第一眼都是它）、`request_envelope`（工具从 16 把变 17 把，读者做不了任何事）、`model_usage` / `checkpoint_created` / `residue_*`（审计）、`memory_loaded` / `project_instructions`（注入）、`session_autotitled`（标题自己会变）。

**验收判据**：`TIMELINE_VERDICTS` 上**没有任何类型断言**（`as`），且 `npm --prefix mobile run typecheck` 与 `npm test` 都过。有 `as` = 这张表不再报警，等于没写。

其余实现要点：
- `assistant_message.content.trim() === ""` 不出 `say`（纯工具调用那条）；
- 工具名从发起它的 `assistant_message.toolCalls` 建索引（`tool_result` 上没有名字）；
- 连续的 `tool_result` 并成一个 `tools`（同 `groupTimeline` 的做法）；
- `divider` 文案：`cloud` → 「电脑睡着了，这一轮由云端接手」；`desktop` 且此前出现过 `cloud` → 「回到电脑」；`desktop` 且 `label` 变了 → 「换到另一台电脑」。口径与 `executorOfLog`（`src/shared/taskSync.ts`）一致；
- **不截断**、**不画 reasoning**。

- [ ] **Step 4: 跑，确认它绿**

```bash
npx vitest run tests/shared/taskTimeline.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/shared/taskTimeline.ts tests/shared/taskTimeline.test.ts
git commit -m "feat(shared): 任务会话事件 → 手机时间线的投影，判据是穷举 Record(#1254 M2)"
```

---

### Task 3: `src/shared/taskPresence.ts` —— 「谁在跑」与「没人会答」

**Files:**
- Create: `src/shared/taskPresence.ts`
- Test: `tests/shared/taskPresence.test.ts`

**Interfaces:**
- Consumes: `holderKindOf`（`src/shared/taskSync.ts`）
- Produces: `runningLine(holder, now, until) → string | null`、`nobodyWillAnswer(input) → boolean`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/taskPresence.test.ts
import { describe, expect, it } from "vitest";
import { nobodyWillAnswer, runningLine } from "../../src/shared/taskPresence.js";

const NOW = 1_800_000_000_000;

describe("runningLine", () => {
  it("笔在谁手里就说是谁", () => {
    expect(runningLine("desktop:abc", NOW, NOW + 10_000)).toContain("电脑");
    expect(runningLine("cloud", NOW, NOW + 10_000)).toContain("云端");
  });

  it("过期的笔不算在跑——持有人可能已经死了（睡眠 / 崩溃）", () => {
    expect(runningLine("desktop:abc", NOW, NOW - 1)).toBeNull();
  });

  it("笔空 = 没人在跑", () => {
    expect(runningLine(null, NOW, null)).toBeNull();
  });
});

describe("nobodyWillAnswer", () => {
  const base = { holder: null, until: null, lastSeenAt: NOW - 200_000, subscribed: false, now: NOW };

  it("三条同时成立才说这句话", () => {
    expect(nobodyWillAnswer(base)).toBe(true);
  });

  it("电脑心跳还新鲜 → 不说（它醒着，它会答）", () => {
    expect(nobodyWillAnswer({ ...base, lastSeenAt: NOW - 10_000 })).toBe(false);
  });

  it("有人握着笔 → 不说（已经有人在答了）", () => {
    expect(nobodyWillAnswer({ ...base, holder: "cloud", until: NOW + 10_000 })).toBe(false);
  });

  it("订着阅 → 不说（云端会接手）", () => {
    expect(nobodyWillAnswer({ ...base, subscribed: true })).toBe(false);
  });

  it("**还没查到订阅一律不说** —— 查不到 ≠ 没订阅（同 ADR-0240 / 0217 的 unknown 一态）", () => {
    expect(nobodyWillAnswer({ ...base, subscribed: null })).toBe(false);
  });

  it("心跳一次都没有过（null）算陈旧——那台电脑从没报到过", () => {
    expect(nobodyWillAnswer({ ...base, lastSeenAt: null })).toBe(true);
  });
});
```

- [ ] **Step 2: 跑，确认红**
- [ ] **Step 3: 写实现**（两个纯函数，签名如上；90 s 取 `src/shared/taskSync.ts` 里的宽限窗口口径，没有常量就在这里定义 `DESKTOP_FRESH_MS = 90_000` 并注明出处 spec §3.3）
- [ ] **Step 4: 跑，确认绿**
- [ ] **Step 5: 提交**

---

### Task 4: `mobile/src/tasks/tasksApi.ts` —— 薄查询层

**Files:**
- Create: `mobile/src/tasks/tasksApi.ts`

**Interfaces:**
- Consumes: `supabase`（`mobile/src/supabase.ts`）、`holderId` / `TASK_SQLSTATE` / `PULL_PAGE`（`src/shared/taskSync.ts`）、`newSessionId`（`src/shared/sessionId.ts`）
- Produces:

```ts
export interface TaskRow {
  id: string; title: string; archived: boolean; lastSeq: number;
  penHolder: string | null; penUntil: number | null; updatedAt: number;
}
export function listTasks(): Promise<TaskRow[]>;
export function loadEvents(sessionId: string, afterSeq: number): Promise<SessionEvent[]>;
export function appendEvents(sessionId: string, expectedSeq: number, deviceId: string, events: SessionEvent[]): Promise<number>;
export function createTask(deviceId: string, firstMessage: string): Promise<string>;  // 回 sessionId
export function watchTasks(uid: string, onChange: () => void): () => void;           // realtime
export class TaskRpcError extends Error { code: string }                              // 按 SQLSTATE 分支用
```

- [ ] **Step 1: 写它**

要点：
- 形状照 `mobile/src/friendsApi.ts`（薄到无逻辑、`unwrap` 归一 `{data,error}`、realtime 用 `supabase.channel(...).on("postgres_changes", …)`）；
- `createTask`：`newSessionId()` 铸 id，`expected_seq = 0`，两条事件 `session_created{ workspaceKind: "default" }`（**不带 `workspace`**——每台电脑自己算 Default 路径）+ `user_message`；
- `holder` 一律 `holderId("phone", deviceId)`；**不调 `task_pen_acquire`**；
- 错误抛 `TaskRpcError`，`code` 取 PostgREST 回的 SQLSTATE，调用方按 `TASK_SQLSTATE` 分支；
- `loadEvents` 按 `PULL_PAGE` 分页，`payload` 列直接是整条事件。

- [ ] **Step 2: 类型检查**

```bash
npm --prefix mobile run typecheck
```

- [ ] **Step 3: 提交**

---

### Task 5: 列表屏

**Files:**
- Create: `mobile/src/tasks/TasksRootScreen.tsx`
- Modify: `mobile/src/tabs/TasksRoot.tsx`（换成它）、`mobile/src/nav/types.ts`（`TasksStackParams` 加屏）

- [ ] **Step 1: 画** —— 在跑的那条置顶成 hero（完整说出它此刻在说什么，不截成一行灰字）；其余按 `updatedAt` 分「今天 / 更早」；每行带执行方 pill（本机 / 云端 / 另一台电脑，`holderKindOf`）；底部一行「已归档 N ›」。导航栏大标题底下一行状态（「1 条在跑 · 4 条闲着」）。
- [ ] **Step 2: 四态** —— 还没查到（骨架）/ 读不到（上一份留着 + 红字另起一行）/ 没有（「还没有任务。点右上角 ＋ 开一个」）/ 没权限（RLS 拒 → 「这个账号看不到它」）。
- [ ] **Step 3: 跟随** —— `watchTasks` 变了重拉；窗口重新聚焦拉一次（`AppState` 的 `active`）；下拉刷新。**不做定时轮询**。
- [ ] **Step 4: 模拟器上看** —— 浅色 / 深色各一遍，与 demo 的 `tasks` 屏并排比。
- [ ] **Step 5: 提交**

---

### Task 6: 开局屏（建会话）

**Files:** Create `mobile/src/tasks/NewTaskScreen.tsx`；Create `mobile/src/tasks/Composer.tsx`（先只做输入 + 发送，模型 / 附件 / 环留空位）

- [ ] **Step 1: 画** —— 「今天<br>要做点什么？」+ 一段说明 + 四个示例话头 chip + composer。**不挑文件夹、不挑模型**（那是电脑的事）。
- [ ] **Step 2: 发出去** —— `createTask` 成功后 `navigation.replace("TaskChat", { id })`（**replace 不是 push**：返回该回到列表，不该回到一个已经建过的开局屏）。
- [ ] **Step 3: 失败怎么说** —— 建不出来时话留在输入框里 + 一行人话（`TaskRpcError` 按 code 分支；断网那条走 Task 11 的离线判据）。
- [ ] **Step 4: 模拟器上看**
- [ ] **Step 5: 提交**

---

### Task 7: 会话屏

**Files:** Create `mobile/src/tasks/TaskChatScreen.tsx`

- [ ] **Step 1: 画时间线** —— `taskTimeline(events)` 的四种 item：`say` 两种气泡、`tools` 折叠组（默认收起，头一行「读了 6 个文件 · 写了 1 个」）、`divider` 一行居中小字、`card` 只读卡。
- [ ] **Step 2: 笔那一格** —— `runningLine(...)` 非空时输入框上方一行小字；**输入框不禁用**（人话免笔，正在跑的那一轮会在增量采样里读到它）。
- [ ] **Step 3: 「没人会答」** —— `nobodyWillAnswer(...)` 为真时一行「电脑不在线；云端接手要订阅」。订阅那一格读 edge 的 `/billing/v1/me`，**查不到就不说这句话**。
- [ ] **Step 4: 审批卡只读** —— 画清哪把刀、什么参数、谁发起的，底下一句「去电脑上批」。**不画批准 / 拒绝钮**（画了就是 #722 那个撒谎的勾）。
- [ ] **Step 5: 发话** —— `appendEvents(sessionId, lastSeq + 1, deviceId, [userMessage])`；撞 `seq_conflict` 先重拉再重试一次；`hapticSent()`。
- [ ] **Step 6: 跟随** —— 订这条会话的 `task_sessions` 行，`last_seq` 变了拉尾巴（`loadEvents(id, 本地末条 seq)`）。
- [ ] **Step 7: 模拟器上看**（含与 demo 的 `taskChat` 并排比）
- [ ] **Step 8: 提交**

---

### Task 8: 模型选单抽屉

**Files:** Create `mobile/src/tasks/sheets/ModelSheet.tsx`；Modify `Composer.tsx`

- [ ] **Step 1: 画** —— 三条判据原样搬桌面（ADR-0261 / 0249）：「文字 / 图像」两格的开关**在滚动列表外面**；图像那格**不共用**文字那格的选中态；**每次打开回到「文字」格**。
- [ ] **Step 2: 落事件** —— `model_changed` / `image_model_changed`（human 类，免笔）。
- [ ] **Step 3: 清单从哪来** —— edge 的 `/billing/v1/me`；**拿不到 = 整枚不画**（同 `modelMenu` 对 `hosted` 的处置），不画假清单。
- [ ] **Step 4: 模拟器上看** / **Step 5: 提交**

---

### Task 9: 附件

**Files:** Create `mobile/src/tasks/attachments.ts`；Create `mobile/src/tasks/sheets/AttachSheet.tsx`

- [ ] **Step 1: 内容寻址** —— `expo-crypto` 的 `digest(SHA256, bytes)` → hex；对象名 `<uid>/<hex>`。
- [ ] **Step 2: 先传字节再落事件** —— PUT 到 bucket `task-attachments`（0036 的四条 own-folder 策略已经在），**成功之后**才 `appendEvents`。永不推出一条悬空引用。
- [ ] **Step 3: 复用既有的那一半** —— `mobile/src/attach.ts` 的 `pickPhotos` / `pickFiles` / `prepareForUpload` / `tooBig`；超上限的图先缩再传走 `src/shared/imageFit.ts`。
- [ ] **Step 4: 模拟器上看** / **Step 5: 提交**

---

### Task 10: 已归档屏 + 会话菜单抽屉

**Files:** Create `mobile/src/tasks/ArchiveScreen.tsx`、`mobile/src/tasks/sheets/SessionMenuSheet.tsx`

- [ ] **Step 1: 已归档** —— 列归档的，行尾「恢复」= `session_unarchived`（human 类）。组尾一句「归档的会话不出现在清单里，但一个字都没删」。
- [ ] **Step 2: 会话菜单** —— 归档、改名（居中弹窗，不是抽屉）、分享。**「转成语音继续」在 M7 之前不画**（画了点不动就是撒谎的勾）。**没有「删除」**：删会话要 `delete from task_sessions`，那是另一条口径，M2 不做。
- [ ] **Step 3: 模拟器上看** / **Step 4: 提交**

---

### Task 11: 离线

**Files:** Create `mobile/src/tasks/cache.ts`；Modify 列表屏 / 会话屏 / composer

- [ ] **Step 1: 缓存** —— kv-store，key 前缀 `otto.tasks.`：列表一份 + 最近打开那条会话的事件尾一份。冷启动先画缓存再拉网络，拉到了整份替换。
- [ ] **Step 2: 离线写：当场拒绝，不排队** —— 手机没有执行器，排队发出去的那句话**没有人会答**，而它会在回网的某一刻突然起一轮（spec §5）。拒绝的措辞要说「这句话还没发出去」，**原文留在输入框里**（同 ADR-0228 `unknown` 那条的纪律）。
- [ ] **Step 3: 模拟器上看** —— 开飞行模式：列表还在（标「离线，看到的是上次的」）、发话被拒且原文还在。
- [ ] **Step 4: 提交**

---

### Task 12: 上下文抽屉

**Files:** Create `mobile/src/tasks/sheets/CtxSheet.tsx`

- [ ] **Step 1: 环与分段** —— 从事件现算（`src/shared/contextEstimate.ts` 的 `contextUsed` / `contextBreakdown`）。
- [ ] **Step 2: 额度那半** —— 读 `/billing/v1/me`，口径照 ADR-0209 / 0239：报**还剩百分之几**、条按**剩余**填、色档按**已用**判、充足时中性灰。**清零的窗不画倒计时**。
- [ ] **Step 3: 拿不到就不画那一半**（不是画成 0）
- [ ] **Step 4: 模拟器上看** / **Step 5: 提交**

---

### Task 13: 搜索屏 + 导航接线 + 收尾

**Files:** Create `mobile/src/tasks/SearchScreen.tsx`；Modify `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`、`AGENTS.md`

- [ ] **Step 1: 搜索** —— 三栏共用一屏，从哪一栏进就搜哪一栏；v1 只搜**已加载**的标题 + 最近一句；空结果说「没有命中」不说「没有会话」。
- [ ] **Step 2: 导航** —— `TasksStackParams` 补 `TaskChat: { id: string }` / `NewTask` / `Archive` / `Search`；`initialRouteName` 从 `ProjectsTab` **改回 `TasksTab`**（总纲 §10 第 10 条：M0 里任务栏还是空态才临时落在项目栏，接上之后改回 demo 的落点）。
- [ ] **Step 3: AGENTS.md 索引一行** —— 「Where to find things」加 `src/shared/taskTimeline.ts`，并在新事件类型检查清单那条（`PRIVACY_VERDICTS` 那一段）写明**第 13 处**是它。L2，随本 PR 走。
- [ ] **Step 4: 全量门禁 + 手机端类型检查**

```bash
npm test
```

- [ ] **Step 5: 模拟器逐屏对照 demo**，偏差记进总纲 §10
- [ ] **Step 6: 提交**
