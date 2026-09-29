# 回电接通就开口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 智能体回电时把开场白写好；接通时 runtime 直接替它落下开场白（它空闲时不起模型调用），手机在响铃期间先把这几句合成好，接起来立刻出声。

**Architecture:** `call_user` 多一个必填参数 `opening`，随 `call_ring` 事件与推送载荷一起走。runtime 在 `setVoiceCall` 认出接听时，按「这只此刻有没有开着的一轮」二选一：空闲 → 同步落 `user_message(接通了) + assistant_message(开场白) + turn_ended`；忙 → 回落到老的「落开场白、起一轮」，文案里带上开场白。手机把 TTS 客户端包一层预合成缓存，来电入队时按放音那条路同一套切句预取；另外修掉「事件先于回执到达、加入晚了就读不到」那个会让开场白静默丢失的时序。

**Tech Stack:** TypeScript（strict）、vitest、Expo / React Native（手机端只改 JS）。

**Spec:** `docs/superpowers/specs/2026-09-29-callback-opening-design.md`

## Global Constraints

- 开场白上限 `RING_OPENING_MAX = 200`（按字算，`[...s].length`），超了**拒绝**（抛错），不截断；空串拒绝。
- `call_ring.opening` 是**可选**字段：旧日志 / 旧 runtime 落的事件没有它，必须照常重放。
- 推送载荷里的 `opening` 缺席或类型不对 = 当它不存在，**不拒整条推送**。
- 预合成的键必须与接通后放音时 `speak(text, voiceId)` 的两个参数逐字相同：`text` = `splitSpoken(content)` 每一段过 `spokenText` 后非空的那些；`voiceId` = `agentVoiceId(agentId, 同一份 roster)`。
- 「这只忙不忙」的判据只有一处：`openTurns(store.load(sessionId))` 里有没有它。不看 `coordinator.isRunning()`（那是全会话的）。
- 替它落的 `assistant_message` 不带 `usage` / `route` / `creditCostMicro`；`model` 取日志里它打电话那条 `assistant_message`（`toolCalls` 含 `call_user`）的 `model`。
- 测试放 `tests/`，镜像 `src/` 结构。门禁命令：`npm test`。
- 提交信息写**为什么**；结尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

---

### Task 1: shared —— `callRing.ts` 带上开场白 + `spokenUnits`

**Files:**
- Modify: `src/session/events.ts`（`CallRingEvent`，约 649 行）
- Modify: `src/shared/callRing.ts`
- Modify: `src/shared/voiceFeed.ts`（新增导出 `spokenUnits`）
- Test: `tests/shared/callRing.test.ts`、`tests/shared/voiceFeed.test.ts`

**Interfaces:**
- Produces:
  - `CallRingEvent.opening?: string`
  - `RING_OPENING_MAX: 200`
  - `normalizeRingOpening(raw: string): string` —— 空白折成一个空格、去首尾；**不截断**
  - `RingState.opening: string | null`
  - `RingPush.opening?: string`；`ringFromPayload` 读它
  - `callbackGreetingText(agentName: string, userLabel: string, reason: string, opening?: string | null): string` —— 第 4 参缺席 / null 时逐字等于改动前
  - `callbackAnsweredText(agentName: string, userLabel: string): string`
  - `callerModelOf(events: readonly SessionEvent[], agentId: string): string`
  - `spokenUnits(content: string): string[]`（voiceFeed.ts）

- [ ] **Step 1: 写失败的测试**

在 `tests/shared/callRing.test.ts` 末尾追加（import 里补上新名字：`RING_OPENING_MAX, normalizeRingOpening, callbackAnsweredText, callerModelOf`，以及已有的 `applyCallRing / callRingFoldOf / ringFromPayload / callbackGreetingText`）：

```ts
describe("开场白（#1420）", () => {
  it("normalizeRingOpening：空白折成一个空格、去首尾，不截断", () => {
    expect(normalizeRingOpening("  部署好了。\n\n  你看一下  ")).toBe("部署好了。 你看一下");
    const long = "字".repeat(RING_OPENING_MAX + 5);
    expect(normalizeRingOpening(long)).toBe(long);
    expect(normalizeRingOpening(" \n ")).toBe("");
  });

  it("ringing 带 opening → RingState.opening；没有 → null；answered 沿用 ringing 那条的", () => {
    const base = { sessionId: "s1", fromAgentId: "ops", toUid: "u1", reason: "部署完了", expiresTs: 9_000, ignorable: true as const };
    const fold = callRingFoldOf([
      { ...base, seq: 1, ts: 1, type: "call_ring", ringId: "r1", phase: "ringing", opening: "部署好了，你看一下。" },
      { ...base, seq: 2, ts: 2, type: "call_ring", ringId: "r2", phase: "ringing" },
      { ...base, seq: 3, ts: 3, type: "call_ring", ringId: "r1", phase: "answered" },
    ] as SessionEvent[]);
    expect(fold.get("r1")).toMatchObject({ phase: "answered", opening: "部署好了，你看一下。" });
    expect(fold.get("r2")?.opening).toBeNull();
  });

  it("ringFromPayload：带 opening 读出来；缺席 / 类型不对当没有，整条照收", () => {
    const ring = { ringId: "r", workspaceId: "w", sessionId: "s", agentId: "a", agentName: "运维", reason: "好了", chat: "dm", expiresTs: 1 };
    expect(ringFromPayload({ ring: { ...ring, opening: "你好。" } })?.opening).toBe("你好。");
    expect(ringFromPayload({ ring })).not.toBeNull();
    expect(ringFromPayload({ ring })?.opening).toBeUndefined();
    expect(ringFromPayload({ ring: { ...ring, opening: 3 } })?.opening).toBeUndefined();
    expect(ringFromPayload({ ring: { ...ring, opening: "" } })?.opening).toBeUndefined();
  });

  it("callbackGreetingText：不给开场白时与改动前逐字相同；给了就带上「先照这个说」", () => {
    const old = callbackGreetingText("运维", "alice", "部署完了");
    expect(callbackGreetingText("运维", "alice", "部署完了", null)).toBe(old);
    expect(old).toContain("先把这件事说清楚");
    const withOpening = callbackGreetingText("运维", "alice", "部署完了", "部署好了，你看一下。");
    expect(withOpening).toContain("你打电话时准备的开场白是：部署好了，你看一下。");
    expect(withOpening).toContain("先照这个说");
    expect(withOpening.startsWith("[系统] 「运维」打给 alice 的电话接通了。")).toBe(true);
  });

  it("callbackAnsweredText：只说接通了", () => {
    expect(callbackAnsweredText("运维", "alice")).toBe("[系统] 「运维」打给 alice 的电话接通了。");
  });

  it("callerModelOf：取这只最近一条调了 call_user 的回复的 model；退到它最近一条回复；再没有 unknown", () => {
    const am = (seq: number, agentId: string, model: string, call = false): SessionEvent =>
      ({ seq, sessionId: "s1", ts: seq, type: "assistant_message", agentId, model, content: "",
         ...(call ? { toolCalls: [{ id: `c${seq}`, name: "call_user", args: {} }] } : {}) }) as SessionEvent;
    expect(callerModelOf([am(1, "ops", "m-old", true), am(2, "ops", "m-later"), am(3, "ads", "m-ads", true)], "ops")).toBe("m-old");
    expect(callerModelOf([am(1, "ops", "m-a"), am(2, "ops", "m-b")], "ops")).toBe("m-b");
    expect(callerModelOf([am(1, "ads", "m-ads")], "ops")).toBe("unknown");
  });
});
```

在 `tests/shared/voiceFeed.test.ts` 末尾追加（import 补 `spokenUnits`，已有 `feedEvent` 等）：

```ts
describe("spokenUnits（#1420 预合成的键）", () => {
  it("与终态 assistant_message 实际送去合成的那几句逐字相同", () => {
    const content = "**部署好了**。你看一下，有个配置要你拍板！\n\n- 第二段也念";
    const participants = new Set(["a"]);
    const e = { seq: 5, sessionId: "s", ts: 5, type: "assistant_message", agentId: "a", model: "m", content } as SessionEvent;
    const { out } = feedEvent(EMPTY_VOICE_FEED, participants, 0, e);
    expect(spokenUnits(content)).toEqual(out.map((u) => u.text));
    expect(spokenUnits(content).length).toBeGreaterThan(1);
  });
  it("剥完为空的那一段不出现", () => {
    expect(spokenUnits("```\ncode\n```")).toEqual([]);
  });
});
```

（`EMPTY_VOICE_FEED` 若在该测试文件里还没 import，从 `../../src/shared/voiceFeed.js` 一起 import；用 `grep -n "export const EMPTY_VOICE_FEED" src/shared/voiceFeed.ts` 确认名字。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/callRing.test.ts tests/shared/voiceFeed.test.ts`
Expected: FAIL（`normalizeRingOpening` / `spokenUnits` 等未导出）

- [ ] **Step 3: 实现**

`src/session/events.ts` 的 `CallRingEvent` 里、`reason: string;` 之后加：

```ts
  /** 接通之后它先说的那段话（#1420）：打电话那一刻由模型写好，接通时 runtime 直接替它说出来。
      ringing 之后的 answered / missed 照抄。可选 = 旧日志 / 旧版 runtime 落的照常重放 */
  opening?: string;
```

`src/shared/callRing.ts`：

1. 常量区（`RING_REASON_MAX` 下面）加：

```ts
/** 开场白的上限（按字算）。超了拒绝、不截断：截在半句上念出来比没有更糟（#1420） */
export const RING_OPENING_MAX = 200;
```

2. `RingState` 接口加一格 `opening: string | null;`（放在 `reason` 后面）。
3. `applyCallRing` 的 ringing 分支对象里加 `opening: e.opening ?? null,`。
4. `normalizeRingReason` 下面加：

```ts
/** 开场白：空白折成一个空格、去首尾。**不截断**——长度由调用方判（超了拒绝） */
export function normalizeRingOpening(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}
```

5. 把 `callbackGreetingText` 改成：

```ts
export function callbackGreetingText(agentName: string, userLabel: string, reason: string, opening?: string | null): string {
  const n = promptSafe(agentName);
  const head = `[系统] 「${n}」打给 ${promptSafe(userLabel)} 的电话接通了。${n}：你打这个电话是为了：${promptSafe(reason)}。`;
  const say =
    opening !== undefined && opening !== null && opening !== ""
      ? `你打电话时准备的开场白是：${promptSafe(opening)}。先照这个说，说完问他还有没有要你做的。`
      : "先把这件事说清楚，说完问他还有没有要你做的。";
  return `${head}${say}这句话会被读出来，别用列表和记号。`;
}

/** 接通了、开场白由 runtime 替它说（#1420）：这一句只交代「接通了」，开场白是紧跟着的那条 assistant_message */
export function callbackAnsweredText(agentName: string, userLabel: string): string {
  return `[系统] 「${promptSafe(agentName)}」打给 ${promptSafe(userLabel)} 的电话接通了。`;
}

/** 开场白是哪个模型写的（#1420，assistant_message.model 是「事实」）：这只最近一条调了 call_user 的
    回复；找不到退到它最近一条回复；再没有 "unknown" */
export function callerModelOf(events: readonly SessionEvent[], agentId: string): string {
  let fallback: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "assistant_message" || e.agentId !== agentId) continue;
    if (e.toolCalls?.some((c) => c.name === CALL_USER_TOOL_NAME)) return e.model;
    fallback ??= e.model;
  }
  return fallback ?? "unknown";
}
```

6. `RingPush` 接口加 `opening?: string;`；`ringFromPayload` 的 return 改成：

```ts
  const opening = typeof o.opening === "string" && o.opening !== "" ? o.opening : null;
  return {
    ringId, workspaceId, sessionId, agentId, agentName, reason, chat: chat as RingChatKind, expiresTs,
    ...(opening !== null ? { opening } : {}),
  };
```

`src/shared/voiceFeed.ts`：在 `splitSpoken` 下面加：

```ts
/** 一段话真正送去合成的那几句（#1420 预合成的键）：与 take() 里的变换逐字相同——切句、每句过
    spokenText、剥完为空的不要。改 take() 的变换时这里要跟着改（有一条对拍的测试钉着） */
export function spokenUnits(content: string): string[] {
  return splitSpoken(content).map(spokenText).filter((t) => t !== "");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/callRing.test.ts tests/shared/voiceFeed.test.ts && npm run typecheck`
Expected: PASS；tsc 无错（`RingState` 多了必填 `opening`，若有别处字面量构造 `RingState` 会在这里报错——`services/runtime/src/callRinger.ts` 的 `call()` 会报，Task 2 修；本步若只有那一处报错可接受，Step 5 之前先在 callRinger.ts 的 ring 字面量里临时补 `opening: null` 让 tsc 过）

- [ ] **Step 5: Commit**

```bash
git add src/session/events.ts src/shared/callRing.ts src/shared/voiceFeed.ts services/runtime/src/callRinger.ts tests/shared/callRing.test.ts tests/shared/voiceFeed.test.ts
git commit -m "feat(shared): call_ring 与来电推送带上开场白，spokenUnits 给预合成当键（#1420）"
```

---

### Task 2: runtime —— `call_user` 收开场白，ringer 记下并推出去

**Files:**
- Modify: `services/runtime/src/callUserTool.ts`
- Modify: `services/runtime/src/callRinger.ts`
- Modify: `services/runtime/src/sessionService.ts`（约 1293 行 `ring:` 那一行）
- Test: `tests/runtime/callUserTool.test.ts`、`tests/runtime/callRinger.test.ts`

**Interfaces:**
- Consumes: `normalizeRingOpening`, `RING_OPENING_MAX`, `RingState.opening`, `RingPush.opening`（Task 1）
- Produces:
  - `CallUserDeps.ring(toUid: string, reason: string, opening: string): Promise<string>`
  - `Ringer.call(agentId: string, agentName: string, toUid: string, reason: string, opening: string): Promise<string>`
  - `Ringer.answer(...)` 回的 `RingState` 带 `opening`

- [ ] **Step 1: 写失败的测试**

`tests/runtime/callUserTool.test.ts`：
- 把现有所有 `t.run({ reason: ... }, world)` 改成同时带 `opening: "部署好了，你看一下。"`（「reason 不是字符串」那条除外，那条保留只给 reason 的写法也行，因为它会先因 reason 抛错）。
- 把「名字、参数、不过审批门」里的 `required: ["reason"]` 改成 `required: ["reason", "opening"]`。
- 「打给叫起这一轮的那个人」那条：`ring` 回调改成三参 `(to, reason, opening)`，期望 `calls` 为 `[["u1", "部署完了 要你拍板", "部署好了， 你看一下。"]]`，输入 `opening: "  部署好了，\n 你看一下。 "`。
- 追加：

```ts
  it("opening 不是字符串 / 规整完是空的 / 超过 200 字：抛错，不打", async () => {
    const calls: string[] = [];
    const t = createCallUserTool({ initiator: () => "u1", ring: async (to) => { calls.push(to); return "打了"; } });
    await expect(t.run({ reason: "好了" }, world)).rejects.toThrow("opening");
    await expect(t.run({ reason: "好了", opening: " \n " }, world)).rejects.toThrow("opening");
    await expect(t.run({ reason: "好了", opening: "字".repeat(RING_OPENING_MAX + 1) }, world)).rejects.toThrow("200");
    expect(await t.run({ reason: "好了", opening: "字".repeat(RING_OPENING_MAX) }, world)).toBe("打了");
    expect(calls).toEqual(["u1"]);
  });
```

（import 补 `RING_OPENING_MAX`。）

`tests/runtime/callRinger.test.ts`：
- 全文把每一处 `r.call("ops", "运维", "u1", "部署完了")`（以及其他 reason 字面量的 `.call(` 调用）补第 5 参 `"部署好了，你看一下。"`。用 `grep -n "\.call(" tests/runtime/callRinger.test.ts` 列出来逐个改。
- 「落 ringing…」那条：`events[0]` 的 `toMatchObject` 里加 `opening: "部署好了，你看一下。"`；`pushes` 的 `toEqual` 对象里加 `opening: "部署好了，你看一下。"`；`c.advance` 到点之后再加一句 `expect(events[1]).toMatchObject({ phase: "missed", opening: "部署好了，你看一下。" });`。
- 「还在响：记接通」那条加：`expect(r.answer(...))` 之前先存结果：把 `expect(r.answer("ops", "u1")?.reason).toBe("部署完了");` 改成

```ts
    const got = r.answer("ops", "u1");
    expect(got?.reason).toBe("部署完了");
    expect(got?.opening).toBe("部署好了，你看一下。");
```

- `seeded(...)` 构造的旧事件不带 opening：在「重启与归档」的 resume 用例末尾加 `expect(events.every((e) => e.opening === undefined)).toBe(true);`（旧响铃补的 missed 不凭空长出开场白）。

`tests/runtime/sessionService.test.ts` 的 `describe("回电（#1411）")`（约 7337 行）：`opening` 成了必填，现有夹具只给 `reason` 会让工具抛错、电话打不出去。本任务只改夹具，**断言不动**（接通那条路 Task 3 才改）：

```ts
  const OPENING = "部署好了，有个配置要你拍板。";
  /** 运维第一轮打电话、之后收尾 */
  const callsBack = (reason: string) => (id: string, round: number): ModelReply =>
    id === "ops" && round === 1 ? { content: "", toolCalls: [{ id: "c1", name: CALL_USER_TOOL_NAME, args: { reason, opening: OPENING } }] } : { content: "好" };
```

「通话本来就开着」那条里手写的 `args: { reason: "测完了" }` 改成 `args: { reason: "测完了", opening: OPENING }`。「客人点起的那一轮：call_user 也要群主批」（约 1369 行）若也手写了 `call_user` 的 args，同样补 `opening`（`grep -n "CALL_USER_TOOL_NAME, args" tests/runtime/sessionService.test.ts` 列全）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/callUserTool.test.ts tests/runtime/callRinger.test.ts`
Expected: FAIL（required 不含 opening、push 里没有 opening 等）

- [ ] **Step 3: 实现**

`services/runtime/src/callUserTool.ts`：

```ts
import { CALL_USER_TOOL_NAME, RING_OPENING_MAX, normalizeRingOpening, normalizeRingReason } from "../../../src/shared/callRing.js";

export interface CallUserDeps {
  initiator: () => string | null;
  /** 打一次。回给模型的那句话。`opening` 已规整、长度已判 */
  ring: (toUid: string, reason: string, opening: string) => Promise<string>;
}
```

`def.description` 末句改成：`"reason 写一句他在锁屏上一眼能看懂的话；opening 写好他接起来之后你先说的那段话——接通时直接念出来，不再现想。"`；`parameters.properties` 加：

```ts
          opening: {
            type: "string",
            description: "他接起来之后你先说的那段话（200 字以内）：口语、说给人听的，别用列表和记号。接通那一刻原样念出来",
          },
```

`required: ["reason", "opening"]`。`run` 里 reason 判完之后加：

```ts
      const rawOpening = (args as { opening?: unknown } | null)?.opening;
      if (typeof rawOpening !== "string") throw new Error("call_user: 参数 opening 必须是字符串——写好他接起来之后你先说的那段话");
      const opening = normalizeRingOpening(rawOpening);
      if (opening === "") throw new Error("call_user: opening 不能是空的——写好他接起来之后你先说的那段话");
      if ([...opening].length > RING_OPENING_MAX) throw new Error(`call_user: opening 超过 ${RING_OPENING_MAX} 字了，缩短一点（念出来的话宜短）`);
```

最后一行改成 `return deps.ring(to, reason, opening);`。文件头注释补一句：`opening 随响铃记进日志、随推送到手机（#1420）：接通时由 runtime 直接替它说出来，手机在响铃时先合成`。

`services/runtime/src/callRinger.ts`：
- `Ringer.call` 签名加第 5 参 `opening: string`（接口与实现都改）；接口注释改成「`reason` / `opening` 已经规整过」。
- `call()` 里构造 `ring` 时 `opening`（去掉 Task 1 临时补的 `opening: null`）；`push` 对象加 `opening,`。
- `log()` 里的 append 对象在 `reason: ring.reason,` 后面加 `...(ring.opening !== null ? { opening: ring.opening } : {}),`。

`services/runtime/src/sessionService.ts` 约 1293 行：

```ts
            ring: (toUid, reason, opening) => ringer.call(spec.agentId, specNames.get(spec.agentId) ?? spec.name, toUid, reason, opening),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/runtime/callUserTool.test.ts tests/runtime/callRinger.test.ts && npx vitest run tests/runtime/sessionService.test.ts -t "回电|客人" && npm run typecheck`
Expected: PASS；tsc 无错

- [ ] **Step 5: Commit**

```bash
git add services/runtime/src/callUserTool.ts services/runtime/src/callRinger.ts services/runtime/src/sessionService.ts tests/runtime/callUserTool.test.ts tests/runtime/callRinger.test.ts tests/runtime/sessionService.test.ts
git commit -m "feat(runtime): call_user 打电话时写好开场白，随响铃记进日志、随推送到手机（#1420）"
```

---

### Task 3: runtime —— 接通时替它说出开场白（空闲时不起模型调用）

**Files:**
- Modify: `services/runtime/src/sessionService.ts`（`setVoiceCall` 约 2664–2694 行、`greetNewcomers` 约 1498–1530 行）
- Test: `tests/runtime/sessionService.test.ts`（`describe("回电（#1411）")`，约 7337 行起）
- Create: `docs/adr/0332-回电开场白由runtime在接通时替智能体落下.md`

**Interfaces:**
- Consumes: `RingState.opening`, `callbackAnsweredText`, `callbackGreetingText(…, opening)`, `callerModelOf`（Task 1）；`Ringer.answer`（Task 2）；`openTurns`（已 import，`src/shared/turnLedger.ts`）
- Produces: 无新导出；行为变化见测试

- [ ] **Step 1: 写失败的测试**

在 `describe("回电（#1411）")` 里：

1. `OPENING` 与带开场白的 `callsBack` 在 Task 2 已经加好，直接用。

2. `open()` 的参数加 `replyAsync?: (agentId: string, round: number) => Promise<ModelReply>;`，`chat` 里改成 `return o.replyAsync ? o.replyAsync(a.agentId, rounds[a.agentId]!) : o.reply ? o.reply(a.agentId, rounds[a.agentId]!) : { content: \`${a.name}答\` };`。

3. 把现有的「接听：他发 call 帧把它带进通话 → 先名单、再接通、再回电开场白」整条**替换**为：

```ts
  it("接听、它空闲、带开场白：先名单、再接通，然后替它说出开场白并收口——不起模型调用", async () => {
    const store = newStore();
    const rounds: string[] = [];
    const session = open(store, {
      callback: fakeCallback().cb,
      reply: (id, round) => {
        rounds.push(`${id}:${round}`);
        return callsBack("部署完了")(id, round);
      },
    });
    await session.say("u1", "alice", "@运维 部署一下", true, ["ops"]);
    await session.settled();
    const roundsBefore = rounds.length;
    const before = store.load("s1").length;
    expect(await session.setVoiceCall("u1", "alice", ["ops"])).toEqual({ kind: "ok" });
    const after = store.load("s1").slice(before);
    expect(after.map((e) => e.type)).toEqual(["voice_call_changed", "call_ring", "user_message", "assistant_message", "turn_ended"]);
    expect(after[1]).toMatchObject({ phase: "answered", opening: OPENING });
    expect(after[2]).toMatchObject({ greeting: "callback", mentions: ["ops"], fromUid: "u1" });
    expect((after[2] as UserMessageEvent).content).toBe(callbackAnsweredText("运维", "alice"));
    expect(after[3]).toMatchObject({ agentId: "ops", content: OPENING, model: "m-ops" });
    expect((after[3] as { usage?: unknown }).usage).toBeUndefined();
    expect(after[4]).toMatchObject({ outcome: "completed", agentId: "ops", readUpToSeq: after[2]!.seq });
    await session.settled();
    expect(rounds.length).toBe(roundsBefore);
    expect(openTurns(store.load("s1")).some((t) => t.agentId === "ops")).toBe(false);
    store.close();
  }, TWO_TURN_SETTLE_MS);

  it("接听时它还在跑那一轮：回落——落带开场白的招呼、起一轮", async () => {
    const store = newStore();
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const session = open(store, {
      callback: fakeCallback().cb,
      replyAsync: async (id, round) => {
        if (id === "ops" && round === 2) await hold; // 打完电话之后接着干活，还没收口
        return callsBack("部署完了")(id, round);
      },
    });
    await session.say("u1", "alice", "@运维 部署一下", true, ["ops"]);
    for (let i = 0; i < 50 && !store.load("s1").some((e) => e.type === "call_ring"); i++) await new Promise((r) => setImmediate(r));
    const before = store.load("s1").length;
    expect(await session.setVoiceCall("u1", "alice", ["ops"])).toEqual({ kind: "ok" });
    const after = store.load("s1").slice(before);
    expect(after.map((e) => e.type)).toEqual(["voice_call_changed", "call_ring", "user_message"]);
    expect((after[2] as UserMessageEvent).content).toBe(callbackGreetingText("运维", "alice", "部署完了", OPENING));
    release();
    await session.settled();
    const replies = store.load("s1").slice(before).filter((e) => e.type === "assistant_message");
    expect(replies.length).toBeGreaterThan(0); // 模型接着答了那条招呼
    store.close();
  }, TWO_TURN_SETTLE_MS);

  it("旧响铃（日志里没有开场白）：照旧落改动前那句招呼、起一轮", async () => {
    const store = newStore();
    const now = Date.now();
    store.append({ sessionId: "s1", ts: now, type: "call_ring", ringId: "r0", phase: "ringing", fromAgentId: "ops", toUid: "u1", reason: "部署完了", expiresTs: now + RING_TTL_MS, ignorable: true });
    const session = open(store, { callback: fakeCallback().cb });
    const before = store.load("s1").length;
    await session.setVoiceCall("u1", "alice", ["ops"]);
    const after = store.load("s1").slice(before);
    expect(after.map((e) => e.type)).toEqual(["voice_call_changed", "call_ring", "user_message"]);
    expect((after[2] as UserMessageEvent).content).toBe(callbackGreetingText("运维", "alice", "部署完了"));
    await session.settled();
    store.close();
  }, TWO_TURN_SETTLE_MS);
```

4. 「通话本来就开着（锁屏没挂，ADR-0320）」那条：它第二轮的 toolCalls args 改成 `{ reason: "测完了", opening: OPENING }`；期望改成 `expect(after.map((e) => e.type)).toEqual(["call_ring", "user_message", "assistant_message", "turn_ended"]);`，`after[1]` 仍 `toMatchObject({ greeting: "callback" })`，再加 `expect(after[2]).toMatchObject({ agentId: "ops", content: OPENING });`。

import 补：`callbackAnsweredText` 从 `../../src/shared/callRing.js`，`openTurns` 从 `../../src/shared/turnLedger.js`（若尚未 import）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/sessionService.test.ts -t "回电"`
Expected: FAIL（接通后只有 `user_message`，没有 `assistant_message` / `turn_ended`；回落文案不含开场白）

- [ ] **Step 3: 实现**

`sessionService.ts` 顶部 import 补：`callbackAnsweredText, callerModelOf, type RingState` 从 `../../../src/shared/callRing.js`（与已有的 `callbackGreetingText, ringChatKind, type RingPush` 合并成一行）。

`setVoiceCall` 里把 `reasons` 那段换成：

```ts
      const rings = new Map<string, RingState>();
      if (ringer !== null) {
        for (const id of ids) {
          const r = ringer.answer(id, byUid);
          if (r !== null) rings.set(id, r);
        }
      }
      ...
      greetNewcomers(next.filter((p) => !current.includes(p.agentId) || rings.has(p.agentId)), byUid, budget, { byLabel, rings });
```

`greetNewcomers` 的 `callback` 参数类型改为 `{ byLabel: string; rings: ReadonlyMap<string, RingState> }`，函数体改成：

```ts
    if (added.length === 0) return;
    // 回电接通、带着开场白、这只此刻没有开着的一轮（#1420）：替它把开场白说出来，不起模型调用。
    // 「忙不忙」只看 openTurns（排着的与在跑的开场白都在日志里）：它打完电话可能还在干活，这时往日志里
    // 插一整段「说了开场白、收口」会和 engine 正在写的那一轮交叉，还会把那一轮在账本上提前收口
    let busy: Set<string> | null = null;
    const prewritten = added.filter((p) => {
      const ring = callback?.rings.get(p.agentId);
      if (ring === undefined || ring.opening === null) return false;
      busy ??= new Set(openTurns(store.load(sessionId)).map((t) => t.agentId));
      return !busy.has(p.agentId);
    });
    for (const p of prewritten) speakOpening(p, callback!.rings.get(p.agentId)!.opening!, byUid, callback!.byLabel);
    const rest = added.filter((p) => !prewritten.includes(p));
    if (rest.length === 0) return;
    const veto = budget?.(rest.length) ?? null;
    if (veto !== null) {
      logChat("system", "系统", `${veto} 刚拉进通话的 ${rest.length} 只没打招呼——@ 一下它们就会回。`, false);
      return;
    }
    const decisions = rest.map((p) => {
      const ring = callback?.rings.get(p.agentId);
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        content:
          ring !== undefined && callback !== undefined
            ? callbackGreetingText(p.name, callback.byLabel, ring.reason, ring.opening)
            : voiceCallGreetingText(p.name),
        fromUid: byUid,
        mentions: [p.agentId],
        greeting: ring !== undefined ? "callback" : "voice_call",
      }) as UserMessageEvent;
      notify(opening);
      return coordinator.enqueue({ agentId: p.agentId, fromUid: byUid, opening });
    });
    if (decisions.includes("start_turn")) startDrain();
```

（注意：替它说开场白不起模型调用、不花钱，所以不过 `budget`——`budget` 只按真要起 turn 的 `rest.length` 问价。）

在 `greetNewcomers` 上面加：

```ts
  /** 回电接通、开场白由 runtime 替它说（#1420，ADR-0332）：同步连落三条——「接通了」、它的开场白、收口。
      JS 单线程，三条之间插不进别的事件。model 取日志里写下开场白的那一次调用（assistant_message.model
      是事实）；不带 usage / route：这一条没花钱，钱在打电话那一轮算过了。readUpToSeq 取「接通了」那条的
      seq：这一「轮」看见的就是它，openTurns 据此收口，「正在回复」那盏灯不亮 */
  function speakOpening(p: VoiceCallParticipant, opening: string, byUid: string, byLabel: string): void {
    const model = callerModelOf(store.load(sessionId), p.agentId);
    const answered = store.append({
      sessionId,
      ts: Date.now(),
      type: "user_message",
      content: callbackAnsweredText(p.name, byLabel),
      fromUid: byUid,
      mentions: [p.agentId],
      greeting: "callback",
    }) as UserMessageEvent;
    notify(answered);
    notify(store.append({ sessionId, ts: Date.now(), type: "assistant_message", agentId: p.agentId, content: opening, model }));
    notify(
      store.append({ sessionId, ts: Date.now(), type: "turn_ended", outcome: "completed", agentId: p.agentId, readUpToSeq: answered.seq })
    );
  }
```

（若 `store.append` 的入参类型要求 `ignorable` 等字段或 `assistant_message` 的字面量类型推断不出，照 tsc 提示补类型断言，参照同文件里其它 `store.append({... type: "turn_ended" ...})` 的写法，约 1944 行。）

ADR：新建 `docs/adr/0332-回电开场白由runtime在接通时替智能体落下.md`（先 `ls docs/adr | tail -3` 确认 0332 未被占用，占用了就用 max+1 并同步改本计划里所有引用），内容：

```markdown
# ADR-0332：回电开场白由 runtime 在接通时替智能体落下

- 日期：2026-09-29
- 状态：已采纳
- Issue：#1420；前序 ADR-0331（智能体回电）

## 背景

真机验收时维护者问：接起智能体的回电之后它要等一会儿才说话，它为什么不想好了要说什么才打这通电话？
改动前接通后是两段串行：runtime 落一条回电招呼、起一轮模型现想，手机再把第一句合成语音。

## 决定

1. `call_user` 多一个必填参数 `opening`（≤200 字，超了拒绝不截断），打电话那一刻由模型写好，记进
   `call_ring.opening`（可选字段），随推送到手机。
2. 接通时，如果这只**此刻没有开着的一轮**（判据：`openTurns(日志)` 里没有它），runtime 同步连落三条：
   `user_message`（「电话接通了」，`greeting: "callback"`）、`assistant_message`（开场白原文）、
   `turn_ended`（`readUpToSeq` = 前一条的 seq）。不起模型调用。
   **这是仓里第一处不经 engine 写 `assistant_message` 的地方。**两条纪律：`model` 取日志里写下开场白的
   那一次调用（它打电话那条 `assistant_message` 的 `model`）——字段语义是「实际生成这条的模型」，这句话
   确实是它生成的；不带 `usage` / `route` / `creditCostMicro`——钱在打电话那一轮已经算过，再记一次就是重复计费。
3. 这只还在跑那一轮（它打完电话接着干活）：回落到改动前那条路，招呼文案里带上开场白、让它照念。只省掉
   现想，不省排队。
4. 手机在响铃期间按放音那条路同一套切句（`spokenUnits`）预合成，接通后放音器从缓存拿。

## 否决的

- **接通时让模型原样念开场白**（招呼里写「照这个说」、照样起一轮）：模型第一个 token 的延迟还在，
  而这正是要去掉的那一段。它现在只作为「这只正忙」时的回落。
- **开场白截断到 200 字**：截在半句上念出来比没有更糟。

## 代价

- 开场白是打电话那一刻写的：之后、接通之前又发生了什么，它不知道。人回话之后模型那一轮看得到全部上下文。
- 开场白随推送经过 Apple 的服务器（同锁屏那句 `reason`）。
- 没接的那一通，手机预合成的那几句照样花听的人自己的语音额度。
- 锁屏时普通推送不叫醒 App，预合成要从点开通知那一刻开始；要做到锁屏收到就合成得加 Notification Service Extension，没做。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/runtime/sessionService.test.ts -t "回电" && npx vitest run tests/docs/adrNumbers.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/runtime/src/sessionService.ts tests/runtime/sessionService.test.ts docs/adr/0332-回电开场白由runtime在接通时替智能体落下.md
git commit -m "feat(runtime): 回电接通时替智能体说出开场白，它空闲时不起模型调用（#1420，ADR-0332）"
```

---

### Task 4: shared —— 预合成缓存 `speakCache.ts`

**Files:**
- Create: `src/shared/speakCache.ts`
- Test: `tests/shared/speakCache.test.ts`

**Interfaces:**
- Consumes: `VoiceSpeakResult`（`src/shared/shellBridge.ts`）
- Produces:
  ```ts
  export type SpeakFn = (text: string, voiceId: string) => Promise<VoiceSpeakResult>;
  export interface SpeakCache {
    speak: SpeakFn;
    prefetch(texts: readonly string[], voiceId: string, untilTs: number): void;
  }
  export function createSpeakCache(inner: SpeakFn, now?: () => number): SpeakCache;
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// speakCache（#1420）：响铃时先合成开场白，接通后放音器同键直接拿。
import { describe, expect, it } from "vitest";
import type { VoiceSpeakResult } from "../../src/shared/shellBridge.js";
import { createSpeakCache } from "../../src/shared/speakCache.js";

const ok = (tag: string): VoiceSpeakResult => ({ ok: true, audio: new TextEncoder().encode(tag), costMicro: 1, audioMs: 10 });
const tagOf = (r: VoiceSpeakResult): string => (r.ok ? new TextDecoder().decode(r.audio) : `ERR:${r.message}`);

function fake(fail: (text: string, n: number) => boolean = () => false) {
  const calls: string[] = [];
  const inner = async (text: string, voiceId: string): Promise<VoiceSpeakResult> => {
    calls.push(`${voiceId}|${text}`);
    const n = calls.length;
    return fail(text, n) ? { ok: false, message: "boom" } : ok(`${voiceId}|${text}#${n}`);
  };
  return { inner, calls };
}

describe("speakCache", () => {
  it("预取过的：同键只合成一次，speak 拿到的就是预取那一份；用过一次就删", async () => {
    const f = fake();
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch(["你好。", "部署好了。"], "v1", 100);
    expect(f.calls).toEqual(["v1|你好。", "v1|部署好了。"]);
    expect(tagOf(await c.speak("你好。", "v1"))).toBe("v1|你好。#1");
    expect(f.calls).toHaveLength(2);
    expect(tagOf(await c.speak("你好。", "v1"))).toBe("v1|你好。#3");
  });

  it("没预取过的、或 voiceId 不同：原样透传", async () => {
    const f = fake();
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch(["你好。"], "v1", 100);
    expect(tagOf(await c.speak("你好。", "v2"))).toBe("v2|你好。#2");
    expect(tagOf(await c.speak("别的。", "v1"))).toBe("v1|别的。#3");
  });

  it("同一句预取两次只发一次", () => {
    const f = fake();
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch(["你好。", "你好。"], "v1", 100);
    c.prefetch(["你好。"], "v1", 100);
    expect(f.calls).toEqual(["v1|你好。"]);
  });

  it("预取失败的：speak 时重新合成，不把失败交出去", async () => {
    const f = fake((_t, n) => n === 1);
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch(["你好。"], "v1", 100);
    expect(tagOf(await c.speak("你好。", "v1"))).toBe("v1|你好。#2");
  });

  it("过了 untilTs：丢掉，speak 现合成", async () => {
    let t = 0;
    const f = fake();
    const c = createSpeakCache(f.inner, () => t);
    c.prefetch(["你好。"], "v1", 100);
    t = 101;
    expect(tagOf(await c.speak("你好。", "v1"))).toBe("v1|你好。#2");
  });

  it("inner 抛错：speak 回 ok:false（放音器那边照常报错），预取吞掉不抛", async () => {
    const c = createSpeakCache(async () => { throw new Error("net"); }, () => 0);
    expect(() => c.prefetch(["你好。"], "v1", 100)).not.toThrow();
    const r = await c.speak("别的。", "v1");
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/speakCache.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/shared/speakCache.ts`**

```ts
// speakCache —— 回电开场白的预合成（#1420，ADR-0332）。手机在响铃那几十秒里先把开场白合成好，接通后
// 放音器按同一个 (text, voiceId) 要的时候直接拿。只对预取过的键起作用，别的原样透传。
//
// 三条规矩：用过一次就删（同一句不会念两遍，留着只是占内存）；预取失败的不交出去（speak 时重新合成——
// 预取是锦上添花，不该让一次失败变成接通后那句话念不出来）；过了 untilTs 就丢（没人接的那一通）。
import type { VoiceSpeakResult } from "./shellBridge.js";

export type SpeakFn = (text: string, voiceId: string) => Promise<VoiceSpeakResult>;

export interface SpeakCache {
  speak: SpeakFn;
  /** 预合成这几句。untilTs 之后没被用掉就丢 */
  prefetch(texts: readonly string[], voiceId: string, untilTs: number): void;
}

const keyOf = (text: string, voiceId: string): string => `${voiceId}\n${text}`;

export function createSpeakCache(inner: SpeakFn, now: () => number = Date.now): SpeakCache {
  const entries = new Map<string, { p: Promise<VoiceSpeakResult>; until: number }>();
  const safe = (text: string, voiceId: string): Promise<VoiceSpeakResult> =>
    inner(text, voiceId).catch((err: unknown): VoiceSpeakResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  const sweep = (): void => {
    const t = now();
    for (const [k, v] of entries) if (v.until < t) entries.delete(k);
  };
  return {
    speak(text, voiceId) {
      sweep();
      const k = keyOf(text, voiceId);
      const hit = entries.get(k);
      if (hit === undefined) return safe(text, voiceId);
      entries.delete(k);
      return hit.p.then((r) => (r.ok ? r : safe(text, voiceId)));
    },
    prefetch(texts, voiceId, untilTs) {
      sweep();
      for (const text of texts) {
        const k = keyOf(text, voiceId);
        if (entries.has(k)) continue;
        entries.set(k, { p: safe(text, voiceId), until: untilTs });
      }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/speakCache.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/speakCache.ts tests/shared/speakCache.test.ts
git commit -m "feat(shared): 预合成缓存——响铃时先合成开场白，接通后同键直接拿（#1420）"
```

---

### Task 5: shared —— `voiceSession.join` 补读「加入之前已经落下来」的那几条

**为什么：** 手机 `startCall` 是「发 `call` 帧 → 等回执 → `join`」，而 runtime 先落事件、广播，再回回执——事件先到。`join` 把 `sinceSeq` 设成此刻日志尾，于是回执之前就到了的那条开场白被当成历史、一个字都不念。改动前招呼要等模型想好几秒才到，碰不上；#1420 之后开场白与 `call_ring answered` 同一刻落下，必然碰上。

**Files:**
- Modify: `src/shared/voiceSession.ts`
- Test: `tests/shared/voiceSession.test.ts`

**Interfaces:**
- Produces: `VoiceSession.join(sessionId: string, sinceSeq?: number): void` —— 给了 `sinceSeq`：`listen.sinceSeq = min(sinceSeq, 日志尾)`，并把 `(sinceSeq, 日志尾]` 那几条当场喂一遍；不给：行为与改动前逐字相同

- [ ] **Step 1: 写失败的测试**

在 `tests/shared/voiceSession.test.ts` 的 `describe("voiceSession")` 里追加：

```ts
  it("join 给了发帧之前的日志尾：那之后、加入之前已经落下来的话照读（#1420 回电开场白先于回执到）", async () => {
    const h = harness({ events: [callOn(1, ["a"]), reply(2, "a", "开场白。"), ended(3, "a")] });
    h.v.join(S, 0);
    await flush();
    expect(h.v.state()?.sinceSeq).toBe(0);
    expect(h.spoke.map((s) => s.text)).toEqual(["开场白。"]);
  });

  it("join 不给 sinceSeq：照旧只读之后的", async () => {
    const h = harness({ events: [callOn(1, ["a"]), reply(2, "a", "旧话。")] });
    h.v.join(S);
    await flush();
    expect(h.spoke).toEqual([]);
  });

  it("join 给的 sinceSeq 比日志尾还大：按日志尾算", () => {
    const h = harness({ events: [callOn(1, ["a"])] });
    h.v.join(S, 99);
    expect(h.v.state()?.sinceSeq).toBe(1);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/voiceSession.test.ts`
Expected: FAIL（第一条 spoke 为空、sinceSeq 为 3）

- [ ] **Step 3: 实现**

`VoiceSession` 接口：`join(sessionId: string, sinceSeq?: number): void;`，注释补：「`sinceSeq` = 调用方发帧之前记下的日志尾：发帧之后、加入之前就已经落下来的那几条（回电接通时开场白与回执同时出发、先到）当场补读（#1420）」。

把 `onEvent` 的函数体提成闭包里的 `const feedOne = (e: SessionEvent): void => { ...原 onEvent 体... };`，返回对象里 `onEvent: feedOne,`（或 `onEvent(e) { feedOne(e); }`）。

`join` 改成：

```ts
    join(sessionId, sinceSeq) {
      const events = deps.events(sessionId);
      if (events === null) return;
      stopAll();
      const tail = events.at(-1)?.seq ?? -1;
      const since = sinceSeq === undefined ? tail : Math.min(sinceSeq, tail);
      set({
        sessionId, sinceSeq: since,
        speaking: null, queued: 0, text: null, error: null,
        mic: micStarting(),
      });
      // 常开麦（#1176）：进通话就开
      startMic();
      for (const e of events) if (e.seq > since) feedOne(e);
    },
```

（`SessionEvent` 已在该文件 import 则直接用；否则从 `../session/events.js` 补 `import type`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/voiceSession.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/voiceSession.ts tests/shared/voiceSession.test.ts
git commit -m "fix(shared): 加入通话时补读回执之前就到了的那几条——回电开场白与回执同时出发、先到（#1420）"
```

---

### Task 6: 手机接线 —— 缓存包 TTS、来电入队预取、发帧前记下日志尾

**Files:**
- Modify: `mobile/src/voice/voiceStore.ts`
- Modify: `mobile/src/call/ringStore.ts`

**Interfaces:**
- Consumes: `createSpeakCache`（Task 4）、`spokenUnits`（Task 1）、`agentVoiceId`（`src/shared/agentVoice.ts`）、`join(sessionId, sinceSeq)`（Task 5）、`RingPush.opening`、`RING_ANSWER_GRACE_MS`（`src/shared/callRing.ts`）
- Produces: `voiceStore.prefetchOpening(agentId: string, opening: string, untilTs: number): void`

- [ ] **Step 1: 改 `voiceStore.ts`**

1. import 补：`createSpeakCache` 从 `../../../src/shared/speakCache.js`；`spokenUnits` 从 `../../../src/shared/voiceFeed.js`；`agentVoiceId` 从 `../../../src/shared/agentVoice.js`（已 import 的合并）。
2. 在 `createVoiceSession(...)` 之前加：

```ts
/** 音色按名册顺序解撞（#1372）。预合成与放音必须用同一份，否则键对不上（#1420） */
const voiceRoster = () => homeSnapshot().home?.agents ?? [];
/** 回电开场白的预合成（#1420）：通话与试听都走它；只对预取过的句子起作用 */
const speech = createSpeakCache((text, voiceId) => tts.speak(text, voiceId));
```

3. `createVoiceSession` 里 `speak: (text, voiceId) => tts.speak(text, voiceId),` 改成 `speak: speech.speak,`；`roster: () => homeSnapshot().home?.agents ?? [],` 改成 `roster: voiceRoster,`（保留原注释）。
4. `startCall` 改成：

```ts
export async function startCall(sessionId: string, agentIds: string[]): Promise<CloudAck> {
  // 发帧之前记下日志尾（#1420）：runtime 先落事件再回回执，回电接通时开场白比回执先到——
  // 等回执之后才按「此刻的日志尾」加入，那句话就被当成历史不念了
  const sinceSeq = chatEvents(sessionId)?.at(-1)?.seq ?? -1;
  const r = await setVoiceCall(agentIds);
  if (r.ok) session.join(sessionId, sinceSeq);
  return r;
}
```

（`chatEvents` 是这个文件里 `events:` 那一格已经在用的函数，照用。）

5. 文件末尾加：

```ts
/** 来电响铃时先把开场白合成好（#1420）：切句与音色都走接通后放音那条路同一套，接起来直接从缓存拿 */
export function prefetchOpening(agentId: string, opening: string, untilTs: number): void {
  const texts = spokenUnits(opening);
  if (texts.length === 0) return;
  speech.prefetch(texts, agentVoiceId(agentId, voiceRoster()), untilTs);
}
```

- [ ] **Step 2: 改 `ringStore.ts`**

import 补：`RING_ANSWER_GRACE_MS` 合进已有的 `../../../src/shared/callRing.js` import；`import { prefetchOpening } from "../voice/voiceStore.js";`（先 `grep -n "ringStore" mobile/src/voice/voiceStore.ts` 确认 voiceStore 不反向 import ringStore，避免循环依赖；若有循环，把 `prefetchOpening` 挪到新文件 `mobile/src/voice/prefetch.ts`，由 voiceStore 导出 `speech` / `voiceRoster` 给它用）。

`enqueue` 改成：

```ts
function enqueue(ring: RingPush, noticeId: string): void {
  if (handled.has(ring.ringId)) return;
  noticeOf.set(ring.ringId, noticeId);
  // 响铃这几十秒先把开场白合成好（#1420）：前台收到、点通知进来、冷启动那一条都经过这里
  if (ring.opening !== undefined) prefetchOpening(ring.agentId, ring.opening, ring.expiresTs + RING_ANSWER_GRACE_MS);
  store.set((s) => ({ ...s, queue: queueRing(s.queue, ring, Date.now()) }));
}
```

文件头注释补一句：「来电入队时顺手预合成开场白（#1420），接起来立刻出声」。

- [ ] **Step 3: 类型检查**

Run: `npm --prefix mobile run typecheck`
Expected: 无错（先 `grep -n '"typecheck"\|"tsc"' mobile/package.json` 看手机端的类型检查脚本名；根目录 `npm test` 的第二段就是它）

- [ ] **Step 4: Commit**

```bash
git add mobile/src/voice/voiceStore.ts mobile/src/call/ringStore.ts
git commit -m "feat(mobile): 来电响铃时预合成开场白；加入通话按发帧前的日志尾补读（#1420）"
```

---

### Task 7: 收尾 —— 索引、spec 回写、门禁

**Files:**
- Modify: `AGENTS.md`（Where to find things 里 #1411 那一条之后加一行）
- Modify: `docs/superpowers/specs/2026-09-29-callback-opening-design.md`（§2.2 补 join 时序那一条）

- [ ] **Step 1: AGENTS.md 索引**

在「`src/shared/callRing.ts` / `services/runtime/src/callRinger.ts` …智能体回电（ADR-0331，#1411）」那一条**之后**另起一条：

```markdown
- `src/shared/speakCache.ts` / `sessionService.ts` 的 `speakOpening` / `voiceSession.join(sessionId, sinceSeq)` — **回电接通就开口**（ADR-0332，#1420）：`call_user` 打电话时写好 `opening`（≤200 字，超了拒绝不截断），随 `call_ring` 与推送走。接通时这只**空闲**（`openTurns` 里没有它）→ runtime 同步落「接通了 + 开场白 + 收口」三条、不起模型调用，这是仓里第一处不经 engine 写 `assistant_message`：`model` 取它打电话那一次调用、不带 usage（钱已算过）；**忙**（打完电话还在干活）→ 回落老路、招呼里带上开场白。手机来电入队时按 `spokenUnits`（与放音逐字同一套切句）预合成，键 = (text, voiceId)。**加入通话要带发帧前的日志尾**：runtime 先广播事件再回回执，开场白比回执先到，按回执那一刻的日志尾加入就会把它当历史不念。锁屏那条路要从点开通知才开始合成（没做 Notification Service Extension）。**要重新部署 runtime**（#791）
```

- [ ] **Step 2: spec 回写**

在 spec §2.2 末尾加一条：

```markdown
- **加入通话按发帧前的日志尾**（实现时发现的）：`startCall` 原来是「发帧 → 等回执 → `join`」，`join` 取此刻日志尾当 `sinceSeq`；runtime 先落事件、广播，再回回执，于是开场白先于回执到、被当成历史不念。改成发帧前记下日志尾、`join(sessionId, sinceSeq)` 补读中间那几条（`voiceSession.ts`）。
```

- [ ] **Step 3: 门禁**

Run: `npm test`
Expected: `tsc` 两段通过、vitest 全绿

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-09-29-callback-opening-design.md
git commit -m "docs: 回电开场白的索引与 spec 回写（#1420）"
```
