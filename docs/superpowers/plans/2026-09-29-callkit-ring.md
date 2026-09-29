# 智能体回电改成 CallKit + VoIP 推送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 智能体回电在 iPhone 上变成系统来电（CallKit），锁屏无论如何在手机上响铃震动，锁着屏接听直接通话。

**Architecture:** runtime 改发 VoIP 推送（令牌表加 `kind`）；手机新写原生模块 `otto-call`（PushKit 注册 + CXProvider），事件经 shared 的纯状态机 `callKitBridge` 接到现有 ringStore / 语音层；otto-speech 在系统来电期间让出音频会话；系统来电期间不因切后台断房间、停听。

**Tech Stack:** TypeScript strict（exactOptionalPropertyTypes）、vitest、Postgres migration、Swift（Expo Modules，PushKit / CallKit / AVFoundation）、Expo SDK 57。

**Spec:** `docs/superpowers/specs/2026-09-29-callkit-ring-design.md`

## Global Constraints

- VoIP 推送头逐字：`apns-push-type: voip`、`apns-topic: <bundleId>.voip`、`apns-priority: 10`、`apns-expiration: 0`；不带 `apns-collapse-id`。载荷 `{ ring }`，不带 `aps`。
- 令牌种类只有 `'alert'` 与 `'voip'`；runtime 只给 `kind = 'voip'` 发。
- iOS 规定：每一条 VoIP 推送都必须在推送回调里同步 `reportNewIncomingCall`——解析失败 / 已过期 / 重复的也要报，报完立刻结束。
- CallKit 音频会话 category 逐字与 otto-speech 相同：`.playAndRecord`、mode `.default`、options `[.defaultToSpeaker, .allowBluetoothA2DP]`；otto-call 不 `setActive`。
- `includesCallsInRecents = false`；`ringtoneSound = "ringtone.caf"`；`maximumCallsPerCallGroup = 1`、`maximumCallGroups = 1`、`supportsVideo = false`、`supportedHandleTypes = [.generic]`。
- 测试放 `tests/`，镜像 `src/`。注释中文、说为什么，匹配周围代码的密度。
- 门禁：`npm test`（根 tsc、mobile tsc、vitest）。原生 Swift 不在门禁里，只能真机编译验证。
- migration 只写文件、不跑生产库（跑库要维护者在会话里明说）。
- 每个 commit message 末尾 `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`。
- 绝不用 `git stash`；只改 worktree 里的文件。

---

### Task 1: migration 0047 —— 令牌分两种

**Files:**
- Create: `supabase/migrations/0047_push_devices_kind.sql`
- Modify: `tests/docs/pushDevicesMigration.test.ts`（末尾加一个 describe）

**Interfaces:**
- Produces: RPC `register_push_device(p_token text, p_bundle text, p_kind text default 'alert')`；列 `push_devices.kind`（Task 2 的查询用）。

- [ ] **Step 1: 写失败的测试** —— 在 `tests/docs/pushDevicesMigration.test.ts` 末尾追加：

```ts
describe("0047_push_devices_kind（#1428）", () => {
  const src = readFileSync(new URL("../../supabase/migrations/0047_push_devices_kind.sql", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  it("kind 列：默认 alert（存量行都是普通令牌），只收 alert / voip", () => {
    expect(src).toMatch(/add column if not exists kind text not null default 'alert'/);
    expect(src).toMatch(/check \(kind in \('alert', 'voip'\)\)/);
  });
  it("旧的两参版先删掉再建三参版（重载按签名区分，不删就是两份并存）", () => {
    const drop = src.indexOf("drop function if exists public.register_push_device(text, text)");
    expect(drop).toBeGreaterThan(-1);
    expect(src.indexOf("create or replace function public.register_push_device(p_token text, p_bundle text, p_kind text default 'alert')")).toBeGreaterThan(drop);
  });
  it("三参版保留 0046 的每一条不变量，并校验 kind、upsert 时一起写", () => {
    expect(src).toMatch(/security definer set search_path = public/);
    expect(src).toMatch(/length\(p_token\) not between 16 and 256/);
    expect(src).toMatch(/p_kind not in \('alert', 'voip'\)/);
    const del = src.indexOf("delete from push_devices where token = p_token and user_id <> auth.uid()");
    expect(del).toBeGreaterThan(-1);
    expect(src.indexOf("insert into push_devices")).toBeGreaterThan(del);
    expect(src).toMatch(/on conflict \(token\) do update set bundle_id = excluded\.bundle_id, kind = excluded\.kind, updated_at = now\(\)/);
  });
  it("三参版只给 authenticated", () => {
    expect(src).toMatch(/revoke all on function public\.register_push_device\(text, text, text\) from public/);
    expect(src).toMatch(/grant execute on function public\.register_push_device\(text, text, text\) to authenticated/);
  });
});
```

- [ ] **Step 2: 跑测试看它失败** — `npx vitest run tests/docs/pushDevicesMigration.test.ts`，预期 FAIL（文件不存在）。

- [ ] **Step 3: 写 migration** `supabase/migrations/0047_push_devices_kind.sql`：

```sql
-- 0047_push_devices_kind.sql —— 推送令牌分两种：普通通知（alert）与 VoIP（voip）（#1428）。
-- 智能体回电改走 CallKit + VoIP 推送：普通通知 iOS 会路由到正在用的设备（开着 iPhone 镜像的 Mac、手表），
-- 保证不了在手机上响。VoIP 令牌由 PushKit 给，与普通推送令牌不是同一个，所以同一张表加一列说它是哪一种；
-- runtime 只给 voip 发。存量行都是普通令牌，默认值 'alert' 恰好对。
-- 可重复执行（if not exists / 约束先查再加 / drop if exists + create or replace + 重发 revoke/grant）。

alter table public.push_devices add column if not exists kind text not null default 'alert';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'push_devices_kind_check') then
    alter table public.push_devices add constraint push_devices_kind_check check (kind in ('alert', 'voip'));
  end if;
end $$;

-- 旧的两参版要先删：Postgres 按签名区分重载，不删就是两份函数并存，旧客户端调到的还是不写 kind 的那份
drop function if exists public.register_push_device(text, text);

create or replace function public.register_push_device(p_token text, p_bundle text, p_kind text default 'alert') returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]+$' or length(p_token) not between 16 and 256 then
    raise exception 'bad token';
  end if;
  if p_bundle is null or length(p_bundle) = 0 or length(p_bundle) > 200 then raise exception 'bad bundle'; end if;
  if p_kind is null or p_kind not in ('alert', 'voip') then raise exception 'bad kind'; end if;
  delete from push_devices where token = p_token and user_id <> auth.uid();
  insert into push_devices (token, user_id, platform, bundle_id, apns_env, kind, updated_at)
  values (p_token, auth.uid(), 'ios', p_bundle, null, p_kind, now())
  on conflict (token) do update set bundle_id = excluded.bundle_id, kind = excluded.kind, updated_at = now();
end $$;
revoke all on function public.register_push_device(text, text, text) from public;
grant execute on function public.register_push_device(text, text, text) to authenticated;
```

- [ ] **Step 4: 跑测试看它通过** — `npx vitest run tests/docs/pushDevicesMigration.test.ts tests/docs/migrationRegexBounds.test.ts tests/docs/migrationNumbers.test.ts`，预期 PASS。

- [ ] **Step 5: 提交** — `git add supabase/migrations/0047_push_devices_kind.sql tests/docs/pushDevicesMigration.test.ts`，`git commit -m "feat(db): 推送令牌分 alert / voip 两种（#1428）"`（加 Co-Authored-By 段）。

---

### Task 2: runtime 改发 VoIP 推送

**Files:**
- Modify: `services/runtime/src/apns.ts`
- Modify: `services/runtime/src/pushDevices.ts`
- Modify: `tests/runtime/apns.test.ts`
- Modify: `tests/runtime/pushDevices.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `push_devices.kind`。
- Produces: `ringVoipPayload(ring: RingPush): { ring: RingPush }`；`ringHeaders(bundleId: string, jwt: string): Record<string, string>`（去掉原来的第一个参数 `ring`）。`ringNotification` 与 `RING_SOUND` 删除。

- [ ] **Step 1: 改测试** —— `tests/runtime/apns.test.ts`：
  - import 里把 `ringNotification` 换成 `ringVoipPayload`。
  - 「载荷与请求头」那个 describe 的两条用例换成：

```ts
  it("载荷只有 ring：VoIP 推送不展示，界面由 CallKit 画（#1428）", () => {
    expect(ringVoipPayload(RING)).toEqual({ ring: RING });
  });
  it("头：voip、topic = bundle.voip、立即送、不存（过期的 VoIP 推送只会变成一通立刻挂掉的来电）、不合并", () => {
    expect(ringHeaders("com.stanyan.mrotto.mobile", "JWT")).toEqual({
      authorization: "bearer JWT",
      "apns-topic": "com.stanyan.mrotto.mobile.voip",
      "apns-push-type": "voip",
      "apns-priority": "10",
      "apns-expiration": "0",
    });
  });
```
  - 文件里其余用到 `ringNotification(RING)` 的断言（约第 104 行）改成 `ringVoipPayload(RING)`；用到 `ringHeaders(RING, …)` 的改成 `ringHeaders(…)`（去掉第一个参数）。

  `tests/runtime/pushDevices.test.ts` 的 list 用例：`f.calls` 期望末尾加一项 `["eq", "kind", "voip"]`，用例标题改成「list：只取这个人、这个 bundle 的 VoIP 令牌；认不出的环境当没记过」。

- [ ] **Step 2: 跑测试看它失败** — `npx vitest run tests/runtime/apns.test.ts tests/runtime/pushDevices.test.ts`。

- [ ] **Step 3: 改实现**
  - `apns.ts`：
    - 文件头注释第一行改成「回电的推送：runtime 直发 APNs 的 VoIP 推送（#1411 → #1428，ADR-0331 → 本条 ADR）」，并加一句：普通通知会被 iOS 路由到正在用的设备（开着 iPhone 镜像的 Mac、手表），保证不了在手机上响；VoIP 推送叫起 App、由 CallKit 画系统来电。
    - 删掉 `RING_SOUND` 与 `ringNotification`，换成：

```ts
/** VoIP 推送的载荷：只有 ring。VoIP 推送不展示（没有 aps），手机的 otto-call 收到后当场报给 CallKit，
    系统来电界面上的名字取 ring.agentName */
export function ringVoipPayload(ring: RingPush): { ring: RingPush } {
  return { ring };
}

/** 请求头。topic 是 `<bundle>.voip`（VoIP 推送的规矩）；`apns-expiration: 0` = 送不到就作废：过了时限才到的
    VoIP 推送手机也必须报来电（iOS 13 起的硬规定），只会变成一通立刻挂掉的来电。VoIP 推送不支持合并，不带
    collapse-id */
export function ringHeaders(bundleId: string, jwt: string): Record<string, string> {
  return {
    authorization: `bearer ${jwt}`,
    "apns-topic": `${bundleId}.voip`,
    "apns-push-type": "voip",
    "apns-priority": "10",
    "apns-expiration": "0",
  };
}
```
    - `sendOne` 里：`const body = JSON.stringify(ringVoipPayload(ring));`，`ringHeaders(o.key.bundleId, tokenNow())`。
    - 全仓 `grep -rn "RING_SOUND\|ringNotification" services src tests` 确认没有别的引用。
  - `pushDevices.ts`：`list` 的查询链末尾加 `.eq("kind", "voip")`，文件头注释补一句「只取 VoIP 令牌（#1428）：普通令牌留在表里，不再给它们发」。

- [ ] **Step 4: 跑测试看它通过** — `npx vitest run tests/runtime/apns.test.ts tests/runtime/pushDevices.test.ts tests/runtime/callRinger.test.ts`，然后 `npx tsc --noEmit -p .`。

- [ ] **Step 5: 提交** — `git add services/runtime/src/apns.ts services/runtime/src/pushDevices.ts tests/runtime/apns.test.ts tests/runtime/pushDevices.test.ts`，`git commit -m "feat(runtime): 回电改发 VoIP 推送、只给 voip 令牌发（#1428）"`。

---

### Task 3: shared 纯逻辑 `callKitBridge.ts`

**Files:**
- Create: `src/shared/callKitBridge.ts`
- Test: `tests/shared/callKitBridge.test.ts`

**Interfaces:**
- Consumes: `ringFromPayload`, `RingPush`（`src/shared/callRing.ts`）。
- Produces（Task 6 用）：`CallKitEvent`、`callKitEventOf(raw: unknown): CallKitEvent | null`、`SystemCall`、`CallKitState`、`CALLKIT_IDLE`、`reduceCallKit(s, e): CallKitState`、`inSystemCall(s): boolean`、`systemAudioReady(s, ringId): boolean`、`onVoiceCall(s, sessionId, open): { state: CallKitState; ended: string[] }`。

- [ ] **Step 1: 写失败的测试** `tests/shared/callKitBridge.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  CALLKIT_IDLE, callKitEventOf, inSystemCall, onVoiceCall, reduceCallKit, systemAudioReady, type CallKitState,
} from "../../src/shared/callKitBridge.js";
import type { RingPush } from "../../src/shared/callRing.js";

const RING: RingPush = {
  ringId: "r1", workspaceId: "w1", sessionId: "s1", agentId: "a1", agentName: "运维",
  reason: "部署完了", chat: "dm", expiresTs: 1_700_000_045_000,
};
const incoming = (ring: RingPush = RING) => ({ type: "incoming" as const, ring });
const run = (...events: Parameters<typeof reduceCallKit>[1][]): CallKitState => events.reduce(reduceCallKit, CALLKIT_IDLE);

describe("callKitEventOf：原生发上来的东西不信", () => {
  it("六种事件各认一遍", () => {
    expect(callKitEventOf({ type: "token", token: "ab" })).toEqual({ type: "token", token: "ab" });
    expect(callKitEventOf({ type: "incoming", ring: RING })).toEqual({ type: "incoming", ring: RING });
    expect(callKitEventOf({ type: "answer", ringId: "r1" })).toEqual({ type: "answer", ringId: "r1" });
    expect(callKitEventOf({ type: "end", ringId: "r1", answered: false, reason: "user" }))
      .toEqual({ type: "end", ringId: "r1", answered: false, reason: "user" });
    expect(callKitEventOf({ type: "mute", ringId: "r1", muted: true })).toEqual({ type: "mute", ringId: "r1", muted: true });
    expect(callKitEventOf({ type: "audio", active: true })).toEqual({ type: "audio", active: true });
  });
  it("缺字段 / 类型不对 / 认不出的 type / ring 验不过 → null", () => {
    expect(callKitEventOf(null)).toBeNull();
    expect(callKitEventOf({ type: "token", token: "" })).toBeNull();
    expect(callKitEventOf({ type: "incoming", ring: { ...RING, ringId: 3 } })).toBeNull();
    expect(callKitEventOf({ type: "answer" })).toBeNull();
    expect(callKitEventOf({ type: "end", ringId: "r1", answered: "no", reason: "user" })).toBeNull();
    expect(callKitEventOf({ type: "end", ringId: "r1", answered: false, reason: "whatever" })).toBeNull();
    expect(callKitEventOf({ type: "audio", active: 1 })).toBeNull();
    expect(callKitEventOf({ type: "hello" })).toBeNull();
  });
});

describe("reduceCallKit", () => {
  it("来电 → 接听：算系统来电进行中；音频交过来之前还不能开麦", () => {
    const s = run(incoming(), { type: "answer", ringId: "r1" });
    expect(inSystemCall(s)).toBe(true);
    expect(systemAudioReady(s, "r1")).toBe(false);
    const t = reduceCallKit(s, { type: "audio", active: true });
    expect(systemAudioReady(t, "r1")).toBe(true);
    expect(systemAudioReady(t, "other")).toBe(false);
  });
  it("只在响、没接：不算进行中", () => {
    expect(inSystemCall(run(incoming()))).toBe(false);
  });
  it("同一通重复来：不覆盖（已接的那通不能被一条重投的推送打回「在响」）", () => {
    const s = run(incoming(), { type: "answer", ringId: "r1" }, incoming());
    expect(s.calls.get("r1")?.answered).toBe(true);
  });
  it("结束：从账上拿掉；一通都不剩时音频也归零", () => {
    const s = run(incoming(), { type: "answer", ringId: "r1" }, { type: "audio", active: true },
      { type: "end", ringId: "r1", answered: true, reason: "user" });
    expect(s.calls.size).toBe(0);
    expect(s.audioActive).toBe(false);
    expect(inSystemCall(s)).toBe(false);
  });
  it("不认识的 ringId：原样返回同一个对象", () => {
    const s = run(incoming());
    expect(reduceCallKit(s, { type: "answer", ringId: "nope" })).toBe(s);
    expect(reduceCallKit(s, { type: "end", ringId: "nope", answered: false, reason: "user" })).toBe(s);
  });
});

describe("onVoiceCall：App 这边的通话结束了，系统来电跟着结束", () => {
  const answered = run(incoming(), { type: "answer", ringId: "r1" });
  it("还没见过通话开起来：关着不算结束（房间刚连上、还没拉进通话）", () => {
    const r = onVoiceCall(answered, "s1", false);
    expect(r.ended).toEqual([]);
    expect(r.state).toBe(answered);
  });
  it("开起来过、之后关了 → 结束这一通并从账上拿掉", () => {
    const opened = onVoiceCall(answered, "s1", true).state;
    expect(opened.calls.get("r1")?.sawVoiceCall).toBe(true);
    const r = onVoiceCall(opened, "s1", false);
    expect(r.ended).toEqual(["r1"]);
    expect(r.state.calls.size).toBe(0);
  });
  it("别的会话、没接的来电：不管", () => {
    expect(onVoiceCall(answered, "other", false).ended).toEqual([]);
    const ringing = run(incoming());
    expect(onVoiceCall(onVoiceCall(ringing, "s1", true).state, "s1", false).ended).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试看它失败** — `npx vitest run tests/shared/callKitBridge.test.ts`。

- [ ] **Step 3: 写实现** `src/shared/callKitBridge.ts`：

```ts
// 系统来电（CallKit）那一层的纯逻辑（#1428，spec §3）：原生模块 otto-call 发上来的事件怎么认、这几通来电此刻
// 在什么状态。手机端的接线（callKit.ts）只做 IO 与分发，判据都在这里，进得了 vitest。
//
// 三个判据有消费方：
// · inSystemCall —— 有一通已经接起来还没结束。期间切后台不断会话房、不停听（修订 ADR-0320），otto-speech
//   不自己开关音频会话（交给 CallKit）；
// · systemAudioReady —— 这一通接起来了、而且系统已经把音频会话交过来（didActivate）。之前开麦会和 CallKit
//   抢会话，所以聊天页等它才把这只拉进通话；
// · onVoiceCall —— App 这边的通话结束了（名单清空：在 App 里挂断、或别处结束），系统来电界面跟着收掉。
//   「没见过通话开起来」时的关着不算结束：房间刚连上、还没拉进通话的那几秒通话本来就是关着的。
import { ringFromPayload, type RingPush } from "./callRing.js";

export type CallKitEvent =
  | { type: "token"; token: string }
  | { type: "incoming"; ring: RingPush }
  | { type: "answer"; ringId: string }
  | { type: "end"; ringId: string; answered: boolean; reason: "user" | "missed" | "reset" }
  | { type: "mute"; ringId: string; muted: boolean }
  | { type: "audio"; active: boolean };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** 原生发上来的一条事件 → 认得出的形状；任何一处不对回 null（丢掉这一条） */
export function callKitEventOf(raw: unknown): CallKitEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "token":
      return nonEmpty(r.token) ? { type: "token", token: r.token } : null;
    case "incoming": {
      const ring = ringFromPayload({ ring: r.ring });
      return ring === null ? null : { type: "incoming", ring };
    }
    case "answer":
      return nonEmpty(r.ringId) ? { type: "answer", ringId: r.ringId } : null;
    case "end":
      return nonEmpty(r.ringId) && typeof r.answered === "boolean" && (r.reason === "user" || r.reason === "missed" || r.reason === "reset")
        ? { type: "end", ringId: r.ringId, answered: r.answered, reason: r.reason }
        : null;
    case "mute":
      return nonEmpty(r.ringId) && typeof r.muted === "boolean" ? { type: "mute", ringId: r.ringId, muted: r.muted } : null;
    case "audio":
      return typeof r.active === "boolean" ? { type: "audio", active: r.active } : null;
    default:
      return null;
  }
}

export interface SystemCall {
  ring: RingPush;
  answered: boolean;
  /** App 这边的通话开起来过没有（onVoiceCall 用） */
  sawVoiceCall: boolean;
}

export interface CallKitState {
  /** ringId → 这一通。结束了就拿掉 */
  calls: ReadonlyMap<string, SystemCall>;
  /** 系统此刻把音频会话交给我们了没有（didActivate / didDeactivate） */
  audioActive: boolean;
}

export const CALLKIT_IDLE: CallKitState = { calls: new Map(), audioActive: false };

export function reduceCallKit(s: CallKitState, e: CallKitEvent): CallKitState {
  switch (e.type) {
    case "incoming": {
      // 推送不保证只到一次：同一通再来，不能把已经接起来的那通打回「在响」
      if (s.calls.has(e.ring.ringId)) return s;
      const calls = new Map(s.calls);
      calls.set(e.ring.ringId, { ring: e.ring, answered: false, sawVoiceCall: false });
      return { ...s, calls };
    }
    case "answer": {
      const c = s.calls.get(e.ringId);
      if (c === undefined || c.answered) return s;
      const calls = new Map(s.calls);
      calls.set(e.ringId, { ...c, answered: true });
      return { ...s, calls };
    }
    case "end": {
      if (!s.calls.has(e.ringId)) return s;
      const calls = new Map(s.calls);
      calls.delete(e.ringId);
      return { calls, audioActive: calls.size === 0 ? false : s.audioActive };
    }
    case "audio":
      return s.audioActive === e.active ? s : { ...s, audioActive: e.active };
    default:
      return s;
  }
}

export function inSystemCall(s: CallKitState): boolean {
  for (const c of s.calls.values()) if (c.answered) return true;
  return false;
}

export function systemAudioReady(s: CallKitState, ringId: string): boolean {
  return s.calls.get(ringId)?.answered === true && s.audioActive;
}

/** 这条会话的通话此刻开没开着 → 哪几通系统来电该收掉（回 ringId，并已从账上拿掉） */
export function onVoiceCall(s: CallKitState, sessionId: string, open: boolean): { state: CallKitState; ended: string[] } {
  let calls: Map<string, SystemCall> | null = null;
  const ended: string[] = [];
  for (const [ringId, c] of s.calls) {
    if (!c.answered || c.ring.sessionId !== sessionId) continue;
    if (open && !c.sawVoiceCall) {
      calls ??= new Map(s.calls);
      calls.set(ringId, { ...c, sawVoiceCall: true });
    } else if (!open && c.sawVoiceCall) {
      calls ??= new Map(s.calls);
      calls.delete(ringId);
      ended.push(ringId);
    }
  }
  if (calls === null) return { state: s, ended };
  return { state: { calls, audioActive: calls.size === 0 ? false : s.audioActive }, ended };
}
```

- [ ] **Step 4: 跑测试看它通过** — `npx vitest run tests/shared/callKitBridge.test.ts`，`npx tsc --noEmit -p .`。

- [ ] **Step 5: 提交** — `git add src/shared/callKitBridge.ts tests/shared/callKitBridge.test.ts`，`git commit -m "feat(shared): 系统来电的事件校验与状态机（#1428）"`。

---

### Task 4: 原生模块 `otto-call`（PushKit + CallKit）

**Files:**
- Create: `mobile/modules/otto-call/expo-module.config.json`
- Create: `mobile/modules/otto-call/index.ts`
- Create: `mobile/modules/otto-call/ios/OttoCall.podspec`
- Create: `mobile/modules/otto-call/ios/OttoCallModule.swift`
- Create: `mobile/modules/otto-call/ios/OttoCallAppDelegate.swift`
- Create: `mobile/modules/otto-call/ios/CallCenter.swift`

**Interfaces:**
- Produces（Task 6 用，JS 侧）：`OttoCall: OttoCallModule | null`，方法 `getVoipToken(): string | null`、`endCall(ringId: string): Promise<void>`；事件 `onCall`，负载是 Task 3 `callKitEventOf` 认的六种对象（带 `type` 字段）。

Swift 不在门禁里（门禁只跑 TS），这一步的验证是 `npx tsc --noEmit -p mobile`（index.ts）+ 读自己的 diff；真机编译在收尾时统一做。

- [ ] **Step 1: 配置与 JS 壳**

`mobile/modules/otto-call/expo-module.config.json`：

```json
{
  "platforms": ["apple"],
  "apple": {
    "modules": ["OttoCallModule"],
    "appDelegateSubscribers": ["OttoCallAppDelegate"]
  }
}
```

`mobile/modules/otto-call/index.ts`：

```ts
// 系统来电的原生模块（#1428，spec §2）的 JS 一侧：PushKit 的 VoIP 令牌 + CallKit 的来电界面，Swift 在 ios/。
//
// **Expo Go 里没有它**（同 otto-speech）：requireOptionalNativeModule 回 null，调用方据此什么都不做。
// 事件一律走 onCall，负载带 type（token / incoming / answer / end / mute / audio），交给 shared 的
// callKitEventOf 验——原生那边报来电是同步的、不等 JS，JS 起来之前的事件原生先攒着，挂上监听时一次发完。
import { NativeModule, requireOptionalNativeModule } from "expo";

type OttoCallEvents = {
  onCall: (raw: Record<string, unknown>) => void;
};

declare class OttoCallModule extends NativeModule<OttoCallEvents> {
  /** PushKit 给的 VoIP 令牌（十六进制）；还没拿到回 null——拿到时另发一条 token 事件 */
  getVoipToken(): string | null;
  /** App 这边的通话结束了：收掉这一通系统来电（不回发 end 事件） */
  endCall(ringId: string): Promise<void>;
}

export const OttoCall: OttoCallModule | null = requireOptionalNativeModule<OttoCallModule>("OttoCall");
```

`mobile/modules/otto-call/ios/OttoCall.podspec`：

```ruby
# 系统来电的原生一半（#1428）：PushKit 收 VoIP 推送、CallKit 画系统来电。Expo 本地模块，autolinking 从 mobile/modules/ 找到它。
Pod::Spec.new do |s|
  s.name           = 'OttoCall'
  s.version        = '1.0.0'
  s.summary        = 'Mr Otto mobile: VoIP push + CallKit incoming calls'
  s.description    = 'Agent callbacks as real system calls (#1428).'
  s.author         = ''
  s.homepage       = 'https://github.com/real-stanyan/Mr-Otto'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CallKit', 'PushKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
```

- [ ] **Step 2: `CallCenter.swift`**（整份）：

```swift
import AVFoundation
import CallKit
import Foundation
import PushKit

/// 进程里唯一的一份：PushKit 注册、CallKit provider、这几通来电的账（#1428，spec §2）。
/// 一律在主队列上动：PushKit 的 registry 建在主队列上，CXProvider 的 delegate 队列给 nil（= 主队列），
/// JS 调进来的两个函数也 runOnQueue(.main)，所以不需要锁。
final class CallCenter: NSObject {
  static let shared = CallCenter()

  private struct Call {
    let uuid: UUID
    var answered: Bool
    var timer: Timer?
  }

  private var registry: PKPushRegistry?
  private let provider: CXProvider
  private(set) var voipToken: String?
  /// ringId → 这一通
  private var calls: [String: Call] = [:]
  /// 已经处理过的 ringId：推送不保证只到一次，同一通再来要报、但报完立刻结束
  private var seen = Set<String>()
  /// JS 还没挂上监听时攒着的事件（被 VoIP 推送从后台叫起来的那一次，JS 比推送回调晚）
  private var pending: [[String: Any]] = []
  /// JS 那一侧；nil = 没有监听。设上时把攒着的一次发完
  var emit: (([String: Any]) -> Void)? {
    didSet {
      guard let emit else { return }
      let queued = pending
      pending = []
      queued.forEach(emit)
    }
  }

  private override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = false
    config.maximumCallsPerCallGroup = 1
    config.maximumCallGroups = 1
    config.supportedHandleTypes = [.generic]
    // 通话记录在聊天里已经有了，不往「电话」App 的最近通话里塞
    config.includesCallsInRecents = false
    // expo-notifications 插件把它打进了包根目录（app.json 的 sounds）
    config.ringtoneSound = "ringtone.caf"
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  /// didFinishLaunching 里调（OttoCallAppDelegate）：越早越好，被推送叫起来时回调紧跟其后
  func start() {
    guard registry == nil else { return }
    let r = PKPushRegistry(queue: .main)
    r.delegate = self
    r.desiredPushTypes = [.voIP]
    registry = r
  }

  private func send(_ body: [String: Any]) {
    if let emit { emit(body) } else { pending.append(body) }
  }

  private func uuidOf(_ ringId: String) -> UUID? { calls[ringId]?.uuid }

  private func ringIdOf(_ uuid: UUID) -> String? {
    calls.first(where: { $0.value.uuid == uuid })?.key
  }

  /// App 这边的通话结束了：收掉系统来电。走 reportCall 不走 CXEndCallAction——后者会回调 perform end、
  /// 再发一条 end 事件，JS 又去挂一次已经挂掉的电话
  func endCall(ringId: String) {
    guard let call = calls.removeValue(forKey: ringId) else { return }
    call.timer?.invalidate()
    provider.reportCall(with: call.uuid, endedAt: nil, reason: .remoteEnded)
  }

  private func finishUnanswered(_ ringId: String) {
    guard let call = calls[ringId], !call.answered else { return }
    calls.removeValue(forKey: ringId)
    provider.reportCall(with: call.uuid, endedAt: nil, reason: .unanswered)
    send(["type": "end", "ringId": ringId, "answered": false, "reason": "missed"])
  }

  /// 与 otto-speech 逐字同一组（spec §2.3）：回声消除由它的 VPIO 做。只设 category，激活交给 CallKit
  private func configureAudioSession() {
    try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
  }
}

extension CallCenter: PKPushRegistryDelegate {
  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    voipToken = token
    send(["type": "token", "token": token])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    voipToken = nil
  }

  /// iOS 13 起：每一条 VoIP 推送都必须在这里报一通来电，否则系统杀 App、屡犯就不再投递。
  /// 解析失败 / 已过期 / 重复的也报，报完立刻结束（spec §0.8）
  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    let ring = payload.dictionaryPayload["ring"] as? [String: Any]
    let ringId = ring?["ringId"] as? String
    let name = (ring?["agentName"] as? String) ?? "Mr Otto"
    let expiresMs = (ring?["expiresTs"] as? NSNumber)?.doubleValue ?? 0
    let nowMs = Date().timeIntervalSince1970 * 1000
    let live = ringId != nil && expiresMs > nowMs && !seen.contains(ringId!)

    let uuid = UUID()
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: (ring?["agentId"] as? String) ?? "otto")
    update.localizedCallerName = name
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      defer { completion() }
      guard let self else { return }
      // 系统拒了（勿扰挡掉、已经有一通在打……）：什么都不记，服务端到点记未接
      if error != nil { return }
      guard live, let ringId, let ring else {
        self.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
        return
      }
      self.seen.insert(ringId)
      let timer = Timer.scheduledTimer(withTimeInterval: max(0, (expiresMs - nowMs) / 1000), repeats: false) { [weak self] _ in
        self?.finishUnanswered(ringId)
      }
      self.calls[ringId] = Call(uuid: uuid, answered: false, timer: timer)
      self.send(["type": "incoming", "ring": ring])
    }
  }
}

extension CallCenter: CXProviderDelegate {
  func providerDidReset(_ provider: CXProvider) {
    for (ringId, call) in calls {
      call.timer?.invalidate()
      send(["type": "end", "ringId": ringId, "answered": call.answered, "reason": "reset"])
    }
    calls.removeAll()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let ringId = ringIdOf(action.callUUID) else {
      action.fail()
      return
    }
    calls[ringId]?.timer?.invalidate()
    calls[ringId]?.timer = nil
    calls[ringId]?.answered = true
    configureAudioSession()
    action.fulfill()
    send(["type": "answer", "ringId": ringId])
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    guard let ringId = ringIdOf(action.callUUID), let call = calls.removeValue(forKey: ringId) else {
      action.fulfill()
      return
    }
    call.timer?.invalidate()
    action.fulfill()
    send(["type": "end", "ringId": ringId, "answered": call.answered, "reason": "user"])
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    guard let ringId = ringIdOf(action.callUUID) else {
      action.fail()
      return
    }
    action.fulfill()
    send(["type": "mute", "ringId": ringId, "muted": action.isMuted])
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    send(["type": "audio", "active": true])
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    send(["type": "audio", "active": false])
  }
}
```

- [ ] **Step 3: `OttoCallAppDelegate.swift`**：

```swift
import ExpoModulesCore
import UIKit

/// App 一起来就登记 VoIP 推送、建好 CallKit（#1428，spec §2.1）。被 VoIP 推送从后台叫起来的那一次，推送回调
/// 紧跟在 didFinishLaunching 之后——放到 JS 那边初始化就来不及了。挂在 Expo 的 AppDelegate 订阅者上，
/// 不去改 AppDelegate 本身（那个文件已经被 withSceneLifecycle 插件改过一次，ADR-0329）
public class OttoCallAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    CallCenter.shared.start()
    return true
  }
}
```

- [ ] **Step 4: `OttoCallModule.swift`**：

```swift
import ExpoModulesCore

// 系统来电的原生模块（#1428）：JS 一侧只有两个函数与一路事件。来电本身不经过 JS——原生收到 VoIP 推送就当场
// 报给 CallKit（iOS 的硬规定），之后才把这一通交给 JS。
public class OttoCallModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OttoCall")

    Events("onCall")

    // JS 挂上第一个监听时接上：攒着的事件（被推送叫起来那一次，JS 还没起来时到的）一次发完
    OnStartObserving {
      DispatchQueue.main.async {
        CallCenter.shared.emit = { [weak self] body in self?.sendEvent("onCall", body) }
      }
    }

    OnStopObserving {
      DispatchQueue.main.async { CallCenter.shared.emit = nil }
    }

    Function("getVoipToken") { () -> String? in
      CallCenter.shared.voipToken
    }

    AsyncFunction("endCall") { (ringId: String) in
      CallCenter.shared.endCall(ringId: ringId)
    }.runOnQueue(.main)
  }
}
```

（`getVoipToken` 是同步 Function，读的是主队列上写的一个字符串；读到上一次的值或 nil 都无妨——拿到新令牌时另有 token 事件。）

- [ ] **Step 5: 类型检查** — `npx tsc --noEmit -p mobile`（index.ts 要编得过）。

- [ ] **Step 6: 提交** — `git add mobile/modules/otto-call`，`git commit -m "feat(mobile): otto-call 原生模块——VoIP 推送当场报成系统来电（#1428）"`。

---

### Task 5: otto-speech 在系统来电期间让出音频会话

**Files:**
- Modify: `mobile/modules/otto-speech/ios/Recognizer.swift`
- Modify: `mobile/modules/otto-speech/ios/OttoSpeechModule.swift`
- Modify: `mobile/modules/otto-speech/index.ts`

**Interfaces:**
- Produces: JS `OttoSpeech.setSessionManagedExternally(on: boolean): Promise<void>`。

- [ ] **Step 1: Recognizer** —— 加一个属性并在三处判它：

```swift
  /// 系统来电（CallKit）进行中：音频会话由系统激活 / 去激活（#1428，spec §2.4），这里不 setCategory、
  /// 不 setActive，CallKit 激活 / 去激活会话时发的打断通知也不当成打断
  var externalSession = false
```

  - `activateSession()` 开头：`if externalSession { return }`。
  - `deactivateIfIdle()`：停引擎照旧，`setActive(false, …)` 那一行改成只在 `!externalSession` 时做。
  - `interruptionNotification` 的观察者：在 `speechQueue.async { … }` 里先 `guard let self, !self.externalSession else { return }` 再调 `interrupted(…)`。

  **读 Recognizer.swift 的实际代码再改**：上面给的是判据，具体行以现有代码为准；不许改别的行为。

- [ ] **Step 2: 模块** —— `OttoSpeechModule.swift` 的 `definition()` 里、`stopPlay` 之后加：

```swift
    // 系统来电进行中由 JS 打开（#1428）：音频会话交给 CallKit，这边不自己开关
    AsyncFunction("setSessionManagedExternally") { (on: Bool) in
      self.recognizer.externalSession = on
    }.runOnQueue(speechQueue)
```

- [ ] **Step 3: index.ts** —— `OttoSpeechModule` 声明里加：

```ts
  /** 系统来电（CallKit）进行中：音频会话由系统激活，这边不 setCategory / setActive（#1428） */
  setSessionManagedExternally(on: boolean): Promise<void>;
```

- [ ] **Step 4: 类型检查** — `npx tsc --noEmit -p mobile`。

- [ ] **Step 5: 提交** — `git add mobile/modules/otto-speech`，`git commit -m "feat(mobile): 系统来电期间 otto-speech 不自己开关音频会话（#1428）"`。

---

### Task 6: 手机 JS 接线 + 拆旧路 + 构建配置 + ADR

**Files:**
- Create: `mobile/src/call/systemCall.ts`
- Create: `mobile/src/call/callKit.ts`
- Rewrite: `mobile/src/call/ringStore.ts`
- Rewrite: `mobile/src/push/pushRegistration.ts`
- Modify: `mobile/src/cloud/chatStore.ts`（加两个导出）
- Modify: `mobile/src/voice/voiceStore.ts`（后台判据）
- Modify: `mobile/src/cloud/cloudClient.ts`（后台判据）
- Modify: `mobile/src/chat/ChatScreen.tsx`（等音频）
- Modify: `mobile/src/nav/RootNavigator.tsx`（摘掉 IncomingCall）
- Delete: `mobile/src/call/IncomingCall.tsx`
- Modify: `mobile/App.tsx`（副作用 import 换成 callKit）
- Modify: `mobile/app.json`（UIBackgroundModes）
- Create: `docs/adr/0335-智能体回电走CallKit加VoIP推送-系统来电期间不停听.md`（编号合并前再核）
- Modify: `docs/adr/0331-…md`（顶部加一行「被 ADR-0335 部分推翻」）、`AGENTS.md`

**Interfaces:**
- Consumes: Task 3 全部导出；Task 4 `OttoCall`；Task 5 `OttoSpeech.setSessionManagedExternally`。
- Produces: `inSystemCall()`、`onSystemCallEnded(fn)`、`setInSystemCall(v)`（systemCall.ts）；`useCallKit(): CallKitState`（callKit.ts）；ringStore 的 `noteIncoming(ring)`、`answerRing(ring)`、`declineRing(ring)`、`settleAnswer(ringId, how)`、`flushPendingNav()`；chatStore 的 `subscribeChat(fn)`、`chatSessionOf(sessionId)`。

- [ ] **Step 1: `mobile/src/call/systemCall.ts`**：

```ts
// 系统来电进行中吗（#1428，spec §3「后台不断」）。voiceStore 与 cloudClient 切后台时读它：系统来电期间不停听、
// 不暂停会话房（修订 ADR-0320）；来电结束时如果还在后台，它们各自补做切后台那一步。
// **这个文件不 import 任何东西**：callKit.ts 依赖那两处，那两处再 import callKit.ts 就成环。
let active = false;
const enders: (() => void)[] = [];

export function inSystemCall(): boolean {
  return active;
}

/** 来电结束时要补做的那一步（切后台时被跳过的） */
export function onSystemCallEnded(fn: () => void): void {
  enders.push(fn);
}

export function setInSystemCall(v: boolean): void {
  if (active === v) return;
  active = v;
  if (!v) for (const fn of enders) fn();
}
```

- [ ] **Step 2: chatStore 加两个导出**（放在 `chatEvents` 之后）：

```ts
/** 非 hook 的订阅（系统来电那一层看通话开没开，#1428） */
export function subscribeChat(fn: () => void): () => void {
  return store.subscribe(fn);
}

/** 此刻开着的那条会话；不是这一条回 null */
export function chatSessionOf(sessionId: string): ChatSession | null {
  const s = store.get().session;
  return s !== null && s.sessionId === sessionId ? s : null;
}
```

- [ ] **Step 3: 重写 `mobile/src/call/ringStore.ts`**（整份）：

```ts
// 来电（#1411 → #1428）：响铃与来电界面归系统（CallKit），callKit.ts 收到原生事件后驱动这里。这里只剩三件事：
// · 来电到了先把开场白合成好（#1420），接起来立刻出声；已经接不起来的那通不合成（花的是这个人的额度）；
// · 接听是「原地接通」：导航重置成「首页 → 那条聊天」、带上 answerRing，聊天页房间 ready、系统把音频交过来之后
//   把这只拉进通话（runtime 的 setVoiceCall 认出「正在给他响铃」，记接通、落开场白）。重置而不是推一页：手机只有
//   一份「当前聊天」store，聊天页叠聊天页会让下面那一页在返回时对着一份已关掉的 store；
// · 拒接 / 没接 = 只在本机记下，服务端到点记未接，不另发「拒接」（spec §3）。
import { CommonActions } from "@react-navigation/native";
import { RING_ANSWER_GRACE_MS, ringTarget, type RingPush } from "../../../src/shared/callRing.js";
import { navRef } from "../nav/navRef.js";
import { prefetchOpening } from "../voice/voiceStore.js";
import { toast } from "../wx/toast.js";

/** 等聊天页接手的上限：房间一直连不上时说一声 */
const CONNECT_TIMEOUT_MS = 20_000;

/** 这台手机上已经接了 / 挂了的那几通 */
const handled = new Set<string>();
/** 点了接听、还在等聊天页接手的那一通 */
let connecting: string | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;

export function noteIncoming(ring: RingPush): void {
  if (handled.has(ring.ringId)) return;
  const answerableUntil = ring.expiresTs + RING_ANSWER_GRACE_MS;
  if (ring.opening !== undefined && Date.now() < answerableUntil) prefetchOpening(ring.agentId, ring.opening, answerableUntil);
}

let pendingNav: (() => void) | null = null;

/** 把人送进那条聊天。冷启动（被推送叫起来）时导航还没挂上，先记着，RootNavigator 的 onReady 再送 */
function openChatOf(ring: RingPush): void {
  const params = { ...ringTarget(ring), answerRing: { ringId: ring.ringId, agentId: ring.agentId } };
  const go = (): void => {
    navRef.dispatch(CommonActions.reset({ index: 1, routes: [{ name: "Home" }, { name: "Chat", params }] }));
  };
  if (navRef.isReady()) go();
  else pendingNav = go;
}

export function flushPendingNav(): void {
  const go = pendingNav;
  pendingNav = null;
  go?.();
}

export function answerRing(ring: RingPush): void {
  handled.add(ring.ringId);
  connecting = ring.ringId;
  openChatOf(ring);
  if (connectTimer !== null) clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (connecting !== ring.ringId) return;
    connecting = null;
    toast("没接通：这条聊天一直没连上");
  }, CONNECT_TIMEOUT_MS);
}

/** 聊天页接手了这一通：通话已经开起来（"call"），或者打不了、页面上说了为什么（"note"） */
export function settleAnswer(ringId: string, _how: "call" | "note"): void {
  if (connecting !== ringId) return;
  connecting = null;
  if (connectTimer !== null) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
}

export function declineRing(ring: RingPush): void {
  handled.add(ring.ringId);
}
```

  （`settleAnswer` 的第二个参数保留签名，ChatScreen 的两处调用不改；没有来电页要撤之后它只剩收掉计时器。若 lint/tsc 对 `_how` 未使用报错，改成删掉参数并同步改 ChatScreen 两处调用。）

- [ ] **Step 4: `mobile/src/call/callKit.ts`**（整份）：

```ts
// 系统来电（#1428，spec §3）：otto-call 原生模块发上来的事件 → ringStore / 语音层的动作。判据在 shared 的
// callKitBridge；这里只做分发与三处同步：
// · 进行中与否 → systemCall.ts（语音层与会话房的「切后台就断」据它跳过）+ otto-speech 让出音频会话；
// · App 这边的通话结束了（在 App 里挂断、或别处把名单清空）→ 收掉系统来电界面；
// · 系统界面上挂断 → App 这边挂断；拒接 / 没接 → 本机记下（服务端到点记未接）；静音 → 关麦。
import { useSyncExternalStore } from "react";
import { OttoCall } from "../../modules/otto-call/index.js";
import { OttoSpeech } from "../../modules/otto-speech/index.js";
import {
  CALLKIT_IDLE, callKitEventOf, inSystemCall, onVoiceCall, reduceCallKit, type CallKitEvent, type CallKitState,
} from "../../../src/shared/callKitBridge.js";
import { voiceCallOf } from "../../../src/shared/voiceCall.js";
import { chatEvents, chatSessionOf, subscribeChat } from "../cloud/chatStore.js";
import { createStore } from "../externalStore.js";
import { hangUp, setMic } from "../voice/voiceStore.js";
import { answerRing, declineRing, noteIncoming } from "./ringStore.js";
import { setInSystemCall } from "./systemCall.js";

const store = createStore<CallKitState>(CALLKIT_IDLE);

export function useCallKit(): CallKitState {
  return useSyncExternalStore(store.subscribe, store.get);
}

function commit(next: CallKitState): void {
  const prev = store.get();
  if (next === prev) return;
  store.set(next);
  const was = inSystemCall(prev);
  const now = inSystemCall(next);
  if (was !== now) {
    setInSystemCall(now);
    void OttoSpeech?.setSessionManagedExternally(now).catch(() => undefined);
  }
}

function onEvent(e: CallKitEvent): void {
  const before = store.get();
  switch (e.type) {
    case "incoming":
      noteIncoming(e.ring);
      commit(reduceCallKit(before, e));
      return;
    case "answer": {
      const c = before.calls.get(e.ringId);
      commit(reduceCallKit(before, e));
      if (c !== undefined) answerRing(c.ring);
      return;
    }
    case "end": {
      const c = before.calls.get(e.ringId);
      commit(reduceCallKit(before, e));
      if (c === undefined) return;
      if (!e.answered) {
        declineRing(c.ring);
        return;
      }
      // 系统界面上挂断：只挂这一条会话的通话——人可能已经切到别的聊天，那里的通话不该被这一下挂掉
      if (chatSessionOf(c.ring.sessionId) !== null) void hangUp();
      return;
    }
    case "mute": {
      const c = before.calls.get(e.ringId);
      if (c?.answered === true && chatSessionOf(c.ring.sessionId) !== null) setMic(!e.muted);
      return;
    }
    case "audio":
      commit(reduceCallKit(before, e));
      return;
    case "token":
      // 登记在 pushRegistration.ts（它自己也听 token 事件）
      return;
  }
}

/** App 这边的通话开没开：对过账之前（provisional，缓存里的旧事件）不算数——缓存里可能躺着一场早就结束的通话 */
function onChatChanged(): void {
  let s = store.get();
  const ended: string[] = [];
  for (const c of s.calls.values()) {
    if (!c.answered) continue;
    const session = chatSessionOf(c.ring.sessionId);
    if (session === null || session.provisional) continue;
    const events = chatEvents(c.ring.sessionId);
    if (events === null) continue;
    const r = onVoiceCall(s, c.ring.sessionId, voiceCallOf(events) !== null);
    s = r.state;
    ended.push(...r.ended);
  }
  commit(s);
  for (const ringId of ended) void OttoCall?.endCall(ringId).catch(() => undefined);
}

if (OttoCall !== null) {
  OttoCall.addListener("onCall", (raw) => {
    const e = callKitEventOf(raw);
    if (e !== null) onEvent(e);
  });
  subscribeChat(onChatChanged);
}
```

- [ ] **Step 5: 重写 `mobile/src/push/pushRegistration.ts`**（整份）：

```ts
// 推送登记（#1411 → #1428）：智能体回电走 VoIP 推送 + CallKit，手机先得把 PushKit 给的 VoIP 令牌交给服务端。
//
// · 冷启动（已登录）、每次回到前台、每次登录、PushKit 给了新令牌，各登记一次：令牌可能变，RPC 是幂等的
//   （0047 的 register_push_device，p_kind = 'voip'）。VoIP 推送与 CallKit 不需要通知权限，不再向 iOS 要。
// · 退出登录前注销这台（unregisterPush）：退出之后这台手机不该再响这个账号的来电。最多等 3 秒，断网照样退出。
// · Expo Go 里没有 otto-call（同 otto-speech），什么都不登记。
import Constants from "expo-constants";
import { AppState } from "react-native";
import { OttoCall } from "../../modules/otto-call/index.js";
import { supabase } from "../supabase.js";

const BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier ?? "com.stanyan.mrotto.mobile";

/** 这次启动登记成功的那个令牌（注销用） */
let token: string | null = null;
let inflight: Promise<void> | null = null;

const warn = (what: string, e: unknown): void => {
  console.warn(`推送${what}失败：${e instanceof Error ? e.message : String(e)}`);
};

/** 登记这台手机（登录了、而且 PushKit 已经给了令牌才做） */
export function registerPush(): Promise<void> {
  if (OttoCall === null) return Promise.resolve();
  if (inflight !== null) return inflight;
  const call = OttoCall;
  inflight = (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session === null) return;
    const t = call.getVoipToken();
    if (t === null || t === "") return;
    const { error } = await supabase.rpc("register_push_device", { p_token: t, p_bundle: BUNDLE_ID, p_kind: "voip" });
    if (error) {
      warn("登记", error.message);
      return;
    }
    token = t;
  })()
    .catch((e: unknown) => warn("登记", e))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 退出登录前注销这台。最多等 3 秒：断网时调不通，退出不能被它卡住 */
export async function unregisterPush(): Promise<void> {
  if (token === null) return;
  const t = token;
  const run = (async () => {
    const { error } = await supabase.rpc("unregister_push_device", { p_token: t });
    if (error) warn("注销", error.message);
    else token = null;
  })().catch((e: unknown) => warn("注销", e));
  await Promise.race([run, new Promise<void>((r) => setTimeout(r, 3_000))]);
}

void registerPush();
AppState.addEventListener("change", (s) => {
  if (s === "active") void registerPush();
});
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN") void registerPush();
});
OttoCall?.addListener("onCall", (raw) => {
  if (raw.type === "token") void registerPush();
});
```

- [ ] **Step 6: 后台判据** ——
  - `voiceStore.ts`：import `{ inSystemCall, onSystemCallEnded } from "../call/systemCall.js"`；AppState 监听里 `if (s === "background") session.leave();` 改成 `if (s === "background") { if (!inSystemCall()) session.leave(); }`（保留 else 分支原样）；并在监听之后加：

```ts
// 系统来电期间切后台不停听（#1428，修订 ADR-0320：锁着屏也在通话）；来电结束时还在后台，补做那一步
onSystemCallEnded(() => {
  if (AppState.currentState !== "active") session.leave();
});
```

  - `cloudClient.ts`：import 同上；`else if (s === "background") room?.pause("切到后台");` 改成 `else if (s === "background" && !inSystemCall()) room?.pause("切到后台");`；监听之后加：

```ts
// 系统来电期间切后台不暂停会话房（#1428）：锁着屏通话靠它；来电结束时还在后台就补暂停——runtime 据「房里有没有
// 他的连接」决定下一通回电打不打（ADR-0331）
onSystemCallEnded(() => {
  if (AppState.currentState !== "active") room?.pause("系统来电结束、在后台");
});
```

  文件头注释各补一句指向 #1428。

- [ ] **Step 7: ChatScreen 等音频** —— `mobile/src/chat/ChatScreen.tsx`：
  - import `{ useCallKit } from "../call/callKit.js"` 与 `{ systemAudioReady } from "../../../src/shared/callKitBridge.js"`。
  - 组件里 `const callKit = useCallKit();`。
  - 接回电那个 effect 的守卫改成：`if (ar === undefined || answeredRing.current === ar.ringId || !ready || session === null || !systemAudioReady(callKit, ar.ringId)) return;`，依赖数组加 `callKit`；effect 上方注释改成：从系统来电界面接听进来——房间 ready、系统把音频会话交过来之后才把这只拉进通话（先开麦会和 CallKit 抢会话，#1428）。

- [ ] **Step 8: 拆旧路与构建配置**
  - `mobile/src/nav/RootNavigator.tsx`：删 `import { IncomingCall } …` 与 `<IncomingCall />`。
  - `git rm mobile/src/call/IncomingCall.tsx`。
  - `mobile/App.tsx`：`import "./src/call/ringStore.js";` 改成 `import "./src/call/callKit.js";`（callKit 引入 ringStore；这一行的作用是让事件监听在启动时挂上）。
  - `mobile/app.json`：`ios.infoPlist` 里加 `"UIBackgroundModes": ["voip", "audio"]`。其余不动（expo-notifications 插件留着——它负责把 ringtone.caf 打进包根目录，CallKit 的 ringtoneSound 从那儿取）。
  - `grep -rn "IncomingCall\|getLastNotificationResponseAsync\|setNotificationHandler\|getDevicePushTokenAsync\|useRings\|pruneRings" mobile/src mobile/App.tsx` 应该没有结果。

- [ ] **Step 9: ADR 与索引**
  - 先 `ls docs/adr | tail -3` 核编号；若 0335 已被占用，用下一个空号并在下面各处同步。
  - `docs/adr/0335-智能体回电走CallKit加VoIP推送-系统来电期间不停听.md`：

```markdown
# ADR-0335：智能体回电走 CallKit + VoIP 推送；系统来电期间不停听

- 状态：已采纳（2026-09-29）
- Issue：#1428；spec：`docs/superpowers/specs/2026-09-29-callkit-ring-design.md`
- 推翻：ADR-0331 的「不用 CallKit，走时效性通知 + App 内来电页」；修订：ADR-0320 的「锁屏 = 这台停听、通话还在」

## 背景

维护者真机：锁屏时智能体回电没有声音也没有震动。诊断：往手机发了系统默认提示音与 `ringtone.caf` 两条测试推送，
APNs 都回 200，手机都没响，Mac 上弹出并响了——这台 Mac 开着 iPhone 镜像，iOS 把锁屏时的通知路由到了正在用的
设备（同 Apple Watch）。App 管不了一条普通通知被送到哪台设备。维护者：「我希望无论如何，来电时手机上也要震动」。

## 决定

1. 回电改成系统来电：runtime 发 VoIP 推送（`voip` / `<bundle>.voip` / 立即送、送不到就作废），手机的 otto-call
   原生模块在推送回调里当场报给 CallKit——iOS 13 起每一条 VoIP 推送都必须这样报，所以服务端只在真要响铃时发，
   手机收到了一律报（过期 / 重复的报完立刻结束）。
2. **不上中国大陆 App Store**（Apple 不许大陆区的 App 用 CallKit，维护者拍板）：只做这一套，通知来电与 App 内
   来电页整条拆掉，不留按地区切换。
3. **锁着屏直接通话**：系统来电进行中（接听到结束）切后台不停听、不暂停会话房；结束时还在后台再补做。音频会话由
   CallKit 激活，otto-speech 期间不自己 setCategory / setActive，麦克风等系统把会话交过来才开。
4. 令牌表加 `kind`（alert / voip），runtime 只给 voip 发（migration 0047）。
5. 不进「电话」App 的最近通话；静音只从系统界面同步到 App。

## 代价

- 部署 runtime 之后、装上新包之前，这台手机收不到来电。
- 原生部分（报来电、音频交接、锁屏通话）没有自动化测试，只能真机验。
- 系统界面上的静音钮可能与 App 不一致（App 里点静音不回写）。
- 通话期间 App 在后台保持连接与麦克风，耗电。
- 以后要上大陆区，得重新做一条不用 CallKit 的来电。
```

  - `docs/adr/0331-…md` 标题下第一行加：`> 部分推翻：ADR-0335（#1428）——回电改走 CallKit + VoIP 推送，本文的通知来电与 App 内来电页已拆除。`
  - `AGENTS.md`：「Where to find things」里那条 `src/shared/callRing.ts / services/runtime/src/callRinger.ts / …`（智能体回电）末尾补一句：「**#1428 起改走 CallKit + VoIP 推送**（ADR-0335）：`mobile/modules/otto-call/` 收 VoIP 推送当场报成系统来电，判据在 `src/shared/callKitBridge.ts`；系统来电期间不停听（`mobile/src/call/systemCall.ts`）；令牌表加 `kind`（0047），只给 voip 发」。

- [ ] **Step 10: 门禁** — `npx tsc --noEmit -p mobile`，然后 `npm test > .gate.log 2>&1`，看 `grep -E "Test Files|Tests |error" .gate.log` 与退出码，删掉日志。

- [ ] **Step 11: 提交** — 把本任务改动的文件逐个 `git add`（含 `git rm` 掉的 IncomingCall.tsx），`git commit -m "feat(mobile): 回电接成系统来电——CallKit 事件驱动接听挂断、系统来电期间不停听（#1428）"`。
