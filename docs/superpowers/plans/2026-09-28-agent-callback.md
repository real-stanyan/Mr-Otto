# 智能体办完事打电话回给你 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 智能体（云会话里的每一只）可以调 `call_user` 让叫起这一轮的那个人的手机响：锁屏时是一条带 30 秒铃声的时效性通知，App 开着时直接弹全屏来电页；接起来它先开口，把打电话要说的事说清楚（#1411）。

**Architecture:** 一次响铃是日志里的 `call_ring` 事件（ringing → answered / missed），纯投影在 `src/shared/callRing.ts`，runtime 与手机共用。runtime 里 `callRinger.ts` 管打出去、到点未接、接通、归档、重启；`apns.ts` 直发 APNs（ES256 JWT + node:http2），令牌从新表 `push_devices` 取。接听不另造帧：手机发现成的 `call` 帧把那只拉进通话，`setVoiceCall` 认出「正在给他响铃」就记接通、把开场白换成回电版。手机用 expo-notifications 登记令牌、接通知、弹来电页。

**Tech Stack:** TypeScript（strict + exactOptionalPropertyTypes + verbatimModuleSyntax）、vitest、Node runtime daemon（node:http2 / node:crypto）、Supabase（Postgres + RLS + security definer RPC）、Expo SDK 57 / React Native（expo-notifications、react-navigation 7）。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-callback-design.md`

## Global Constraints

- 事件 `call_ring` 的形状逐字照 spec §2.3：`ringId`、`phase: "ringing" | "answered" | "missed"`、`fromAgentId`（**不叫 agentId**）、`toUid`、`reason`、`expiresTs`、`ignorable: true`。
- 常量：响铃时限 `RING_TTL_MS = 45_000`；冷却 `RING_COOLDOWN_MS = 10 * 60_000`；锁屏那句话最长 `RING_REASON_MAX = 60` 字（按字，不按 UTF-16 码元）；推送最多等 `RING_PUSH_WAIT_MS = 5_000`；接听宽限 `RING_ANSWER_GRACE_MS = 30_000`；JWT 每 `APNS_JWT_TTL_MS = 50 * 60_000` 换一次。
- 工具名 `call_user`；参数只有 `reason`（必填字符串）；不过审批门（主场群里客人点起的那一轮由 sessionService 已有的 `guestTurn()` 掀成要群主批）。推送关着时这把刀不出现，通话块也不提回电。
- `user_message.greeting` 的联合类型加 `"callback"`。回电开场白：`[系统] 「运维」打给 Stan 的电话接通了。运维：你打这个电话是为了：<reason>。先把这件事说清楚，说完问他还有没有要你做的。这句话会被读出来，别用列表和记号。`（三个字段过 `promptSafe`）。
- 推送：主机 `api.push.apple.com` / `api.sandbox.push.apple.com`；`POST /3/device/<token>`；头 `apns-topic`=bundle、`apns-push-type: alert`、`apns-priority: 10`、`apns-expiration`=响铃过期时刻（秒）、`apns-collapse-id`=ringId；载荷 `aps.alert.title = "<名字> 来电"`、`aps.alert.body = reason`、`aps.sound = "ringtone.caf"`、`aps["interruption-level"] = "time-sensitive"`、`aps["thread-id"] = sessionId`，外加顶层 `ring`（`RingPush`）。
- 环境变量 `APNS_KEY_FILE` / `APNS_KEY_ID` / `APNS_TEAM_ID` 三个要么全有要么全无（只有一部分 = 启动失败）；`APNS_BUNDLE_ID` 缺省 `com.stanyan.mrotto.mobile`。Team ID 是 `HV982TTRNP`。
- 手机：expo-notifications 用 `npx expo install`（SDK 57 那一版，`~57.0.x`）；app.json 挂插件 `["expo-notifications", { "sounds": ["./assets/sounds/ringtone.caf"] }]`，`ios.entitlements` 加 `"com.apple.developer.usernotifications.time-sensitive": true`；`./plugins/withSceneLifecycle` 保持在插件列表里。
- **不改任何帧、不进协议位**（`CS_PROTOCOL_VERSION` 仍是 21）：云会话线上事件只浅校验，新事件类型旧客户端照收不画。
- 硬规则照旧：日志 append-only、事件 schema 只加可选字段；工具实现只依赖注入的回调（`callUserTool` 不认识 store、不认识 APNs）。
- 门禁：`npm test`（tsc ×4 + vitest）。先 `npm --prefix mobile ci`（lane 里 `mobile/node_modules` 必须是真目录，不能是软链）；根目录 `node_modules` 软链主 checkout 的那一份即可。跑门禁的日志以 `GATE_EXIT=` 那一行为准。
- 测试放 `tests/`，镜像源码目录。注释用中文，写「为什么」，照仓里现有的密度。
- 提交：按路径 `git add`，不用 `git add -A`、不用裸 `git stash`；提交信息 `type(scope): 中文说明（#1411）`，末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- ADR 编号合并时才占（ADR-0074）：先写 0331，合并前 re-fetch，被占了就改成 max+1 并在文件顶加 `原为 ADR-0331` 一行、改掉仓里所有引用。migration 号同理（先写 0045）。

## 计划阶段对 spec 的补全（执行时以这里为准，Task 11 回写进 spec）

1. **§2.2 第 2 条「正在通话不打」并进第 1 条**。锁屏 = 这台停听、通话还在（ADR-0320），通话名单非空不等于人在通话里——照 spec 字面，挂了电话锁屏（最常见的回电场景）会因为那场没人挂断的通话永远打不出去。人真在通话里时他必然连着这条会话，第 1 条已经挡住。接听时通话本来就开着：名单没变也认接听（Task 5）。
2. **手机切后台主动断开会话房**（Task 8）。iOS 挂起的 socket 在服务端看来还连着（中继自己应答心跳，runtime 看不见），`isWatching` 会恒真，同样是回电永远打不出去。
3. **接听宽限 30 秒**：人在第 44 秒点了接听，落到服务端时已记未接，仍算接通（`RING_ANSWER_GRACE_MS`）。
4. **冷却从日志折叠**，不只是内存：比 spec 更严（重启不清零），状态少一份。
5. **通话块那一句只在推送开着时说**：`voice_call_changed` 加可选字段 `callback?: true`，runtime 推送开着时带上。spec §2.1 自己的理由（推送关着时工具不出现，不能让模型许诺一通打不出去的电话）同样适用于提示词。
6. **`agentView.OTHER_AGENT_VERDICTS` 写 `keep` 不写 `drop`**：`call_ring` 没有 agentId，早退路径一律放行，那张表根本轮不到它；写 `drop` 是一句不成立的话（同 voice_call_changed / chat_roster_changed 的写法）。模型不可见由 deriveMessages 保证。
7. **回电开场白加「运维：」点名**（同 `voiceCallGreetingText`）：群里每只都读得到这一条，「你打这个电话是为了」得说清是对谁说。
8. **`register_push_device` 重复登记不清 `apns_env`**：同一个令牌的环境不会变，只有新插入的行是空。
9. **推送里的 `ring` 多带 `agentName` 与 `reason`**：来电页要画，而 App 刚被点醒时手上未必有那个团队的快照。
10. **聊天里的来电卡用电话图标代替 📞**：仓里一律用 `Icon`。
11. **接听 / 点开过期来电都把导航重置成「首页 → 那条聊天」**：手机只有一份「当前聊天」store，聊天页叠聊天页会让下面那一页在返回时对着一份已关掉的 store。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/session/events.ts` | 改 | `CallRingEvent`、联合类型、`KNOWN_EVENT_TYPES_MAP`、`greeting` 加 `"callback"`、`VoiceCallChangedEvent.callback?` |
| `src/session/persistencePolicy.ts` / `tests/session/persistencePolicy.test.ts` | 改 | `call_ring` 落盘 |
| `src/session/deriveMessages.ts` | 改 | `call_ring` 不投影；通话块按 `callback` 说那一句 |
| `src/shared/contextEstimate.ts` / `src/session/agentView.ts` / `src/shared/sessionPackage.ts` / `src/shared/taskSync.ts` / `src/renderer/src/components/Timeline.tsx` / `src/shared/cloudTimeline.ts` | 改 | 各张穷举表表态；桌面云会话时间线藏起来 |
| `src/shared/callRing.ts` | 新建 | 响铃折叠、能不能接、冷却、卡片状态、reason 规整、回电开场白、聊天种类、推送载荷读回、来电排队 |
| `supabase/migrations/0045_push_devices.sql` | 新建 | 令牌表 + 两个 security definer RPC |
| `services/runtime/src/config.ts` | 改 | `apns: ApnsSettings \| null`，三个变量全有全无 |
| `services/runtime/src/apns.ts` | 新建 | JWT、载荷与请求头、回复判定、环境顺序、发送编排、http2 那一层 |
| `services/runtime/src/callRinger.ts` | 新建 | 一次回电的生命周期（四种不打之外的三种、ringing、5 秒封顶、45 秒未接、接通、归档、重启） |
| `services/runtime/src/callUserTool.ts` | 新建 | `call_user` 那把刀 |
| `services/runtime/src/sessionService.ts` | 改 | `callback` 必需字段、挂刀、名单事件带 `callback`、`setVoiceCall` 认接听、回电开场白、归档、重启 |
| `services/runtime/src/pushDevices.ts` | 新建 | 令牌表的 Supabase 读写 |
| `services/runtime/src/frameHandler.ts` | 改 | `uidOf(cid)` |
| `services/runtime/src/daemon.ts` | 改 | 造 APNs 推送、每条会话接 `callback`、启动日志 |
| `services/runtime/checks/smokeAssembly.ts` | 改 | `callback: null` |
| `deploy/otto-runtime.env.example` / `docs/runtime-vps.md` | 改 | 三个 APNS_* 变量与 .p8 放哪 |
| `src/shared/remote/wsTransport.ts` | 改 | `pause(why)`：断开、不自己重连，直到下一次 `reconnectNow` |
| `mobile/src/cloud/cloudClient.ts` | 改 | 切后台 `pause` 会话房 |
| `scripts/make-ringtone.mjs` / `scripts/make-ringtone.d.mts` / `mobile/assets/sounds/ringtone.caf` | 新建 | 铃声（自己合成）与产物 |
| `mobile/package.json` / `mobile/package-lock.json` / `mobile/app.json` | 改 | expo-notifications、插件、entitlement |
| `mobile/src/push/pushRegistration.ts` | 新建 | 权限、令牌、登记 / 注销 |
| `mobile/src/account/SettingsScreen.tsx` | 改 | 退出前注销这台 |
| `mobile/App.tsx` | 改 | 两个模块的副作用 import |
| `mobile/src/nav/navRef.ts` | 新建 | 导航引用 |
| `mobile/src/nav/types.ts` / `mobile/src/nav/RootNavigator.tsx` | 改 | `answerRing` 参数、`ref` / `onReady`、挂来电页 |
| `mobile/src/call/ringStore.ts` / `mobile/src/call/IncomingCall.tsx` | 新建 | 通知 → 来电队列 → 全屏来电页 → 接听 / 挂断 |
| `mobile/src/voice/CallOverlay.tsx` | 改 | 导出 `RoundControl` 与三个颜色常量 |
| `mobile/src/chat/ChatScreen.tsx` | 改 | 带着 `answerRing` 进来：房间 ready 后把它拉进通话 |
| `src/shared/mobileChat.ts` / `mobile/src/chat/Bubbles.tsx` | 改 | 聊天里的来电卡 |
| `docs/adr/0331-智能体回电走runtime直发APNs-通知加App内来电页.md` / `AGENTS.md` / spec | 新建 / 改 | 决策记录、索引、spec 回写 |

---

### Task 1: shared —— `call_ring` 事件、各表登记、`callRing.ts`、通话块那一句

**Files:**
- Create: `src/shared/callRing.ts`
- Modify: `src/session/events.ts`、`src/session/persistencePolicy.ts`、`src/session/deriveMessages.ts`、`src/shared/contextEstimate.ts`、`src/session/agentView.ts`、`src/shared/sessionPackage.ts`、`src/shared/taskSync.ts`、`src/renderer/src/components/Timeline.tsx`、`src/shared/cloudTimeline.ts`
- Test: `tests/shared/callRing.test.ts`（新建）、`tests/session/callRingEvent.test.ts`（新建）、`tests/session/persistencePolicy.test.ts`、`tests/session/deriveMessages.voiceCall.test.ts`

**Interfaces:**
- Produces（后面各 task 都用）：`CallRingEvent`（events.ts）；`src/shared/callRing.ts` 导出 `CALL_USER_TOOL_NAME`、`RING_TTL_MS`、`RING_COOLDOWN_MS`、`RING_ANSWER_GRACE_MS`、`RING_REASON_MAX`、`type RingPhase`、`interface RingState { ringId; fromAgentId; toUid; reason; expiresTs; ringingTs; phase; phaseTs }`、`type RingFold = Map<string, RingState>`、`applyCallRing(fold, e): void`、`callRingFoldOf(events): RingFold`、`answerableRing(fold, agentId, uid, now): RingState | null`、`lastRingTs(fold, agentId, uid): number | null`、`type RingCardStatus`、`RING_STATUS_TEXT`、`ringCardStatus(r, now)`、`normalizeRingReason(raw): string`、`callbackGreetingText(agentName, userLabel, reason): string`、`type RingChatKind = "dm" | "group" | "team" | "guest"`、`ringChatKind({ home, chatKind, toUid, ownerUid })`、`interface RingPush { ringId; workspaceId; sessionId; agentId; agentName; reason; chat: RingChatKind; expiresTs }`、`ringFromPayload(payload: unknown): RingPush | null`、`type RingTarget`、`ringTarget(r)`、`queueRing(queue, ring, now)`、`dropRing(queue, ringId, now)`；`renderVoiceCallPrompt(participants, selfName, roster, callback = false)`。

- [ ] **Step 1: 写 `callRing.ts` 的失败测试**

新建 `tests/shared/callRing.test.ts`：

```ts
// callRing —— 回电的纯逻辑（#1411）：一次响铃此刻的状态、能不能接、冷却、卡上写什么、开场白、
// 推送载荷的读回、来电排队。runtime 与手机共用这一份，这里钉的是两边都要的那几条判据。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  RING_ANSWER_GRACE_MS, RING_REASON_MAX, RING_TTL_MS,
  answerableRing, applyCallRing, callRingFoldOf, callbackGreetingText, dropRing, lastRingTs,
  normalizeRingReason, queueRing, ringCardStatus, ringChatKind, ringFromPayload, ringTarget,
  type RingFold, type RingPush,
} from "../../src/shared/callRing.js";

let seq = 0;
const ring = (
  phase: "ringing" | "answered" | "missed",
  o: { ringId?: string; ts: number; from?: string; to?: string; reason?: string; expiresTs?: number },
): SessionEvent => ({
  seq: seq++, sessionId: "s1", ts: o.ts, type: "call_ring", ringId: o.ringId ?? "r1", phase,
  fromAgentId: o.from ?? "ops", toUid: o.to ?? "u1", reason: o.reason ?? "部署完了",
  expiresTs: o.expiresTs ?? 1_000 + RING_TTL_MS, ignorable: true,
});

describe("callRingFoldOf：最后一条说了算", () => {
  it("ringing → answered", () => {
    const f = callRingFoldOf([ring("ringing", { ts: 1_000 }), ring("answered", { ts: 5_000 })]);
    expect(f.get("r1")).toMatchObject({ phase: "answered", ringingTs: 1_000, phaseTs: 5_000, fromAgentId: "ops", toUid: "u1", reason: "部署完了" });
  });
  it("接晚了：ringing → missed → answered", () => {
    const f = callRingFoldOf([ring("ringing", { ts: 1_000 }), ring("missed", { ts: 46_000 }), ring("answered", { ts: 50_000 })]);
    expect(f.get("r1")?.phase).toBe("answered");
  });
  it("窗口裁掉了 ringing：不知道是谁打给谁，跳过", () => {
    expect(callRingFoldOf([ring("missed", { ts: 46_000 })]).size).toBe(0);
  });
  it("别的事件不碰", () => {
    const f: RingFold = new Map();
    applyCallRing(f, { seq: 0, sessionId: "s1", ts: 0, type: "session_archived", reason: "user" } as SessionEvent);
    expect(f.size).toBe(0);
  });
});

describe("answerableRing：发 call 帧的那一下算不算接听", () => {
  const at = 1_000;
  const exp = at + RING_TTL_MS;
  it("还在响：能接", () => {
    const f = callRingFoldOf([ring("ringing", { ts: at, expiresTs: exp })]);
    expect(answerableRing(f, "ops", "u1", at + 10_000)?.ringId).toBe("r1");
  });
  it("到点记了未接、还在宽限里：能接；过了宽限：不能", () => {
    const f = callRingFoldOf([ring("ringing", { ts: at, expiresTs: exp }), ring("missed", { ts: exp })]);
    expect(answerableRing(f, "ops", "u1", exp + RING_ANSWER_GRACE_MS)?.ringId).toBe("r1");
    expect(answerableRing(f, "ops", "u1", exp + RING_ANSWER_GRACE_MS + 1)).toBeNull();
  });
  it("接通过的不再算；别的智能体 / 别的人不算", () => {
    const f = callRingFoldOf([ring("ringing", { ts: at, expiresTs: exp }), ring("answered", { ts: at + 5_000 })]);
    expect(answerableRing(f, "ops", "u1", at + 6_000)).toBeNull();
    const g = callRingFoldOf([ring("ringing", { ts: at, expiresTs: exp })]);
    expect(answerableRing(g, "ads", "u1", at + 1)).toBeNull();
    expect(answerableRing(g, "ops", "u2", at + 1)).toBeNull();
  });
  it("两通都能接时取最近打的那一通", () => {
    const f = callRingFoldOf([
      ring("ringing", { ringId: "old", ts: at, expiresTs: exp }),
      ring("ringing", { ringId: "new", ts: at + 20_000, expiresTs: at + 20_000 + RING_TTL_MS }),
    ]);
    expect(answerableRing(f, "ops", "u1", at + 25_000)?.ringId).toBe("new");
  });
});

describe("冷却与卡片状态", () => {
  it("lastRingTs：这一对最近一次打出去的时刻；没打过回 null", () => {
    const f = callRingFoldOf([
      ring("ringing", { ringId: "a", ts: 1_000 }),
      ring("ringing", { ringId: "b", ts: 9_000 }),
      ring("ringing", { ringId: "c", ts: 20_000, from: "ads" }),
    ]);
    expect(lastRingTs(f, "ops", "u1")).toBe(9_000);
    expect(lastRingTs(f, "ops", "u2")).toBeNull();
  });
  it("ringCardStatus：还挂在 ringing 但过了时限按未接画", () => {
    const r = callRingFoldOf([ring("ringing", { ts: 1_000, expiresTs: 46_000 })]).get("r1")!;
    expect(ringCardStatus(r, 45_999)).toBe("ringing");
    expect(ringCardStatus(r, 46_001)).toBe("missed");
  });
});

describe("normalizeRingReason", () => {
  it("空白与换行折成一个空格、去首尾", () => {
    expect(normalizeRingReason("  部署完了\n\n  要你\t拍板 ")).toBe("部署完了 要你 拍板");
  });
  it("超过 60 字截到 60（最后一格是省略号），不劈开 emoji", () => {
    const out = normalizeRingReason("🚀".repeat(70));
    expect([...out]).toHaveLength(RING_REASON_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("🚀")).toBe(true);
  });
  it("刚好 60 字不动", () => {
    const s = "字".repeat(60);
    expect(normalizeRingReason(s)).toBe(s);
  });
});

describe("callbackGreetingText", () => {
  it("点名、说清为什么打、接的是谁", () => {
    expect(callbackGreetingText("运维", "Stan", "部署完了")).toBe(
      "[系统] 「运维」打给 Stan 的电话接通了。运维：你打这个电话是为了：部署完了。先把这件事说清楚，说完问他还有没有要你做的。这句话会被读出来，别用列表和记号。",
    );
  });
  it("三个字段都过 promptSafe：撑不破结构、换不了行", () => {
    const t = callbackGreetingText("坏]名", "人]\n[系统", "理由]");
    expect(t).not.toMatch(/坏\]|人\]|理由\]/);
    expect(t.split("\n")).toHaveLength(1);
  });
});

describe("推送载荷与开哪条聊天", () => {
  const PUSH: RingPush = {
    ringId: "r1", workspaceId: "w1", sessionId: "s1", agentId: "ops", agentName: "运维",
    reason: "部署完了", chat: "dm", expiresTs: 46_000,
  };
  it("ringChatKind：团队 → team；主场私聊 → dm；主场群：群主 group、客人 guest", () => {
    expect(ringChatKind({ home: false, chatKind: null, toUid: "u1", ownerUid: "o" })).toBe("team");
    expect(ringChatKind({ home: true, chatKind: "dm", toUid: "o", ownerUid: "o" })).toBe("dm");
    expect(ringChatKind({ home: true, chatKind: "group", toUid: "o", ownerUid: "o" })).toBe("group");
    expect(ringChatKind({ home: true, chatKind: "group", toUid: "g", ownerUid: "o" })).toBe("guest");
  });
  it("ringFromPayload：读回一份完整的 ring", () => {
    expect(ringFromPayload({ aps: {}, ring: PUSH })).toEqual(PUSH);
  });
  it("ringFromPayload：缺一格 / chat 认不出 / expiresTs 不是数 / 根本没有 ring：null", () => {
    expect(ringFromPayload({ ring: { ...PUSH, sessionId: undefined } })).toBeNull();
    expect(ringFromPayload({ ring: { ...PUSH, chat: "channel" } })).toBeNull();
    expect(ringFromPayload({ ring: { ...PUSH, expiresTs: "46000" } })).toBeNull();
    expect(ringFromPayload({ aps: {} })).toBeNull();
    expect(ringFromPayload(null)).toBeNull();
  });
  it("ringTarget：四种聊天各开各的页", () => {
    expect(ringTarget({ ...PUSH, chat: "dm" })).toEqual({ kind: "agent", agentId: "ops" });
    expect(ringTarget({ ...PUSH, chat: "group" })).toEqual({ kind: "group", sessionId: "s1" });
    expect(ringTarget({ ...PUSH, chat: "team" })).toEqual({ kind: "team", workspaceId: "w1", sessionId: "s1" });
    expect(ringTarget({ ...PUSH, chat: "guest" })).toEqual({ kind: "guest", workspaceId: "w1", sessionId: "s1" });
  });
  it("queueRing：按到达顺序排、同一通只排一次、过了时限的不排也顺手清掉", () => {
    const a = { ...PUSH, ringId: "a", expiresTs: 100 };
    const b = { ...PUSH, ringId: "b", expiresTs: 200 };
    let q = queueRing([], a, 0);
    q = queueRing(q, b, 0);
    q = queueRing(q, a, 0);
    expect(q.map((r) => r.ringId)).toEqual(["a", "b"]);
    expect(queueRing(q, { ...PUSH, ringId: "c", expiresTs: 50 }, 60).map((r) => r.ringId)).toEqual(["a", "b"]);
    expect(queueRing(q, { ...PUSH, ringId: "d", expiresTs: 300 }, 150).map((r) => r.ringId)).toEqual(["b", "d"]);
  });
  it("dropRing：摘掉一通、顺手清掉过期的", () => {
    const a = { ...PUSH, ringId: "a", expiresTs: 100 };
    const b = { ...PUSH, ringId: "b", expiresTs: 200 };
    expect(dropRing([a, b], "a", 0).map((r) => r.ringId)).toEqual(["b"]);
    expect(dropRing([a, b], "x", 150).map((r) => r.ringId)).toEqual(["b"]);
  });
});
```

新建 `tests/session/callRingEvent.test.ts`：

```ts
// call_ring 的登记（#1411）：新事件类型在每一张穷举表里都要表态，这几条钉的是「表的是什么态」。
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type CallRingEvent, type SessionCreatedEvent } from "../../src/session/events.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { PEN_VERDICTS } from "../../src/shared/taskSync.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

const ring: CallRingEvent = {
  sessionId: "s", seq: 1, ts: 1, type: "call_ring", ringId: "r1", phase: "ringing",
  fromAgentId: "ops", toUid: "u1", reason: "部署完了", expiresTs: 45_001, ignorable: true,
};

describe("call_ring 的登记（#1411）", () => {
  it("是已知事件类型：旧版本读到它不会当成残缺会话", () => {
    expect(KNOWN_EVENT_TYPES.has("call_ring")).toBe(true);
  });
  it("分享包里剥掉：带着接电话那个人的 uid 与一句私人的话", () => {
    expect(PRIVACY_VERDICTS.call_ring).toBe("strip");
  });
  it("要握笔才落得了：只有跑 turn 的那一方写它", () => {
    expect(PEN_VERDICTS.call_ring).toBe("executor");
  });
  it("桌面云会话时间线不画（手机上是一张卡；桌面等 #1403 的微信式布局）", () => {
    expect(hiddenFromCloudTimeline(ring)).toBe(true);
  });
  it("模型不可见：投影不为它多出任何一条消息、不漏那句话", () => {
    const created = {
      sessionId: "s", seq: 0, ts: 0, type: "session_created", workspace: "/work",
      cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true },
    } satisfies SessionCreatedEvent;
    const withRing = deriveMessages([created, ring]);
    expect(withRing).toEqual(deriveMessages([created]));
    expect(JSON.stringify(withRing)).not.toContain("部署完了");
  });
});
```

在 `tests/session/deriveMessages.voiceCall.test.ts` 顶部 import 里加 `import { CALL_USER_TOOL_NAME } from "../../src/shared/callRing.js";`，在 `describe("云会话 system 尾部的通话块（#1163）", …)` 里加一条：

```ts
  it("推送开着（名单事件带 callback）：通话块说一句可以用 call_user 回电；没带就不说（#1411）", () => {
    const on: SessionEvent = {
      ...base(2), type: "voice_call_changed", participants: [{ agentId: "admin", name: "管理员" }],
      byUid: "u1", callback: true, ignorable: true,
    };
    expect(systemOf([created, brief, on, user])).toContain(`可以用 ${CALL_USER_TOOL_NAME} 回电`);
    expect(systemOf([created, brief, call(2, [{ agentId: "admin", name: "管理员" }]), user])).not.toContain(CALL_USER_TOOL_NAME);
  });
```

在 `tests/session/persistencePolicy.test.ts` 的 `DURABLE` 数组里 `"voice_call_changed",` 下一行加 `"call_ring",`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/callRing.test.ts tests/session/callRingEvent.test.ts tests/session/deriveMessages.voiceCall.test.ts`
Expected: FAIL（`src/shared/callRing.js` 不存在、`call_ring` 不是已知类型）

- [ ] **Step 3: 改 `src/session/events.ts`**

① `VoiceCallChangedEvent` 加一格（`byAgentId?: string;` 下面、`ignorable: true;` 上面）：

```ts
  /** 这场通话里智能体能不能回电（#1411）：runtime 的推送开着时才带。缺席 = 不能 / 旧日志。
      通话块（deriveMessages 的 renderVoiceCallPrompt）据它决定说不说「可以用 call_user 回电」——
      推送关着时那把刀根本不在工具表里，提示词再说一句就是让模型许诺一通打不出去的电话（#1206 那个形状） */
  callback?: true;
```

② 紧跟在 `VoiceCallChangedEvent` 这个 interface 后面新增：

```ts
/** 智能体给人打的一通电话（#1411）。一次响铃是两到三条：`ringing` 开头，`answered` / `missed` 收尾
    （接晚了的那一通是 ringing → missed → answered，见 src/shared/callRing.ts 的 RING_ANSWER_GRACE_MS）。
    最后一条说了算，投影在 callRing.ts，runtime 与手机共用。
    **叫 `fromAgentId` 不叫 `agentId`**：带 agentId 的事件会被 openTurns / foldActivity / agentView 当成
    那只自己的动静——一通电话不是它的一轮。模型不可见（`ignorable`）：打没打通由 call_user 的
    tool_result 告诉它，接通由回电开场白（`user_message.greeting: "callback"`）告诉它。
    三个 phase 都带 reason / expiresTs：画卡不用回头找 */
export interface CallRingEvent extends SessionEventBase {
  type: "call_ring";
  ringId: string;
  phase: "ringing" | "answered" | "missed";
  fromAgentId: string;
  toUid: string;
  reason: string;
  expiresTs: number;
  ignorable: true;
}
```

③ `UserMessageEvent` 的 `greeting`：把这两行

```ts
      旧客户端照收，时间线按「`greeting` 在场就不画」一样藏起它 */
  greeting?: "voice_call" | "new_agent";
```

换成

```ts
      旧客户端照收，时间线按「`greeting` 在场就不画」一样藏起它。
      `"callback"`（#1411）：智能体打给这个人的电话接通了，runtime 替接听的人落的「把你打电话要说的事
      说清楚」开场白（`mentions` 是打电话的那只，`fromUid` 是接的人）。同样只是记号、同样不画、同样不进协议位 */
  greeting?: "voice_call" | "new_agent" | "callback";
```

④ `export type SessionEvent =` 联合里 `  | VoiceCallChangedEvent` 下一行加 `  | CallRingEvent`。

⑤ `KNOWN_EVENT_TYPES_MAP` 里 `  voice_call_changed: true,` 下一行加 `  call_ring: true,`。

- [ ] **Step 4: 各张穷举表表态**

`src/session/persistencePolicy.ts`：在 `    case "voice_call_changed": // 语音通话名单（#1163）…` 那一行下面加

```ts
    case "call_ring": // 回电（#1411）：冷却、重启后接着计时 / 补未接、聊天里那张卡都从日志重放
```

`src/shared/contextEstimate.ts`：在

```ts
      case "chat_roster_changed":
        // 云会话专属（#1280）：模型不可见，不占上下文
        break;
```

下面加

```ts
      case "call_ring":
        // 回电（#1411）：云会话专属、模型不可见，不占上下文
        break;
```

`src/session/agentView.ts`：在 `  executor_changed: "keep",` 下一行加

```ts
  // 回电（#1411）：故意叫 fromAgentId 不叫 agentId，早退路径本来就放行，这里仍要表态（Record 是
  // 穷尽表）。写 keep 不写 drop：这张表根本轮不到它，写 drop 是一句不成立的话。模型看不看得见
  // 由 deriveMessages 决定（它不投影这条）
  call_ring: "keep",
```

`src/shared/sessionPackage.ts`：在 `  executor_changed: "strip", // 哪台设备在跑…` 下一行加

```ts
  call_ring: "strip", // 谁给谁打过电话、锁屏上那句话：带着接电话那个人的 uid 与一句私人的话，不是这段对话（#1411）
```

`src/shared/taskSync.ts`：在 `  chat_roster_changed: "executor",` 下一行加 `  call_ring: "executor",`

`src/renderer/src/components/Timeline.tsx`：在

```ts
    case "chat_roster_changed":
      return null;
```

下面加

```ts

    // 回电（#1411）：手机上画成一张卡，本机会话不会出现它
    case "call_ring":
      return null;
```

`src/shared/cloudTimeline.ts`：`hiddenFromCloudTimeline` 的文档注释里 ⑧ 那段后面（「留在时间线上的因此只剩」那一句之前）加

```
    ⑨ `call_ring`（#1411）——桌面这一版不画回电：手机上它是一张卡（mobileChat.chatRows 在调这个
       函数**之前**先认出它），桌面等 #1403 的微信式布局合了再接。
```

函数体里把

```ts
    e.type === "session_autotitled"
  );
```

换成

```ts
    e.type === "session_autotitled" ||
    e.type === "call_ring"
  );
```

- [ ] **Step 5: 新建 `src/shared/callRing.ts`**

```ts
// callRing —— 智能体回电（#1411）：一次响铃的日志投影、回电那几句话、推送载荷的形状。纯逻辑零 IO，
// runtime（打出去 / 接通 / 未接 / 冷却）与手机（来电页、聊天里那张卡）共用——「这一通此刻是什么状态」
// 的判据只能有一处，两端各写一遍迟早分家（同 voiceCall / turnLedger 的纪律）。
//
// 一次响铃是两到三条 `call_ring`：`ringing` 开头，`answered` 或 `missed` 收尾；接晚了的那一通是
// ringing → missed → answered（见 RING_ANSWER_GRACE_MS）。最后一条说了算。

import type { CallRingEvent, SessionEvent } from "../session/events.js";
import { promptSafe } from "./promptSafe.js";

/** 回电那把刀的名字。定义在 shared：deriveMessages 的通话块要点名它，而 src/session 不能 import services/runtime */
export const CALL_USER_TOOL_NAME = "call_user";
/** 响多久算未接（spec §2.3） */
export const RING_TTL_MS = 45_000;
/** 同一只打给同一个人的最短间隔（spec §2.2） */
export const RING_COOLDOWN_MS = 10 * 60_000;
/** 过了响铃时限还认「接听」的宽限：人在第 44 秒点了接听，手机还要开页面、连房间、发帧，落到服务端时
    已经记了未接——那一下仍然是他接起来了，打电话的那只得知道自己为什么打这个电话 */
export const RING_ANSWER_GRACE_MS = 30_000;
/** 锁屏上那句话的上限（按字算，不按 UTF-16 码元：一个 emoji 不该被劈成两半） */
export const RING_REASON_MAX = 60;

export type RingPhase = CallRingEvent["phase"];

/** 一通电话此刻的样子。`ringingTs` 是打出去那一刻（冷却按它算），`phaseTs` 是最后一条的时刻 */
export interface RingState {
  ringId: string;
  fromAgentId: string;
  toUid: string;
  reason: string;
  expiresTs: number;
  ringingTs: number;
  phase: RingPhase;
  phaseTs: number;
}

/** ringId → 此刻状态。Map 的插入顺序 = 第一次响的顺序 */
export type RingFold = Map<string, RingState>;

/** 推进一条。窗口裁掉了开头（先来一条非 ringing）：没有 ringing 就不知道是谁打给谁，跳过 */
export function applyCallRing(fold: RingFold, e: SessionEvent): void {
  if (e.type !== "call_ring") return;
  if (e.phase === "ringing") {
    fold.set(e.ringId, {
      ringId: e.ringId, fromAgentId: e.fromAgentId, toUid: e.toUid, reason: e.reason,
      expiresTs: e.expiresTs, ringingTs: e.ts, phase: "ringing", phaseTs: e.ts,
    });
    return;
  }
  const prev = fold.get(e.ringId);
  if (prev !== undefined) fold.set(e.ringId, { ...prev, phase: e.phase, phaseTs: e.ts });
}

export function callRingFoldOf(events: readonly SessionEvent[]): RingFold {
  const fold: RingFold = new Map();
  for (const e of events) applyCallRing(fold, e);
  return fold;
}

/** 这一只此刻有没有一通「能接」的电话打给这个人：没接通过、而且还在时限加宽限之内（还在响，或者刚按
    时限记成未接）。有几通取最近打的那一通（冷却让同一对 10 分钟最多一通，这里不假设它） */
export function answerableRing(fold: RingFold, agentId: string, uid: string, now: number): RingState | null {
  let hit: RingState | null = null;
  for (const r of fold.values()) {
    if (r.fromAgentId !== agentId || r.toUid !== uid) continue;
    if (r.phase === "answered" || now > r.expiresTs + RING_ANSWER_GRACE_MS) continue;
    if (hit === null || r.ringingTs >= hit.ringingTs) hit = r;
  }
  return hit;
}

/** 这一只上一次打给这个人是什么时候（冷却用）；没打过回 null */
export function lastRingTs(fold: RingFold, agentId: string, uid: string): number | null {
  let last: number | null = null;
  for (const r of fold.values()) {
    if (r.fromAgentId === agentId && r.toUid === uid && (last === null || r.ringingTs > last)) last = r.ringingTs;
  }
  return last;
}

export type RingCardStatus = RingPhase;
export const RING_STATUS_TEXT: Record<RingCardStatus, string> = { ringing: "正在响", answered: "已接通", missed: "未接" };

/** 聊天里那张卡写什么：最后一条说了算；还挂在 ringing 但已经过了时限（runtime 那一刻没在跑，未接还
    没补上）按未接画 */
export function ringCardStatus(r: RingState, now: number): RingCardStatus {
  return r.phase === "ringing" && now > r.expiresTs ? "missed" : r.phase;
}

/** 锁屏上那句话：空白（含换行）折成一个空格、去首尾；超过 60 字截到 60（最后一格是「…」）。
    规整完是空串就是空串，调用方拒 */
export function normalizeRingReason(raw: string): string {
  const flat = raw.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= RING_REASON_MAX ? flat : `${chars.slice(0, RING_REASON_MAX - 1).join("")}…`;
}

/** 接通之后它先开口的那句开场白（spec §2.3）。形状同 voiceCallGreetingText：`[系统]` 开头、第三人称
    点名、再用「名字：」对上打电话的那只（群里每只都读得到这条）。三个字段都过 promptSafe——agent 名与
    人的显示名是成员可写字段，reason 是模型写的，`]` 与换行都能撑破 `[系统] …` 这个结构 */
export function callbackGreetingText(agentName: string, userLabel: string, reason: string): string {
  const n = promptSafe(agentName);
  return (
    `[系统] 「${n}」打给 ${promptSafe(userLabel)} 的电话接通了。${n}：你打这个电话是为了：${promptSafe(reason)}。` +
    `先把这件事说清楚，说完问他还有没有要你做的。这句话会被读出来，别用列表和记号。`
  );
}

/** 手机开哪一种聊天页（推送载荷里的 `chat`，spec §1.3） */
export type RingChatKind = "dm" | "group" | "team" | "guest";
const RING_CHAT_KINDS: readonly RingChatKind[] = ["dm", "group", "team", "guest"];

/** `home` = 这条会话在个人主场里（runtime 那边就是 approveAll，ADR-0298 同一格）。主场里没有
    chat 标记的旧会话按群算 */
export function ringChatKind(o: { home: boolean; chatKind: "dm" | "group" | null; toUid: string; ownerUid: string }): RingChatKind {
  if (!o.home) return "team";
  if (o.chatKind === "dm") return "dm";
  return o.toUid === o.ownerUid ? "group" : "guest";
}

/** 推送里 `ring` 那一格。名字与那句话也带上：来电页要画，而 App 刚被点醒时手上未必有那个团队的快照 */
export interface RingPush {
  ringId: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  reason: string;
  chat: RingChatKind;
  expiresTs: number;
}

/** 手机从通知里读回 `ring`。形状不对一律 null：推送的字节来自网络，缺一格就不弹来电页 */
export function ringFromPayload(payload: unknown): RingPush | null {
  if (typeof payload !== "object" || payload === null) return null;
  const r = (payload as { ring?: unknown }).ring;
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  const id = (k: string): string | null => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : null);
  const ringId = id("ringId");
  const workspaceId = id("workspaceId");
  const sessionId = id("sessionId");
  const agentId = id("agentId");
  const { agentName, reason, chat, expiresTs } = o;
  if (ringId === null || workspaceId === null || sessionId === null || agentId === null) return null;
  if (typeof agentName !== "string" || typeof reason !== "string") return null;
  if (typeof chat !== "string" || !RING_CHAT_KINDS.includes(chat as RingChatKind)) return null;
  if (typeof expiresTs !== "number" || !Number.isFinite(expiresTs)) return null;
  return { ringId, workspaceId, sessionId, agentId, agentName, reason, chat: chat as RingChatKind, expiresTs };
}

/** 接听、或者点开一条过期的来电通知之后开哪条聊天。形状与手机的路由（mobile/src/nav/types.ts 的
    ChatRoute）逐格同构 */
export type RingTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "group"; sessionId: string }
  | { kind: "team"; workspaceId: string; sessionId: string }
  | { kind: "guest"; workspaceId: string; sessionId: string };

export function ringTarget(r: Pick<RingPush, "chat" | "workspaceId" | "sessionId" | "agentId">): RingTarget {
  switch (r.chat) {
    case "dm":
      return { kind: "agent", agentId: r.agentId };
    case "group":
      return { kind: "group", sessionId: r.sessionId };
    case "team":
      return { kind: "team", workspaceId: r.workspaceId, sessionId: r.sessionId };
    case "guest":
      return { kind: "guest", workspaceId: r.workspaceId, sessionId: r.sessionId };
  }
}

/** 手机上排着的来电（spec §3.2：同一时刻只弹一张，后到的按到达顺序排在后面）。同一通只排一次；
    过了时限的不排，顺手把队列里过期的清掉 */
export function queueRing(queue: readonly RingPush[], ring: RingPush, now: number): RingPush[] {
  const live = queue.filter((r) => r.expiresTs > now);
  if (ring.expiresTs <= now || live.some((r) => r.ringId === ring.ringId)) return live;
  return [...live, ring];
}

/** 摘掉一通（接了 / 挂了），顺手清掉过期的 */
export function dropRing(queue: readonly RingPush[], ringId: string, now: number): RingPush[] {
  return queue.filter((r) => r.ringId !== ringId && r.expiresTs > now);
}
```

- [ ] **Step 6: 改 `src/session/deriveMessages.ts`**

① import：在 `import { INVITE_TO_CALL_TOOL_NAME } from "../shared/voiceCall.js";` 下面加 `import { CALL_USER_TOOL_NAME } from "../shared/callRing.js";`

② `renderVoiceCallPrompt`：文档注释 `短句、口语、代码只放围栏。` 那一行后面加一行 `    ④ 推送开着时（\`callback\`）说一句挂断之后可以用 call_user 回电（#1411）。`；签名加第四个参数 `callback = false`：

```ts
export function renderVoiceCallPrompt(
  participants: readonly VoiceCallParticipant[],
  selfName: string | null,
  roster: readonly { name: string; description: string }[],
  callback = false
): string {
```

函数最后那行

```ts
    `你的回复会被读出来，像打电话：先说结论，一两句就停，对方要细节再展开；口语，代码只放围栏里。]`
```

换成

```ts
    `你的回复会被读出来，像打电话：先说结论，一两句就停，对方要细节再展开；口语，代码只放围栏里。` +
    // 回电（#1411）：只在推送开着时说——那把刀不在工具表里时说这句，就是让它许诺一通打不出去的电话
    (callback ? `挂断之后事情办完了，或者要他拍板，可以用 ${CALL_USER_TOOL_NAME} 回电。` : "") +
    `]`
```

③ 状态：`  let voiceCall: VoiceCallParticipant[] | null = null;` 下一行加

```ts
  // 这场通话能不能回电（#1411）：跟着最新一条名单事件走，同 voiceCall
  let voiceCallback = false;
```

④ `case "voice_call_changed":` 里 `voiceCall = event.participants.length > 0 ? event.participants : null;` 下一行加 `        voiceCallback = event.callback === true;`

⑤ 拼尾部那一行换成

```ts
  if (systemMessage && isCloud && voiceCall) systemMessage.content += renderVoiceCallPrompt(voiceCall, briefName, briefRoster, voiceCallback);
```

⑥ 不投影的那一组：在

```ts
      // 接力棒本身不投影（#950，spec §8）：模型可见的那一面是配对的、带 relay
```

上面插入

```ts
      // 回电（#1411）：打没打通由 call_user 的 tool_result 说，接通由回电开场白说；这条只是给
      // 手机画卡、给 runtime 算冷却的事实
      case "call_ring":
```

- [ ] **Step 7: 跑测试确认通过、类型干净**

Run: `npx vitest run tests/shared/callRing.test.ts tests/session/callRingEvent.test.ts tests/session/deriveMessages.voiceCall.test.ts tests/session/persistencePolicy.test.ts tests/shared/taskSync.test.ts tests/shared/cloudTimeline.test.ts tests/renderer/timelineLists.test.ts`
Expected: PASS

Run: `npx tsc --noEmit && npx tsc --noEmit -p services/runtime`
Expected: 无输出。有别的穷举 `Record<SessionEvent["type"], …>` 报缺 `call_ring`：照 `voice_call_changed` 在那张表里的写法补一格（它是群事实、模型不可见、云会话专属），在报告里列出补了哪几处。

- [ ] **Step 8: 提交**

```bash
git add src/shared/callRing.ts src/session/events.ts src/session/persistencePolicy.ts src/session/deriveMessages.ts src/shared/contextEstimate.ts src/session/agentView.ts src/shared/sessionPackage.ts src/shared/taskSync.ts src/renderer/src/components/Timeline.tsx src/shared/cloudTimeline.ts tests/shared/callRing.test.ts tests/session/callRingEvent.test.ts tests/session/persistencePolicy.test.ts tests/session/deriveMessages.voiceCall.test.ts
git commit -m "feat(shared): 回电的事件 call_ring 与它的纯投影（#1411）" -m "一次响铃是 ringing → answered / missed，最后一条说了算；runtime 与手机共用 callRing.ts。字段叫 fromAgentId 不叫 agentId：一通电话不是那只的一轮。通话块那句「可以用 call_user 回电」只在名单事件带 callback 时说——推送关着时那把刀不在工具表里。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 0045 令牌表 + 它的可执行版

**Files:**
- Create: `supabase/migrations/0045_push_devices.sql`
- Test: `tests/docs/pushDevicesMigration.test.ts`

**Interfaces:**
- Produces：表 `public.push_devices(token pk, user_id, platform, bundle_id, apns_env, updated_at)`；RPC `register_push_device(p_token text, p_bundle text)`、`unregister_push_device(p_token text)`（Task 6 的 runtime 读写与 Task 7 的手机登记都按这些名字）。

- [ ] **Step 1: 写失败测试**

新建 `tests/docs/pushDevicesMigration.test.ts`：

```ts
// 0045_push_devices.sql 的可执行版（#1411，spec §1.1）。migration 是在生产手动执行的，门禁跑不到它；
// 这几条钉的是「客户端只走两个 RPC」「换了账号令牌就归新账号」「注销只删自己的」在 SQL 上的样子。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0045_push_devices.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0045_push_devices", () => {
  it("一行 = 一个设备令牌；人删了跟着删", () => {
    expect(code).toMatch(/create table if not exists public\.push_devices/);
    expect(code).toMatch(/token\s+text primary key/);
    expect(code).toMatch(/user_id\s+uuid not null references auth\.users\(id\) on delete cascade/);
    expect(code).toMatch(/apns_env\s+text,/);
  });
  it("RLS 开着；只有一条读自己的 select 策略；不给 authenticated 任何写策略", () => {
    expect(code).toMatch(/alter table public\.push_devices enable row level security/);
    expect(code).toMatch(/create policy pd_select_self on public\.push_devices for select to authenticated using \(user_id = auth\.uid\(\)\)/);
    expect(code).not.toMatch(/on public\.push_devices for (insert|update|delete|all)/);
  });
  it("register：security definer；先删这个令牌挂在别人名下的那一行，再 upsert 到自己名下", () => {
    const body = code.slice(code.indexOf("function public.register_push_device"));
    expect(body).toMatch(/security definer set search_path = public/);
    const del = body.indexOf("delete from push_devices where token = p_token and user_id <> auth.uid()");
    const ins = body.indexOf("insert into push_devices");
    expect(del).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(del);
    // 同一个人重复登记不清环境：同一个令牌的环境不会变
    expect(body).toMatch(/on conflict \(token\) do update set bundle_id = excluded\.bundle_id, updated_at = now\(\)/);
  });
  it("unregister：security definer，只删自己名下的这一行", () => {
    const body = code.slice(code.indexOf("function public.unregister_push_device"));
    expect(body).toMatch(/security definer set search_path = public/);
    expect(body).toMatch(/delete from push_devices where token = p_token and user_id = auth\.uid\(\)/);
  });
  it("两个 RPC 都只给 authenticated", () => {
    for (const sig of ["register_push_device\\(text, text\\)", "unregister_push_device\\(text\\)"]) {
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${sig} from public`));
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${sig} to authenticated`));
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/docs/pushDevicesMigration.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 写 migration**

新建 `supabase/migrations/0045_push_devices.sql`：

```sql
-- 0045_push_devices.sql —— 手机的推送令牌（#1411，spec §1.1，ADR-0331）。
-- 智能体办完事打电话回给你：runtime 直发 APNs，要知道你有哪几台手机、各自的令牌。
--
-- 写方两个：手机只走下面两个 RPC（登记 / 注销自己这台），runtime 用 service key 读令牌、回写发成功的
-- 那个环境、删掉失效的。不给 authenticated 任何写策略：直接 insert 的话，一台手机能把自己的令牌挂到
-- 别人名下（别人的来电响在它手上）。
-- 0011 的 devices.push_token 一直没人读写（那张表给已删掉的远程配对用），这里不复用。

create table if not exists public.push_devices (
  token      text primary key,                                          -- APNs 设备令牌（十六进制）
  user_id    uuid not null references auth.users(id) on delete cascade,
  platform   text not null default 'ios',
  bundle_id  text not null,
  apns_env   text,                                                      -- 'production' / 'sandbox'；null = 还没发成功过
  updated_at timestamptz not null default now()
);
-- runtime 按人取令牌
create index if not exists push_devices_user_idx on public.push_devices (user_id);

alter table public.push_devices enable row level security;
drop policy if exists pd_select_self on public.push_devices;
create policy pd_select_self on public.push_devices for select to authenticated using (user_id = auth.uid());

-- 登记这台手机：先删掉这个令牌挂在别人名下的那一行，再按令牌 upsert 到自己名下。同一台手机换了账号，
-- 令牌就归新账号——不删的话，上一个账号的来电会响在这台手机上，锁屏上还会显示对方那句话。
-- 新行的 apns_env 是空（下一次发的时候按「先生产、不认再沙盒」探）；同一个人重复登记不清它：
-- 同一个令牌的环境不会变
create or replace function public.register_push_device(p_token text, p_bundle text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]{16,256}$' then raise exception 'bad token'; end if;
  if p_bundle is null or length(p_bundle) = 0 or length(p_bundle) > 200 then raise exception 'bad bundle'; end if;
  delete from push_devices where token = p_token and user_id <> auth.uid();
  insert into push_devices (token, user_id, platform, bundle_id, apns_env, updated_at)
  values (p_token, auth.uid(), 'ios', p_bundle, null, now())
  on conflict (token) do update set bundle_id = excluded.bundle_id, updated_at = now();
end $$;
revoke all on function public.register_push_device(text, text) from public;
grant execute on function public.register_push_device(text, text) to authenticated;

-- 注销这台手机（退出登录前）：只删自己名下的这一行
create or replace function public.unregister_push_device(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from push_devices where token = p_token and user_id = auth.uid()
$$;
revoke all on function public.unregister_push_device(text) from public;
grant execute on function public.unregister_push_device(text) to authenticated;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/docs/pushDevicesMigration.test.ts tests/docs/migrationNumbers.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add supabase/migrations/0045_push_devices.sql tests/docs/pushDevicesMigration.test.ts
git commit -m "feat(db): 0045 推送令牌表与登记 / 注销两个 RPC（#1411）" -m "客户端只走两个 security definer RPC：直接 insert 的话一台手机能把令牌挂到别人名下。登记先删这个令牌挂在别人名下的那一行——换了账号，来电就不该再响在上一个人的手机上。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: runtime —— `apns.ts` 与推送配置

**Files:**
- Create: `services/runtime/src/apns.ts`
- Modify: `services/runtime/src/config.ts`
- Test: `tests/runtime/apns.test.ts`（新建）、`tests/runtime/config.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `RingPush`。
- Produces：`config.ts` 的 `interface ApnsSettings { keyFile; keyId; teamId; bundleId }`、`RuntimeConfig.apns: ApnsSettings | null`；`apns.ts` 的 `type ApnsEnv = "production" | "sandbox"`、`APNS_HOSTS`、`APNS_JWT_TTL_MS`、`RING_SOUND`、`interface ApnsKey { keyPem; keyId; teamId; bundleId }`、`apnsJwt(key, nowMs)`、`ringNotification(ring)`、`ringHeaders(ring, bundleId, jwt)`、`interface ApnsReply { status; reason }`、`type ApnsVerdict`、`apnsVerdict(reply)`、`envOrder(recorded)`、`interface PushDevice { token; env: ApnsEnv | null }`、`interface PushDeviceStore { list(uid); setEnv(token, env); remove(token) }`、`type ApnsRequest`、`interface ApnsPusher { pushRing(uid, ring): Promise<number>; deviceCount(uid): Promise<number> }`、`createApnsPusher({ key, devices, request?, now?, log })`、`http2Request()`。

- [ ] **Step 1: 写失败测试**

`tests/runtime/config.test.ts` 的 `describe("resolveConfig", …)` 末尾加：

```ts
  // #1411：回电的推送，三个 APNS_* 要么全有要么全无
  it("三个 APNS_* 全无 = 推送关着（apns 为 null）", () => {
    expect(resolveConfig({ ...full }).apns).toBeNull();
  });

  it("三个全有 = 开着，APNS_BUNDLE_ID 缺省是手机那个 bundle", () => {
    const cfg = resolveConfig({ ...full, APNS_KEY_FILE: "/etc/otto-runtime/apns.p8", APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "HV982TTRNP" });
    expect(cfg.apns).toEqual({ keyFile: "/etc/otto-runtime/apns.p8", keyId: "ABC123DEFG", teamId: "HV982TTRNP", bundleId: "com.stanyan.mrotto.mobile" });
    const custom = resolveConfig({ ...full, APNS_KEY_FILE: "/k.p8", APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_BUNDLE_ID: "com.example.app" });
    expect(custom.apns?.bundleId).toBe("com.example.app");
  });

  it("只给一部分 = 配错了：启动失败并报缺哪几个（带着半份推送配置跑起来，每一通电话都会安静地失败）", () => {
    try {
      resolveConfig({ ...full, APNS_KEY_ID: "K" });
      throw new Error("应该抛 MissingConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingConfigError);
      expect((err as MissingConfigError).missing).toEqual(["APNS_KEY_FILE", "APNS_TEAM_ID"]);
    }
  });
```

新建 `tests/runtime/apns.test.ts`：

```ts
// apns —— 回电推送的纯层与发送编排（#1411，spec §1.3）。http2 注入假的；JWT 拿一对现生成的 P-256 钥匙验。
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APNS_JWT_TTL_MS, apnsJwt, apnsVerdict, createApnsPusher, envOrder, ringHeaders, ringNotification,
  type ApnsEnv, type ApnsReply, type PushDevice, type PushDeviceStore,
} from "../../services/runtime/src/apns.js";
import type { RingPush } from "../../src/shared/callRing.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY = {
  keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  keyId: "KEY1234567",
  teamId: "HV982TTRNP",
  bundleId: "com.stanyan.mrotto.mobile",
};
const RING: RingPush = {
  ringId: "r1", workspaceId: "w1", sessionId: "s1", agentId: "ops", agentName: "运维",
  reason: "部署完了，要你拍板", chat: "dm", expiresTs: 1_700_000_045_000,
};
const part = (jwt: string, i: number): unknown => JSON.parse(Buffer.from(jwt.split(".")[i]!, "base64url").toString("utf8"));

describe("apnsJwt", () => {
  it("ES256、header 带 kid、claims 是 iss + iat（秒），公钥验得过", () => {
    const jwt = apnsJwt(KEY, 1_700_000_000_123);
    expect(part(jwt, 0)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(part(jwt, 1)).toEqual({ iss: "HV982TTRNP", iat: 1_700_000_000 });
    const [h, c, s] = jwt.split(".");
    const ok = createVerify("SHA256").update(`${h}.${c}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("载荷与请求头", () => {
  it("标题「名字 来电」、正文那句话、30 秒铃声、时效性、按会话归组；ring 原样带上", () => {
    expect(ringNotification(RING)).toEqual({
      aps: {
        alert: { title: "运维 来电", body: "部署完了，要你拍板" },
        sound: "ringtone.caf",
        "interruption-level": "time-sensitive",
        "thread-id": "s1",
      },
      ring: RING,
    });
  });
  it("头：topic = bundle、alert、立即送、过期 = 响铃时限（秒）、同一通合并", () => {
    expect(ringHeaders(RING, "com.stanyan.mrotto.mobile", "JWT")).toEqual({
      authorization: "bearer JWT",
      "apns-topic": "com.stanyan.mrotto.mobile",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "1700000045",
      "apns-collapse-id": "r1",
    });
  });
});

describe("apnsVerdict / envOrder", () => {
  it("200 送到；410 作废；400 BadDeviceToken 换环境；别的错不怪令牌", () => {
    expect(apnsVerdict({ status: 200, reason: null })).toBe("ok");
    expect(apnsVerdict({ status: 410, reason: "Unregistered" })).toBe("dead");
    expect(apnsVerdict({ status: 400, reason: "BadDeviceToken" })).toBe("other_env");
    expect(apnsVerdict({ status: 400, reason: "DeviceTokenNotForTopic" })).toBe("error");
    expect(apnsVerdict({ status: 403, reason: "ExpiredProviderToken" })).toBe("error");
    expect(apnsVerdict({ status: 500, reason: null })).toBe("error");
  });
  it("记过的环境先试；没记过先生产", () => {
    expect(envOrder(null)).toEqual(["production", "sandbox"]);
    expect(envOrder("production")).toEqual(["production", "sandbox"]);
    expect(envOrder("sandbox")).toEqual(["sandbox", "production"]);
  });
});

function fakeStore(devices: PushDevice[]): PushDeviceStore & { envs: [string, ApnsEnv][]; removed: string[] } {
  const envs: [string, ApnsEnv][] = [];
  const removed: string[] = [];
  return {
    envs,
    removed,
    list: async () => devices,
    setEnv: async (token, env) => { envs.push([token, env]); },
    remove: async (token) => { removed.push(token); },
  };
}

/** 按「环境:令牌」回一份预设的回复（没预设的回 500），记下每一次请求 */
function fakeRequest(replies: Record<string, ApnsReply>) {
  const calls: { env: ApnsEnv; path: string; headers: Record<string, string>; body: string }[] = [];
  const request = async (env: ApnsEnv, path: string, headers: Record<string, string>, body: string): Promise<ApnsReply> => {
    calls.push({ env, path, headers, body });
    return replies[`${env}:${path.replace("/3/device/", "")}`] ?? { status: 500, reason: null };
  };
  return { calls, request };
}

describe("createApnsPusher", () => {
  it("记过环境、一发就中：送到 1 台，不回写", async () => {
    const store = fakeStore([{ token: "aa", env: "production" }]);
    const f = fakeRequest({ "production:aa": { status: 200, reason: null } });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, log: () => {} });
    expect(await p.pushRing("u1", RING)).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.path).toBe("/3/device/aa");
    expect(JSON.parse(f.calls[0]!.body)).toEqual(ringNotification(RING));
    expect(f.calls[0]!.headers["apns-topic"]).toBe("com.stanyan.mrotto.mobile");
    expect(store.envs).toEqual([]);
  });
  it("没记过：生产说不认识 → 沙盒送到，回写 sandbox", async () => {
    const store = fakeStore([{ token: "bb", env: null }]);
    const f = fakeRequest({ "production:bb": { status: 400, reason: "BadDeviceToken" }, "sandbox:bb": { status: 200, reason: null } });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, log: () => {} });
    expect(await p.pushRing("u1", RING)).toBe(1);
    expect(f.calls.map((c) => c.env)).toEqual(["production", "sandbox"]);
    expect(store.envs).toEqual([["bb", "sandbox"]]);
  });
  it("两个环境都不认识 / 410：删掉这个令牌", async () => {
    const store = fakeStore([{ token: "cc", env: null }, { token: "dd", env: "sandbox" }]);
    const f = fakeRequest({
      "production:cc": { status: 400, reason: "BadDeviceToken" },
      "sandbox:cc": { status: 400, reason: "BadDeviceToken" },
      "sandbox:dd": { status: 410, reason: "Unregistered" },
    });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, log: () => {} });
    expect(await p.pushRing("u1", RING)).toBe(0);
    expect([...store.removed].sort()).toEqual(["cc", "dd"]);
  });
  it("别的错（5xx / 连接断了）：不删令牌，这一台算没送到", async () => {
    const store = fakeStore([{ token: "ee", env: "production" }, { token: "ff", env: "production" }]);
    const p = createApnsPusher({
      key: KEY, devices: store, log: () => {},
      request: async (_env, path) => {
        if (path.endsWith("ee")) return { status: 503, reason: "ServiceUnavailable" };
        throw new Error("socket hang up");
      },
    });
    expect(await p.pushRing("u1", RING)).toBe(0);
    expect(store.removed).toEqual([]);
  });
  it("一台送到一台作废：回 1", async () => {
    const store = fakeStore([{ token: "g1", env: "production" }, { token: "g2", env: "production" }]);
    const f = fakeRequest({ "production:g1": { status: 200, reason: null }, "production:g2": { status: 410, reason: "Unregistered" } });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, log: () => {} });
    expect(await p.pushRing("u1", RING)).toBe(1);
    expect(store.removed).toEqual(["g2"]);
  });
  it("JWT 50 分钟内复用，到点换一张", async () => {
    let t = 1_700_000_000_000;
    const store = fakeStore([{ token: "hh", env: "production" }]);
    const f = fakeRequest({ "production:hh": { status: 200, reason: null } });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, now: () => t, log: () => {} });
    await p.pushRing("u1", RING);
    t += APNS_JWT_TTL_MS - 1;
    await p.pushRing("u1", RING);
    t += 2;
    await p.pushRing("u1", RING);
    const auths = f.calls.map((c) => c.headers.authorization);
    expect(auths[0]).toBe(auths[1]);
    expect(auths[2]).not.toBe(auths[1]);
  });
  it("deviceCount：这个人登记了几台", async () => {
    const p = createApnsPusher({
      key: KEY, devices: fakeStore([{ token: "a", env: null }, { token: "b", env: null }]),
      request: async () => ({ status: 200, reason: null }), log: () => {},
    });
    expect(await p.deviceCount("u1")).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/apns.test.ts tests/runtime/config.test.ts`
Expected: FAIL（`apns.js` 不存在；`cfg.apns` 是 undefined）

- [ ] **Step 3: 改 `services/runtime/src/config.ts`**

`RuntimeConfig` 前面加：

```ts
/** 回电的推送（#1411，ADR-0331）。三个 APNS_* 全有才有这一份 */
export interface ApnsSettings {
  /** .p8 私钥在这台机器上的路径（daemon 启动时读一次，读不到就起不来） */
  keyFile: string;
  keyId: string;
  teamId: string;
  /** 推送的 topic = 手机 App 的 bundle id */
  bundleId: string;
}
```

`RuntimeConfig` 里 `dataDir: string;` 下面加：

```ts
  /** 回电的推送（#1411）。null = 推送关着：call_user 那把刀不出现（不能让模型许诺一通打不出去的电话） */
  apns: ApnsSettings | null;
```

`const DEFAULT_DATA_DIR = "/var/lib/otto-runtime";` 下面加：

```ts

/** 回电推送的三个变量（#1411）：**要么全有要么全无**。全无 = 推送关着；只给一部分 = 配错了，同必需项
    一样启动失败——带着半份推送配置跑起来，每一通电话都会安静地失败 */
const APNS_KEYS = ["APNS_KEY_FILE", "APNS_KEY_ID", "APNS_TEAM_ID"] as const;
const DEFAULT_APNS_BUNDLE_ID = "com.stanyan.mrotto.mobile";
```

`resolveConfig` 的函数体换成：

```ts
export function resolveConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const apnsGiven = APNS_KEYS.some((k) => env[k]);
  const missing = [
    ...REQUIRED_KEYS.filter((k) => !env[k]),
    ...(apnsGiven ? APNS_KEYS.filter((k) => !env[k]) : []),
  ];
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }
  const dataDir = env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : DEFAULT_DATA_DIR;
  return {
    runtimeSecret: env.RUNTIME_SECRET!,
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET!,
    supabaseUrl: env.SUPABASE_URL!,
    supabaseServiceKey: env.SUPABASE_SERVICE_KEY!,
    edgeBase: env.EDGE_BASE!,
    relayBase: env.RELAY_BASE!,
    dataDir,
    apns: apnsGiven
      ? {
          keyFile: env.APNS_KEY_FILE!,
          keyId: env.APNS_KEY_ID!,
          teamId: env.APNS_TEAM_ID!,
          bundleId: env.APNS_BUNDLE_ID && env.APNS_BUNDLE_ID.length > 0 ? env.APNS_BUNDLE_ID : DEFAULT_APNS_BUNDLE_ID,
        }
      : null,
  };
}
```

- [ ] **Step 4: 新建 `services/runtime/src/apns.ts`**

```ts
// apns —— 回电的推送：runtime 直发 APNs（#1411，spec §1.3，ADR-0331）。
//
// 分两层（同 config.ts 的纯核心 + 薄壳）：
// · 纯的：JWT 的形状与签名、请求头与载荷、一次回复算什么（送到 / 令牌作废 / 换个环境再试 / 别的错）、
//   一台设备按什么顺序试环境、发送编排——这些进 vitest；
// · IO：node:http2 的长连接（每个主机一条，断了下次用时重连）。测试注入假的 `request`。
//
// 为什么要试两个环境：从 Xcode 装的包的令牌只有沙盒认，TestFlight / App Store 的只有生产认，手机自己
// 分不出是哪一种。所以先按那一行记下的 `apns_env` 发；没记过的先试生产，回 400 BadDeviceToken 再试沙盒，
// 送到了把环境回写。两边都 BadDeviceToken，或者回 410 Unregistered，这个令牌就删掉。

import { createSign } from "node:crypto";
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import type { RingPush } from "../../../src/shared/callRing.js";

export type ApnsEnv = "production" | "sandbox";
export const APNS_HOSTS: Record<ApnsEnv, string> = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };
/** JWT 多久换一次：APNs 要求不超过 1 小时，也不许换得太勤（spec §1.3） */
export const APNS_JWT_TTL_MS = 50 * 60_000;
/** 锁屏铃声的文件名（mobile/assets/sounds/，由 expo-notifications 插件打进包里） */
export const RING_SOUND = "ringtone.caf";

export interface ApnsKey {
  keyPem: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** ES256 的 provider token：header `{alg, kid}`、claims `{iss: teamId, iat}`（秒）。签名要 IEEE P1363
    格式（r‖s 各 32 字节），node 默认给的是 DER，APNs 不认 */
export function apnsJwt(key: Pick<ApnsKey, "keyPem" | "keyId" | "teamId">, nowMs: number): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: key.keyId }));
  const claims = b64url(JSON.stringify({ iss: key.teamId, iat: Math.floor(nowMs / 1000) }));
  const input = `${head}.${claims}`;
  const sig = createSign("SHA256").update(input).sign({ key: key.keyPem, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/** 一通来电的推送：标题「名字 来电」、正文是它要说的那句话、30 秒铃声、时效性通知（专注模式里也响）、
    按会话归组。`ring` 那一格给手机开来电页用 */
export function ringNotification(ring: RingPush): { aps: Record<string, unknown>; ring: RingPush } {
  return {
    aps: {
      alert: { title: `${ring.agentName} 来电`, body: ring.reason },
      sound: RING_SOUND,
      "interruption-level": "time-sensitive",
      "thread-id": ring.sessionId,
    },
    ring,
  };
}

/** 请求头。`apns-expiration` 是响铃过期那一刻（秒）：过了还没送到的，APNs 不再送 */
export function ringHeaders(ring: RingPush, bundleId: string, jwt: string): Record<string, string> {
  return {
    authorization: `bearer ${jwt}`,
    "apns-topic": bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(ring.expiresTs / 1000)),
    "apns-collapse-id": ring.ringId,
  };
}

export interface ApnsReply {
  status: number;
  reason: string | null;
}
export type ApnsVerdict = "ok" | "other_env" | "dead" | "error";

/** 一次回复算什么：200 送到了；410 Unregistered = 这个令牌作废；400 BadDeviceToken = 这个令牌不属于
    这个环境（换一个试）；其余（403 令牌过期、429、5xx…）是我们这边或 APNs 的事，不怪令牌、不删 */
export function apnsVerdict(r: ApnsReply): ApnsVerdict {
  if (r.status === 200) return "ok";
  if (r.status === 410) return "dead";
  if (r.status === 400 && r.reason === "BadDeviceToken") return "other_env";
  return "error";
}

/** 这台设备按什么顺序试环境：记过的先试，没记过的先生产；另一个环境永远排第二 */
export function envOrder(recorded: ApnsEnv | null): [ApnsEnv, ApnsEnv] {
  return recorded === "sandbox" ? ["sandbox", "production"] : ["production", "sandbox"];
}

export interface PushDevice {
  token: string;
  env: ApnsEnv | null;
}

/** 令牌表那一侧（daemon 接 Supabase，测试接内存） */
export interface PushDeviceStore {
  list(uid: string): Promise<PushDevice[]>;
  setEnv(token: string, env: ApnsEnv): Promise<void>;
  remove(token: string): Promise<void>;
}

/** 发一个请求：`path` 形如 `/3/device/<token>`。真的那层是 http2Request，测试给假的 */
export type ApnsRequest = (env: ApnsEnv, path: string, headers: Record<string, string>, body: string) => Promise<ApnsReply>;

type DeviceOutcome = "delivered" | "dead" | "failed";

export interface ApnsPusher {
  /** 给这个人的每一台设备推一次来电，回送到了几台。令牌表的维护（回写环境、删作废的令牌）顺手做 */
  pushRing(uid: string, ring: RingPush): Promise<number>;
  /** 这个人登记了几台设备（打之前问：一台都没有就不落 ringing）。抛错 = 这一刻查不出来 */
  deviceCount(uid: string): Promise<number>;
}

export function createApnsPusher(o: {
  key: ApnsKey;
  devices: PushDeviceStore;
  request?: ApnsRequest;
  now?: () => number;
  log: (m: string) => void;
}): ApnsPusher {
  const request = o.request ?? http2Request();
  const now = o.now ?? (() => Date.now());
  let jwt: { token: string; at: number } | null = null;
  const tokenNow = (): string => {
    const t = now();
    if (jwt === null || t - jwt.at >= APNS_JWT_TTL_MS) jwt = { token: apnsJwt(o.key, t), at: t };
    return jwt.token;
  };

  async function sendOne(device: PushDevice, ring: RingPush): Promise<DeviceOutcome> {
    const body = JSON.stringify(ringNotification(ring));
    for (const env of envOrder(device.env)) {
      let reply: ApnsReply;
      try {
        reply = await request(env, `/3/device/${device.token}`, ringHeaders(ring, o.key.bundleId, tokenNow()), body);
      } catch (err) {
        o.log(`[otto-runtime] APNs 请求失败（${env}）：${err instanceof Error ? err.message : String(err)}`);
        return "failed";
      }
      const v = apnsVerdict(reply);
      if (v === "ok") {
        if (device.env !== env) await o.devices.setEnv(device.token, env).catch(() => undefined);
        return "delivered";
      }
      if (v === "dead") {
        await o.devices.remove(device.token).catch(() => undefined);
        return "dead";
      }
      if (v === "error") {
        o.log(`[otto-runtime] APNs 拒了这次推送（${env}）：${reply.status} ${reply.reason ?? ""}`);
        return "failed";
      }
      // other_env：换另一个环境再试
    }
    // 两个环境都说不认识这个令牌
    await o.devices.remove(device.token).catch(() => undefined);
    return "dead";
  }

  return {
    async deviceCount(uid) {
      return (await o.devices.list(uid)).length;
    },
    async pushRing(uid, ring) {
      const devices = await o.devices.list(uid);
      const outcomes = await Promise.all(devices.map((d) => sendOne(d, ring)));
      return outcomes.filter((x) => x === "delivered").length;
    },
  };
}

/** 真的那一层：每个主机一条 http2 长连接，断了（error / close / goaway）下次用时重连。10 秒没回当失败 */
export function http2Request(): ApnsRequest {
  const sessions = new Map<ApnsEnv, ClientHttp2Session>();
  const sessionFor = (env: ApnsEnv): ClientHttp2Session => {
    const live = sessions.get(env);
    if (live !== undefined && !live.closed && !live.destroyed) return live;
    const fresh = connect(`https://${APNS_HOSTS[env]}`);
    const drop = (): void => {
      if (sessions.get(env) === fresh) sessions.delete(env);
    };
    fresh.on("error", drop);
    fresh.on("close", drop);
    fresh.on("goaway", drop);
    sessions.set(env, fresh);
    return fresh;
  };
  return (env, path, headers, body) =>
    new Promise<ApnsReply>((resolve, reject) => {
      let req: ClientHttp2Stream;
      try {
        req = sessionFor(env).request({ ":method": "POST", ":path": path, "content-type": "application/json", ...headers });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let status = 0;
      let data = "";
      req.setEncoding("utf8");
      req.on("response", (h) => {
        status = Number(h[":status"] ?? 0);
      });
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => {
        let reason: string | null = null;
        try {
          reason = (JSON.parse(data) as { reason?: string }).reason ?? null;
        } catch {
          // 200 没有 body
        }
        resolve({ status, reason });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => {
        req.close();
        reject(new Error("APNs 10 秒没回"));
      });
      req.end(body);
    });
}
```

- [ ] **Step 5: 跑测试确认通过、类型干净**

Run: `npx vitest run tests/runtime/apns.test.ts tests/runtime/config.test.ts`
Expected: PASS

Run: `npx tsc --noEmit -p services/runtime && npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add services/runtime/src/apns.ts services/runtime/src/config.ts tests/runtime/apns.test.ts tests/runtime/config.test.ts
git commit -m "feat(runtime): 直发 APNs 的推送与三个 APNS_* 变量（#1411）" -m "JWT 用 node:crypto 签（ES256，P1363 格式），50 分钟换一张；按令牌记下的环境发，没记过先生产、不认再沙盒，送到了回写；两边都不认或 410 就删令牌。三个变量要么全有要么全无：只给一部分，启动就报缺哪几个。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: runtime —— `callRinger.ts` 与 `callUserTool.ts`

**Files:**
- Create: `services/runtime/src/callRinger.ts`、`services/runtime/src/callUserTool.ts`
- Test: `tests/runtime/callRinger.test.ts`、`tests/runtime/callUserTool.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `CallRingEvent`、`RING_TTL_MS`、`RING_COOLDOWN_MS`、`applyCallRing`、`answerableRing`、`callRingFoldOf`、`lastRingTs`、`normalizeRingReason`、`CALL_USER_TOOL_NAME`、`type RingChatKind`、`type RingPush`、`type RingState`。
- Produces：`RING_PUSH_WAIT_MS`、`interface RingerDeps`、`interface Ringer { call(agentId, agentName, toUid, reason): Promise<string>; answer(agentId, uid): RingState | null; resume(): void; missAll(): void }`、`createRinger(deps)`；`interface CallUserDeps { initiator: () => string | null; ring: (toUid, reason) => Promise<string> }`、`createCallUserTool(deps): Tool`。

- [ ] **Step 1: 写失败测试**

新建 `tests/runtime/callRinger.test.ts`：

```ts
// callRinger —— 一次回电从打出去到接通 / 未接（#1411，spec §2.2–2.3）。时钟与定时器都是手拨的：
// 45 秒到点、5 秒推送封顶、冷却 10 分钟都不用真等。
import { describe, expect, it } from "vitest";
import { RING_PUSH_WAIT_MS, createRinger } from "../../services/runtime/src/callRinger.js";
import { RING_ANSWER_GRACE_MS, RING_COOLDOWN_MS, RING_TTL_MS, type RingChatKind, type RingPush } from "../../src/shared/callRing.js";
import type { CallRingEvent, SessionEvent } from "../../src/session/events.js";

/** 手拨的钟：advance 到点的定时器按时间顺序跑 */
function clock(start = 1_000_000) {
  let t = start;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = next++;
      pending.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h: unknown): void => {
      pending.delete(h as number);
    },
    advance(ms: number): void {
      t += ms;
      for (const [id, p] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (p.at <= t && pending.has(id)) {
          pending.delete(id);
          p.fn();
        }
      }
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function makeRinger(o: {
  seed?: SessionEvent[];
  watching?: boolean;
  devices?: number | Error;
  push?: (uid: string, ring: RingPush) => Promise<number>;
  chat?: RingChatKind;
  start?: number;
} = {}) {
  const c = clock(o.start);
  const events: CallRingEvent[] = [];
  const pushes: RingPush[] = [];
  let seq = 100;
  const r = createRinger({
    sessionId: "s1",
    workspaceId: "w1",
    seed: o.seed ?? [],
    append: (e) => {
      const logged = { ...e, seq: seq++ } as CallRingEvent;
      events.push(logged);
      return logged;
    },
    isWatching: () => o.watching ?? false,
    deviceCount: async () => {
      if (o.devices instanceof Error) throw o.devices;
      return o.devices ?? 1;
    },
    push: o.push ?? (async (_uid, ring) => {
      pushes.push(ring);
      return 1;
    }),
    chatKindFor: () => o.chat ?? "dm",
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    log: () => {},
  });
  return { r, c, events, pushes };
}

const seeded = (phase: "ringing" | "answered" | "missed", ts: number, expiresTs: number, ringId = "old"): SessionEvent => ({
  seq: 1, sessionId: "s1", ts, type: "call_ring", ringId, phase, fromAgentId: "ops", toUid: "u1",
  reason: "旧的", expiresTs, ignorable: true,
});

describe("打出去", () => {
  it("落 ringing（45 秒时限）、推送带齐那几格、回「已经打过去了」；到点记未接", async () => {
    const { r, c, events, pushes } = makeRinger({ chat: "group" });
    const text = await r.call("ops", "运维", "u1", "部署完了");
    expect(text).toContain("已经打过去了");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "call_ring", phase: "ringing", fromAgentId: "ops", toUid: "u1", reason: "部署完了",
      expiresTs: c.now() + RING_TTL_MS, ignorable: true, sessionId: "s1",
    });
    expect(pushes).toEqual([{
      ringId: events[0]!.ringId, workspaceId: "w1", sessionId: "s1", agentId: "ops", agentName: "运维",
      reason: "部署完了", chat: "group", expiresTs: events[0]!.expiresTs,
    }]);
    c.advance(RING_TTL_MS - 1);
    expect(events).toHaveLength(1);
    c.advance(1);
    expect(events.map((e) => e.phase)).toEqual(["ringing", "missed"]);
  });

  it("他正开着这条聊天：不打、不落事件", async () => {
    const { r, events, pushes } = makeRinger({ watching: true });
    expect(await r.call("ops", "运维", "u1", "部署完了")).toContain("正开着这条聊天");
    expect(events).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("没有能收推送的设备：不打、不落事件；查设备抛错：另一句话，也不落", async () => {
    const none = makeRinger({ devices: 0 });
    expect(await none.r.call("ops", "运维", "u1", "部署完了")).toContain("没开通知");
    expect(none.events).toEqual([]);
    const broken = makeRinger({ devices: new Error("db down") });
    expect(await broken.r.call("ops", "运维", "u1", "部署完了")).toContain("查不到他的手机");
    expect(broken.events).toEqual([]);
  });

  it("一台都没送到：ringing 之后当场记未接，回「没打通」", async () => {
    const { r, events } = makeRinger({ push: async () => 0 });
    expect(await r.call("ops", "运维", "u1", "部署完了")).toContain("没打通");
    expect(events.map((e) => e.phase)).toEqual(["ringing", "missed"]);
  });

  it("推送 5 秒没回：当没送到", async () => {
    const { r, c, events } = makeRinger({ push: () => new Promise<number>(() => {}) });
    const p = r.call("ops", "运维", "u1", "部署完了");
    await flush();
    c.advance(RING_PUSH_WAIT_MS);
    expect(await p).toContain("没打通");
    expect(events.map((e) => e.phase)).toEqual(["ringing", "missed"]);
  });
});

describe("冷却（10 分钟，从日志算）", () => {
  it("同一只打给同一个人：10 分钟内不再打；打给别人不受影响；过了就能再打", async () => {
    const { r, c, events } = makeRinger();
    await r.call("ops", "运维", "u1", "一");
    c.advance(60_000);
    expect(await r.call("ops", "运维", "u1", "二")).toContain("分钟前刚给他打过电话");
    expect(await r.call("ops", "运维", "u2", "三")).toContain("已经打过去了");
    c.advance(RING_COOLDOWN_MS);
    expect(await r.call("ops", "运维", "u1", "四")).toContain("已经打过去了");
    expect(events.filter((e) => e.phase === "ringing")).toHaveLength(3);
  });

  it("重启之后照样认（冷却读的是日志，不是内存）", async () => {
    const start = 1_000_000;
    const { r, events } = makeRinger({
      start,
      seed: [seeded("ringing", start - 60_000, start - 15_000), seeded("missed", start - 15_000, start - 15_000)],
    });
    expect(await r.call("ops", "运维", "u1", "再打一次")).toContain("分钟前刚给他打过电话");
    expect(events).toEqual([]);
  });
});

describe("接听", () => {
  it("还在响：记接通、撤掉定时器（到点不再记未接）", async () => {
    const { r, c, events } = makeRinger();
    await r.call("ops", "运维", "u1", "部署完了");
    expect(r.answer("ops", "u1")?.reason).toBe("部署完了");
    c.advance(RING_TTL_MS);
    expect(events.map((e) => e.phase)).toEqual(["ringing", "answered"]);
  });

  it("到点记了未接、还在宽限里：照样算接通；过了宽限：不算", async () => {
    const late = makeRinger();
    await late.r.call("ops", "运维", "u1", "部署完了");
    late.c.advance(RING_TTL_MS + 5_000);
    expect(late.r.answer("ops", "u1")).not.toBeNull();
    expect(late.events.map((e) => e.phase)).toEqual(["ringing", "missed", "answered"]);
    const tooLate = makeRinger();
    await tooLate.r.call("ops", "运维", "u1", "部署完了");
    tooLate.c.advance(RING_TTL_MS + RING_ANSWER_GRACE_MS + 1);
    expect(tooLate.r.answer("ops", "u1")).toBeNull();
  });

  it("别的智能体 / 别的人：不算接听", async () => {
    const { r } = makeRinger();
    await r.call("ops", "运维", "u1", "部署完了");
    expect(r.answer("ads", "u1")).toBeNull();
    expect(r.answer("ops", "u2")).toBeNull();
  });
});

describe("重启与归档", () => {
  it("resume：过了时限的补一条未接；没过的接着计时；接通过的不碰", () => {
    const start = 1_000_000;
    const { r, c, events } = makeRinger({
      start,
      seed: [
        seeded("ringing", start - 60_000, start - 15_000, "expired"),
        seeded("ringing", start - 10_000, start + 35_000, "live"),
        seeded("ringing", start - 20_000, start + 25_000, "done"),
        seeded("answered", start - 19_000, start + 25_000, "done"),
      ],
    });
    r.resume();
    expect(events.map((e) => [e.ringId, e.phase])).toEqual([["expired", "missed"]]);
    c.advance(35_000);
    expect(events.map((e) => [e.ringId, e.phase])).toEqual([["expired", "missed"], ["live", "missed"]]);
  });

  it("missAll：还在响的一律未接，撤掉定时器", async () => {
    const { r, c, events } = makeRinger();
    await r.call("ops", "运维", "u1", "部署完了");
    r.missAll();
    c.advance(RING_TTL_MS);
    expect(events.map((e) => e.phase)).toEqual(["ringing", "missed"]);
  });
});
```

新建 `tests/runtime/callUserTool.test.ts`：

```ts
// call_user —— 回电那把刀（#1411，spec §2.1）。它只管参数与「有没有人可打」，别的都在 callRinger 里。
import { describe, expect, it } from "vitest";
import { createCallUserTool } from "../../services/runtime/src/callUserTool.js";
import { CALL_USER_TOOL_NAME } from "../../src/shared/callRing.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;

describe("call_user", () => {
  it("名字、参数、不过审批门", () => {
    const t = createCallUserTool({ initiator: () => "u1", ring: async () => "" });
    expect(t.def.name).toBe(CALL_USER_TOOL_NAME);
    expect(t.def.parameters).toMatchObject({ required: ["reason"] });
    expect(t.requiresApproval).toBe(false);
  });

  it("reason 不是字符串 / 规整完是空的：抛错（让模型改参数）", async () => {
    const t = createCallUserTool({ initiator: () => "u1", ring: async () => "打了" });
    await expect(t.run({ reason: 3 }, world)).rejects.toThrow("reason");
    await expect(t.run({ reason: " \n " }, world)).rejects.toThrow("reason");
  });

  it("这一轮不是人叫起来的：不打，回一句", async () => {
    const calls: string[] = [];
    for (const who of [null, "system", ""]) {
      const t = createCallUserTool({ initiator: () => who, ring: async (to) => { calls.push(to); return "打了"; } });
      expect(await t.run({ reason: "部署完了" }, world)).toContain("没人可打");
    }
    expect(calls).toEqual([]);
  });

  it("打给叫起这一轮的那个人，reason 先规整", async () => {
    const calls: [string, string][] = [];
    const t = createCallUserTool({ initiator: () => "u1", ring: async (to, reason) => { calls.push([to, reason]); return "已经打过去了"; } });
    expect(await t.run({ reason: "部署完了\n  要你拍板" }, world)).toBe("已经打过去了");
    expect(calls).toEqual([["u1", "部署完了 要你拍板"]]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/callRinger.test.ts tests/runtime/callUserTool.test.ts`
Expected: FAIL（两个模块不存在）

- [ ] **Step 3: 新建 `services/runtime/src/callRinger.ts`**

```ts
// callRinger —— 一次回电从打出去到接通 / 未接（#1411，spec §2.2–2.3）。
//
// sessionService 每条会话一个（推送开着时）。它自己持有这条会话所有响铃的状态：从日志播种，之后只有它
// 自己落 call_ring，所以自己推进就是权威。负责：几种不打（对方开着这条聊天 / 10 分钟冷却 / 没有能收推送
// 的设备 / 查不到设备）、落 ringing、推送（最多等 5 秒）、45 秒到点落 missed、接听时落 answered、归档时
// 收摊、重启后把还在响的接上。
//
// spec §2.2 第 2 条「正在通话不打」并进了第 1 条（计划阶段的补全）：锁屏 = 这台停听、通话还在
// （ADR-0320），名单非空不等于人在通话里；人真在通话里时他必然连着这条会话。
//
// 只依赖注入的回调（同 inviteToCallTool 的纪律）：不认识 store、不认识 APNs。

import { randomUUID } from "node:crypto";
import type { CallRingEvent, SessionEvent } from "../../../src/session/events.js";
import {
  RING_COOLDOWN_MS, RING_TTL_MS, answerableRing, applyCallRing, callRingFoldOf, lastRingTs,
  type RingChatKind, type RingPush, type RingState,
} from "../../../src/shared/callRing.js";

/** 推送最多等多久（spec §2.3）：工具要回一句话给模型，不能被一条半死的连接拖住整轮 */
export const RING_PUSH_WAIT_MS = 5_000;

export interface RingerDeps {
  sessionId: string;
  workspaceId: string;
  seed: readonly SessionEvent[];
  /** 落一条并广播（store.append + notify） */
  append(e: Omit<CallRingEvent, "seq">): CallRingEvent;
  /** 这个人此刻开着这条会话吗（会话房里有他的连接） */
  isWatching(uid: string): boolean;
  /** 他登记了几台能收推送的设备。抛错 = 这一刻查不出来 */
  deviceCount(uid: string): Promise<number>;
  /** 推一次，回送到了几台 */
  push(uid: string, ring: RingPush): Promise<number>;
  /** 手机开哪种聊天页 */
  chatKindFor(uid: string): RingChatKind;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  log(m: string): void;
}

export interface Ringer {
  /** call_user 那把刀：`reason` 已经规整过。回给模型的那句话 */
  call(agentId: string, agentName: string, toUid: string, reason: string): Promise<string>;
  /** 这个人发了一帧把这只带进通话：它正在给他响铃（或刚记成未接、还在宽限里）就记接通、回那一通 */
  answer(agentId: string, uid: string): RingState | null;
  /** 装配末尾：还在响的接上——过了时限的补一条 missed，没过的重新挂定时器 */
  resume(): void;
  /** 归档：还在响的一律 missed */
  missAll(): void;
}

export function createRinger(d: RingerDeps): Ringer {
  const fold = callRingFoldOf(d.seed);
  const timers = new Map<string, unknown>();

  const log = (ring: RingState, phase: CallRingEvent["phase"]): void => {
    const e = d.append({
      sessionId: d.sessionId, ts: d.now(), type: "call_ring", ringId: ring.ringId, phase,
      fromAgentId: ring.fromAgentId, toUid: ring.toUid, reason: ring.reason, expiresTs: ring.expiresTs, ignorable: true,
    });
    applyCallRing(fold, e);
  };
  const disarm = (ringId: string): void => {
    const h = timers.get(ringId);
    if (h === undefined) return;
    d.clearTimer(h);
    timers.delete(ringId);
  };
  const arm = (ringId: string, ms: number): void => {
    disarm(ringId);
    timers.set(ringId, d.setTimer(() => {
      timers.delete(ringId);
      const r = fold.get(ringId);
      if (r !== undefined && r.phase === "ringing") log(r, "missed");
    }, Math.max(0, ms)));
  };
  /** 等 p，最多 ms 毫秒；到点回 fallback（p 照样在后台跑完，它的结果没人要了） */
  const withDeadline = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    new Promise<T>((resolve) => {
      const h = d.setTimer(() => resolve(fallback), ms);
      void p.then((v) => {
        d.clearTimer(h);
        resolve(v);
      });
    });

  return {
    async call(agentId, agentName, toUid, reason) {
      if (d.isWatching(toUid)) return "他这会儿正开着这条聊天，直接在聊天里说就行，不用打电话。";
      const now = d.now();
      const last = lastRingTs(fold, agentId, toUid);
      if (last !== null && now - last < RING_COOLDOWN_MS) {
        const mins = Math.max(1, Math.ceil((now - last) / 60_000));
        return `你 ${mins} 分钟前刚给他打过电话，10 分钟内不再打——在聊天里说一声，他回来会看到。`;
      }
      let devices: number;
      try {
        devices = await d.deviceCount(toUid);
      } catch (err) {
        d.log(`[otto-runtime] 查推送设备失败（session=${d.sessionId}）：${err instanceof Error ? err.message : String(err)}`);
        return "这会儿查不到他的手机，电话没打出去——在聊天里说一声，他回来会看到。";
      }
      if (devices === 0) return "他的手机没开通知（或者还没在手机上登录），打不了电话——在聊天里说一声，他回来会看到。";
      const at = d.now();
      const ring: RingState = {
        ringId: randomUUID(), fromAgentId: agentId, toUid, reason,
        expiresTs: at + RING_TTL_MS, ringingTs: at, phase: "ringing", phaseTs: at,
      };
      log(ring, "ringing");
      arm(ring.ringId, RING_TTL_MS);
      const push: RingPush = {
        ringId: ring.ringId, workspaceId: d.workspaceId, sessionId: d.sessionId, agentId, agentName,
        reason, chat: d.chatKindFor(toUid), expiresTs: ring.expiresTs,
      };
      const sent = d.push(toUid, push).catch((err: unknown) => {
        d.log(`[otto-runtime] 推送来电失败（session=${d.sessionId}）：${err instanceof Error ? err.message : String(err)}`);
        return 0;
      });
      const delivered = await withDeadline(sent, RING_PUSH_WAIT_MS, 0);
      if (delivered === 0) {
        const r = fold.get(ring.ringId);
        if (r !== undefined && r.phase === "ringing") {
          disarm(ring.ringId);
          log(r, "missed");
        }
        return "没打通（推送没送到）——在聊天里说一声，他回来会看到。";
      }
      return "已经打过去了。他接起来你会先开口；45 秒没接就算未接，他回来会在聊天里看到。";
    },
    answer(agentId, uid) {
      const r = answerableRing(fold, agentId, uid, d.now());
      if (r === null) return null;
      disarm(r.ringId);
      log(r, "answered");
      return r;
    },
    resume() {
      const now = d.now();
      for (const r of [...fold.values()]) {
        if (r.phase !== "ringing") continue;
        if (now >= r.expiresTs) log(r, "missed");
        else arm(r.ringId, r.expiresTs - now);
      }
    },
    missAll() {
      for (const r of [...fold.values()]) {
        if (r.phase !== "ringing") continue;
        disarm(r.ringId);
        log(r, "missed");
      }
    },
  };
}
```

- [ ] **Step 4: 新建 `services/runtime/src/callUserTool.ts`**

```ts
// call_user —— 智能体打电话回给你（#1411，spec §2.1）。
//
// 推送开着时每只都挂、不过审批门（主场群里客人点起的那一轮由 sessionService 的 guestTurn() 掀成要群主批，
// #1393）。推送关着时这把刀根本不出现——不能让模型许诺一通打不出去的电话。
// 打给叫起这一轮的那个人（sessionService 的 currentInitiator；接力那一棒是点火的那个人，ADR-0223）。
// 这把刀只管参数与「有没有人可打」，几种不打、落事件、推送都在 callRinger 里（注入的 `ring`）。

import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { CALL_USER_TOOL_NAME, normalizeRingReason } from "../../../src/shared/callRing.js";

export interface CallUserDeps {
  /** 这一轮是谁叫起来的。null / "system" / 空串 = 不是人 */
  initiator: () => string | null;
  /** 打一次（sessionService 绑好这只 agent 的 id 与名字，交给 callRinger.call）。回给模型的那句话 */
  ring: (toUid: string, reason: string) => Promise<string>;
}

export function createCallUserTool(deps: CallUserDeps): Tool {
  return {
    def: {
      name: CALL_USER_TOOL_NAME,
      description:
        "给叫起这一轮的那个人打电话（他的手机会响）。什么时候打：他说过「办完打给我」就一定打；" +
        "事情办了很久、他已经不在（挂了电话、离开了聊天），或者需要他拍板时可以打；别为小事打。" +
        "reason 写一句他在锁屏上一眼能看懂的话。他接起来之后你会先开口，把事情说清楚。",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "显示在他锁屏上的一句话（60 字以内，别换行），比如「部署完了，有个配置要你拍板」" },
        },
        required: ["reason"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const raw = (args as { reason?: unknown } | null)?.reason;
      if (typeof raw !== "string") throw new Error("call_user: 参数 reason 必须是字符串");
      const reason = normalizeRingReason(raw);
      if (reason === "") throw new Error("call_user: reason 不能是空的——写一句他在锁屏上能看懂的话");
      const to = deps.initiator();
      if (to === null || to === "" || to === "system") return "这一轮不是人叫起来的，没人可打。";
      return deps.ring(to, reason);
    },
  };
}
```

- [ ] **Step 5: 跑测试确认通过、类型干净**

Run: `npx vitest run tests/runtime/callRinger.test.ts tests/runtime/callUserTool.test.ts`
Expected: PASS

Run: `npx tsc --noEmit -p services/runtime && npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add services/runtime/src/callRinger.ts services/runtime/src/callUserTool.ts tests/runtime/callRinger.test.ts tests/runtime/callUserTool.test.ts
git commit -m "feat(runtime): 回电的一次响铃与 call_user 那把刀（#1411）" -m "ringer 从日志播种、之后只有它落 call_ring：开着聊天 / 冷却 / 没有设备不打；落 ringing 后推送最多等 5 秒，一台没送到当场记未接，45 秒到点记未接。接听有 30 秒宽限。「正在通话不打」并进「开着聊天不打」：锁屏 = 停听、通话还在，名单非空不等于人在通话里。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: runtime —— 接进 sessionService

**Files:**
- Modify: `services/runtime/src/sessionService.ts`、`services/runtime/src/daemon.ts`（只加一行占位）、`services/runtime/checks/smokeAssembly.ts`
- Test: `tests/runtime/sessionService.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `callbackGreetingText`、`ringChatKind`、`RingPush`、`CallRingEvent`、`CALL_USER_TOOL_NAME`、`RING_TTL_MS`；Task 4 的 `createRinger`、`Ringer`、`createCallUserTool`。
- Produces：`export interface CloudCallback { isWatching(uid): boolean; deviceCount(uid): Promise<number>; push(uid, ring: RingPush): Promise<number> }`；`CloudSessionOpts.callback: CloudCallback | null`（**必需**）；`CloudSessionOpts.ringTimers?: { setTimer?; clearTimer? }`。Task 6 的 daemon 按这个形状接。

- [ ] **Step 1: 所有现存装配补 `callback: null`（先让类型要求它，再补）**

`sessionService.ts` 里 `export interface CloudSessionOpts {` 前面加：

```ts
/** 智能体回电（#1411，spec §2）：推送开着时 daemon 给这一格，关着时给 null——回电工具不出现、通话块不提回电。
    三个口都由 daemon 接：isWatching 读会话房的在场名单（frameHandler.uidOf），另两个接 APNs */
export interface CloudCallback {
  /** 这个人此刻开着这条会话吗（会话房里有他的连接）。开着就不打：直接在聊天里说 */
  isWatching(uid: string): boolean;
  /** 他登记了几台能收推送的设备。抛错 = 这一刻查不出来 */
  deviceCount(uid: string): Promise<number>;
  /** 给他的每台设备推一次来电，回送到了几台 */
  push(uid: string, ring: RingPush): Promise<number>;
}
```

`CloudSessionOpts` 里 `approveAll: boolean;` 那一格后面加：

```ts
  /** 智能体回电（#1411）。**必需**（同 approveAll / diskUsage 的纪律）：`null` = 推送关着（没配 APNS_*），
      call_user 那把刀不挂、通话块不提回电；忘接线该编译不过，而不是安静地跑一套「永远打不出电话」的装配 */
  callback: CloudCallback | null;
  /** 回电响铃的定时器（只给测试拧，同 deltaTimers）。缺席 = setTimeout / clearTimeout */
  ringTimers?: { setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void };
```

import 区：`import type { SessionEvent, SessionCreatedEvent, UserMessageEvent, AssistantMessageEvent, AgentRelayEvent } from "../../../src/session/events.js";` 里加上 `CallRingEvent`；另加

```ts
import { callbackGreetingText, ringChatKind, type RingPush } from "../../../src/shared/callRing.js";
import { createRinger, type Ringer } from "./callRinger.js";
import { createCallUserTool } from "./callUserTool.js";
```

然后补装配点：

```bash
sed -i '' \
  -e 's/diskUsage: () => null, approveAll: false,/diskUsage: () => null, approveAll: false, callback: null,/' \
  -e 's/diskUsage: () => null, approveAll: true,/diskUsage: () => null, approveAll: true, callback: null,/' \
  -e 's/diskUsage: o\.disk, approveAll: false,/diskUsage: o.disk, approveAll: false, callback: null,/' \
  -e 's/diskUsage: () => null, approveAll,/diskUsage: () => null, approveAll, callback: null,/' \
  tests/runtime/sessionService.test.ts
```

`services/runtime/checks/smokeAssembly.ts` 的 `diskUsage: () => null, // 冒烟装配没有真容器可量（#836）` 下一行加 `            callback: null, // 冒烟装配不接推送（#1411）`（缩进照上一行）。

`services/runtime/src/daemon.ts` 的 `createCloudSession({…})` 里 `diskUsage: () => sandbox.diskUsage(workspaceId),` 下一行加 `      callback: null, // 推送的接线在下一步（#1411）`。

Run: `npx tsc --noEmit && npx tsc --noEmit -p services/runtime`
Expected: 还有报「Property 'callback' is missing」的装配（`baseOpts` 之类的共用装配、行内没有 `diskUsage` 那一行的）：逐个补 `callback: null`，直到无输出。

- [ ] **Step 2: 写失败测试**

`tests/runtime/sessionService.test.ts`：顶部 import 里给 `createCloudSession, …` 那一行加 `type CloudCallback`；`import type { SessionEvent, … } from "../../src/session/events.js";` 里加 `CallRingEvent`；另加 `import { CALL_USER_TOOL_NAME, callbackGreetingText, RING_TTL_MS, type RingPush } from "../../src/shared/callRing.js";`。

找到 `async function openHomeGroup(o: {`（主场群客人那一组用例的装配），参数类型里加一格 `callback?: CloudCallback | null;`，它的 `createCloudSession({` 里（Step 1 的 sed 已经加了 `callback: null`）把 `callback: null` 改成 `callback: o.callback ?? null, ringTimers: { setTimer: () => 0, clearTimer: () => {} },`（不会自己走的定时器：用例结束后 45 秒的真定时器会在关掉的 store 上落事件）。在那一组的 `it("客人点起的 create_agent：…` 前面加：

```ts
  it("客人点起的那一轮：call_user 也要群主批，批了才打给客人（来电开「guest」那种聊天页）", async () => {
    const events: SessionEvent[] = [];
    const pushes: { uid: string; ring: RingPush }[] = [];
    let round = 0;
    const adapter: ModelAdapter = {
      model: "m",
      async chat(): Promise<ModelReply> {
        round++;
        if (round === 1) return { content: "", toolCalls: [{ id: "cC", name: CALL_USER_TOOL_NAME, args: { reason: "查完了" } }] };
        return { content: "好" };
      },
    };
    const { session, store } = await openHomeGroup({
      adapter, events,
      callback: {
        isWatching: () => false,
        deviceCount: async () => 1,
        push: async (uid, ring) => {
          pushes.push({ uid, ring });
          return 1;
        },
      },
      onEvent: (e, s) => {
        if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, "owner", "Owner", "approved");
      },
    });
    await session.say(GUEST, "小红", "查一下，查完打给我", true);
    await session.settled();
    expect((events.find((e) => e.type === "approval_request") as ApprovalRequestEvent | undefined)?.toolName).toBe(CALL_USER_TOOL_NAME);
    expect(pushes).toEqual([{ uid: GUEST, ring: expect.objectContaining({ chat: "guest" }) }]);
    store.close();
  });
```

文件末尾加一组：

```ts
// ── 回电（#1411）──────────────────────────────────────────────────────────
// 响铃的生命周期细节在 callRinger.test.ts；这里钉的是接线：推送关着没有这把刀、打出去落 ringing、
// call 帧认出接听并换成回电开场白、归档记未接、重启接着计时。定时器都是不会自己走的假件。
describe("回电（#1411）", () => {
  const ROSTER = [
    { agentId: "ops", name: "运维", description: "", instructions: "", models: ["m-ops"], tools: [] as AgentToolAllow[] },
    { agentId: "ads", name: "广告", description: "", instructions: "", models: ["m-ads"], tools: [] as AgentToolAllow[] },
  ];
  /** 不会自己走的定时器：只在测试 fireAll 时跑 */
  function manualTimers() {
    const pending = new Map<number, () => void>();
    let next = 1;
    return {
      setTimer: (fn: () => void): unknown => {
        const id = next++;
        pending.set(id, fn);
        return id;
      },
      clearTimer: (h: unknown): void => {
        pending.delete(h as number);
      },
      fireAll: (): void => {
        const fns = [...pending.values()];
        pending.clear();
        for (const f of fns) f();
      },
    };
  }
  function fakeCallback(o: { watching?: boolean } = {}) {
    const pushes: { uid: string; ring: RingPush }[] = [];
    const cb: CloudCallback = {
      isWatching: () => o.watching ?? false,
      deviceCount: async () => 1,
      push: async (uid, ring) => {
        pushes.push({ uid, ring });
        return 1;
      },
    };
    return { cb, pushes };
  }
  function open(store: EventStore, o: {
    callback: CloudCallback | null;
    reply?: (agentId: string, round: number) => ModelReply;
    events?: SessionEvent[];
    tools?: Record<string, string[]>;
    timers?: ReturnType<typeof manualTimers>;
    now?: () => number;
  }): CloudSession {
    const rounds: Record<string, number> = {};
    const timers = o.timers ?? manualTimers();
    return createCloudSession({
      diskUsage: () => null, approveAll: false, callback: o.callback,
      ringTimers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
      ...(o.now ? { now: o.now } : {}),
      sessionMeta: createInMemoryCloudSessionMeta(),
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => ["u1"], agents: async () => ROSTER,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat(_messages, tools?: ToolDefinition[]): Promise<ModelReply> {
          rounds[a.agentId] = (rounds[a.agentId] ?? 0) + 1;
          if (o.tools) o.tools[a.agentId] = (tools ?? []).map((t) => t.name);
          return o.reply ? o.reply(a.agentId, rounds[a.agentId]!) : { content: `${a.name}答` };
        },
      }),
      onEvent: (e) => o.events?.push(e), onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(),
      isMember: async () => true, contextWindowOf: () => undefined, sandboxApproval: async () => "ask",
      workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    });
  }
  /** 运维第一轮打电话、之后收尾 */
  const callsBack = (reason: string) => (id: string, round: number): ModelReply =>
    id === "ops" && round === 1 ? { content: "", toolCalls: [{ id: "c1", name: CALL_USER_TOOL_NAME, args: { reason } }] } : { content: "好" };
  const phases = (store: EventStore): string[] =>
    store.load("s1").filter((e) => e.type === "call_ring").map((e) => (e as CallRingEvent).phase);

  it("推送关着：工具表里没有 call_user；开着：有", async () => {
    const off: Record<string, string[]> = {};
    const s1 = newStore();
    const a = open(s1, { callback: null, tools: off });
    await a.say("u1", "alice", "@运维 在吗", true, ["ops"]);
    await a.settled();
    expect(off.ops).not.toContain(CALL_USER_TOOL_NAME);
    s1.close();
    const on: Record<string, string[]> = {};
    const s2 = newStore();
    const b = open(s2, { callback: fakeCallback().cb, tools: on });
    await b.say("u1", "alice", "@运维 在吗", true, ["ops"]);
    await b.settled();
    expect(on.ops).toContain(CALL_USER_TOOL_NAME);
    s2.close();
  });

  it("打出去：落 ringing（打给叫起这一轮的人）、推送带这只的名字与聊天种类、工具回「已经打过去了」", async () => {
    const store = newStore();
    const { cb, pushes } = fakeCallback();
    const events: SessionEvent[] = [];
    const session = open(store, { callback: cb, events, reply: callsBack("部署完了\n要你拍板") });
    await session.say("u1", "alice", "@运维 部署一下，办完打给我", true, ["ops"]);
    await session.settled();
    const rung = store.load("s1").find((e) => e.type === "call_ring") as CallRingEvent | undefined;
    expect(rung).toMatchObject({ phase: "ringing", fromAgentId: "ops", toUid: "u1", reason: "部署完了 要你拍板", ignorable: true });
    expect(pushes).toEqual([{
      uid: "u1",
      ring: expect.objectContaining({ ringId: rung!.ringId, agentId: "ops", agentName: "运维", chat: "team", sessionId: "s1", workspaceId: "w1" }),
    }]);
    expect(JSON.stringify(events.find((e) => e.type === "tool_result"))).toContain("已经打过去了");
    store.close();
  });

  it("他正开着这条聊天：不打、不落事件，工具回一句", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = open(store, { callback: fakeCallback({ watching: true }).cb, events, reply: callsBack("部署完了") });
    await session.say("u1", "alice", "@运维 部署一下", true, ["ops"]);
    await session.settled();
    expect(phases(store)).toEqual([]);
    expect(JSON.stringify(events.find((e) => e.type === "tool_result"))).toContain("正开着这条聊天");
    store.close();
  });

  it("接听：他发 call 帧把它带进通话 → 先名单、再接通、再回电开场白", async () => {
    const store = newStore();
    const session = open(store, { callback: fakeCallback().cb, reply: callsBack("部署完了") });
    await session.say("u1", "alice", "@运维 部署一下", true, ["ops"]);
    await session.settled();
    const before = store.load("s1").length;
    expect(await session.setVoiceCall("u1", "alice", ["ops"])).toEqual({ kind: "ok" });
    const after = store.load("s1").slice(before);
    expect(after.slice(0, 3).map((e) => e.type)).toEqual(["voice_call_changed", "call_ring", "user_message"]);
    expect(after[0]).toMatchObject({ callback: true });
    expect(after[1]).toMatchObject({ phase: "answered", fromAgentId: "ops", toUid: "u1" });
    expect(after[2]).toMatchObject({ greeting: "callback", mentions: ["ops"], fromUid: "u1" });
    expect((after[2] as UserMessageEvent).content).toBe(callbackGreetingText("运维", "alice", "部署完了"));
    await session.settled();
    store.close();
  }, TWO_TURN_SETTLE_MS);

  it("通话本来就开着（锁屏没挂，ADR-0320）：名单没变也认接听，只有它开口", async () => {
    const store = newStore();
    const session = open(store, {
      callback: fakeCallback().cb,
      reply: (id, round) =>
        id === "ops" && round === 2 ? { content: "", toolCalls: [{ id: "c1", name: CALL_USER_TOOL_NAME, args: { reason: "测完了" } }] } : { content: "好" },
    });
    await session.setVoiceCall("u1", "alice", ["ops"]); // 第一轮：拉进通话打招呼
    await session.settled();
    await session.say("u1", "alice", "@运维 测一下，测完打给我", true, ["ops"]); // 第二轮：打电话
    await session.settled();
    const before = store.load("s1").length;
    await session.setVoiceCall("u1", "alice", ["ops"]);
    const after = store.load("s1").slice(before);
    expect(after.some((e) => e.type === "voice_call_changed")).toBe(false);
    expect(after.slice(0, 2).map((e) => e.type)).toEqual(["call_ring", "user_message"]);
    expect(after[1]).toMatchObject({ greeting: "callback" });
    await session.settled();
    store.close();
  }, TWO_TURN_SETTLE_MS);

  it("没在响铃的拉人照旧打普通招呼；推送关着时名单事件不带 callback", async () => {
    const s1 = newStore();
    const a = open(s1, { callback: fakeCallback().cb });
    await a.setVoiceCall("u1", "alice", ["ops"]);
    expect(s1.load("s1").find((e) => e.type === "voice_call_changed")).toMatchObject({ callback: true });
    expect(s1.load("s1").find((e) => e.type === "user_message")).toMatchObject({ greeting: "voice_call" });
    await a.settled();
    s1.close();
    const s2 = newStore();
    const b = open(s2, { callback: null });
    await b.setVoiceCall("u1", "alice", ["ops"]);
    expect((s2.load("s1").find((e) => e.type === "voice_call_changed") as { callback?: true }).callback).toBeUndefined();
    await b.settled();
    s2.close();
  }, TWO_TURN_SETTLE_MS);

  it("归档：还在响的记未接", async () => {
    const store = newStore();
    const session = open(store, { callback: fakeCallback().cb, reply: callsBack("部署完了") });
    await session.say("u1", "alice", "@运维 部署一下", true, ["ops"]);
    await session.settled();
    session.archive("alice");
    expect(phases(store)).toEqual(["ringing", "missed"]);
    store.close();
  });

  it("重启：没过时限的接着计时，到点再记未接", async () => {
    let t = 1_000_000;
    const store = newStore();
    const first = open(store, { callback: fakeCallback().cb, now: () => t, reply: callsBack("部署完了") });
    await first.say("u1", "alice", "@运维 部署一下", true, ["ops"]);
    await first.settled();
    t += 10_000;
    const timers = manualTimers();
    open(store, { callback: fakeCallback().cb, timers, now: () => t });
    expect(phases(store)).toEqual(["ringing"]);
    timers.fireAll();
    expect(phases(store)).toEqual(["ringing", "missed"]);
    store.close();
  });

  it("重启时已经过了时限：装配时就补一条未接", async () => {
    let t = 1_000_000;
    const store = newStore();
    const first = open(store, { callback: fakeCallback().cb, now: () => t, reply: callsBack("部署完了") });
    await first.say("u1", "alice", "@运维 部署一下", true, ["ops"]);
    await first.settled();
    t += RING_TTL_MS + 1;
    open(store, { callback: fakeCallback().cb, now: () => t });
    expect(phases(store)).toEqual(["ringing", "missed"]);
    store.close();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/runtime/sessionService.test.ts -t "回电|call_user"`
Expected: FAIL（没有 call_user、名单事件没有 callback、没有 call_ring）

- [ ] **Step 4: 装配 ringer**

`sessionService.ts` 里 `  const specNames = new Map<string, string>();` 下面加：

```ts
  /** 回电（#1411）：推送开着才有。它自己从 seed 播种、之后只有它落 call_ring，所以状态它自己推进就是权威 */
  const callback = opts.callback;
  const ringer: Ringer | null =
    callback === null
      ? null
      : createRinger({
          sessionId,
          workspaceId: opts.workspaceId,
          seed,
          append: (e) => {
            const logged = store.append(e) as CallRingEvent;
            notify(logged);
            return logged;
          },
          isWatching: (uid) => callback.isWatching(uid),
          deviceCount: (uid) => callback.deviceCount(uid),
          push: (uid, ring) => callback.push(uid, ring),
          // 手机开哪种聊天页：个人主场 = approveAll（ADR-0298 同一格），私聊 / 群看建会话时记下的 chat 标记
          chatKindFor: (uid) => ringChatKind({ home: opts.approveAll, chatKind, toUid: uid, ownerUid: opts.ownerUid }),
          now,
          setTimer: opts.ringTimers?.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
          clearTimer: opts.ringTimers?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
          log: (m) => console.warn(m),
        });
```

- [ ] **Step 5: 名单事件带 `callback`、挂刀**

`logVoiceCall` 里 `      ...(byAgentId !== undefined ? { byAgentId } : {}),` 下一行加：

```ts
      // 推送开着时带上（#1411）：通话块据它说「挂断之后可以用 call_user 回电」
      ...(opts.callback !== null && participants.length > 0 ? { callback: true as const } : {}),
```

`engineFor` 里 `const inviteToCallTool = createInviteToCallTool({ … });` 那一整段后面加：

```ts
    // 回电那把刀（#1411）：推送开着才挂，每只都挂、不过审批门（客人点起的那一轮由下面 guestTurn 掀成要群主批）。
    // 打给叫起这一轮的那个人；名字现取（改名后下一通来电写的是新名字）
    const callUserTool =
      ringer === null
        ? null
        : createCallUserTool({
            initiator: () => currentInitiator,
            ring: (toUid, reason) => ringer.call(spec.agentId, specNames.get(spec.agentId) ?? spec.name, toUid, reason),
          });
```

`tools: () => {` 里的列表第一行换成：

```ts
          readFileTool, writeFileTool, bashTool, wikiReadTool, wikiTool, inviteToCallTool,
          ...(callUserTool !== null ? [callUserTool] : []),
```

- [ ] **Step 6: `setVoiceCall` 认接听、`greetNewcomers` 换开场白**

把 `session` 对象里整个 `async setVoiceCall(byUid, _byLabel, participants, budget) { … },` 换成：

```ts
    async setVoiceCall(byUid, byLabel, participants, budget) {
      if (archived) return { kind: "archived", message: "这条会话已经归档，没有通话可言" };
      // 人刚点了名单 → 要此刻的名单（同 say 的 fresh）：他在设置页刚建的那只要能立刻拉进来
      const roster = await rosterNow({ fresh: true });
      // 名单降级 = 占位不是真名单：拿它核对会把一次 Supabase 抖动说成「这只 agent 不存在」
      if (roster.some((a) => a.degraded)) return { kind: "unknown_agent", message: "智能体名单这会儿读不出来，稍后再试" };
      const ids = [...new Set(participants)];
      const unknown = ids.filter((id) => !roster.some((a) => a.agentId === id));
      // 只回显个数不回显 id 原文（同 sayUnknown 的纪律）：这些 id 直接来自客户端帧
      if (unknown.length > 0) {
        return { kind: "unknown_agent", message: `有 ${unknown.length} 个智能体不在名单里（名单可能刚变过，刷新再试）` };
      }
      const current = voiceCall?.participants.map((p) => p.agentId) ?? [];
      const same = current.length === ids.length && ids.every((id) => current.includes(id));
      const next = ids.map((id) => ({ agentId: id, name: roster.find((a) => a.agentId === id)!.name }));
      if (!same) logVoiceCall(next, byUid);
      // 回电接通（#1411）：发这一帧的人把正在给他响铃的那只带进了名单——新拉进来的，或者本来就在一场没人
      // 挂断的通话里（锁屏 = 这台停听、通话还在，ADR-0320）。落在名单之后：接通那一刻它已经在通话里
      const reasons = new Map<string, string>();
      if (ringer !== null) {
        for (const id of ids) {
          const r = ringer.answer(id, byUid);
          if (r !== null) reasons.set(id, r.reason);
        }
      }
      // 先落名单再落招呼（#1174）：招呼那一轮跑起来时它已经在通话里（system 尾块读得到、回复会被读出来）——
      // 与 say 里「先落并集名单再落开场白」同一个顺序。开口的是新拉进来的那几只，加上回电接通的那几只
      // （它们打这个电话是有话要说的，哪怕本来就在通话里）
      greetNewcomers(next.filter((p) => !current.includes(p.agentId) || reasons.has(p.agentId)), byUid, budget, { byLabel, reasons });
      return { kind: "ok" };
    },
```

`function greetNewcomers(added: readonly VoiceCallParticipant[], byUid: string, budget?: (n: number) => string | null): void {` 这一整个函数换成（文档注释照留，末尾加一句 `` `callback` 在场 = 回电接通（#1411）：那几只说回电版开场白 ``）：

```ts
  function greetNewcomers(
    added: readonly VoiceCallParticipant[],
    byUid: string,
    budget?: (n: number) => string | null,
    callback?: { byLabel: string; reasons: ReadonlyMap<string, string> },
  ): void {
    if (added.length === 0) return;
    const veto = budget?.(added.length) ?? null;
    if (veto !== null) {
      logChat("system", "系统", `${veto} 刚拉进通话的 ${added.length} 只没打招呼——@ 一下它们就会回。`, false);
      return;
    }
    const decisions = added.map((p) => {
      // 回电接通的那只说回电版开场白（#1411）：它得知道自己为什么打这个电话、接的是谁
      const reason = callback?.reasons.get(p.agentId);
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        content:
          reason !== undefined && callback !== undefined
            ? callbackGreetingText(p.name, callback.byLabel, reason)
            : voiceCallGreetingText(p.name),
        fromUid: byUid,
        mentions: [p.agentId],
        greeting: reason !== undefined ? "callback" : "voice_call",
      }) as UserMessageEvent;
      notify(opening);
      return coordinator.enqueue({ agentId: p.agentId, fromUid: byUid, opening });
    });
    // 同 say()：只有此刻没在排空时才起一条；invite_to_call 那条路上 drain 正跑着，
    // 入队回的是 queued，不再起第二条
    if (decisions.includes("start_turn")) startDrain();
  }
```

- [ ] **Step 7: 归档与重启**

`archive(byLabel)` 里 `      archived = true;` 下一行加：

```ts
      // 还在响的回电一律记未接（#1411）：归档之后没有人会来接，也没有房间可进
      ringer?.missAll();
```

文件末尾 `  // 重启补跑（#932 坑 ②）：上一个 daemon 收下了话（user_message 已落盘）、还` 那一段注释前面加：

```ts
  // 回电（#1411）：上一个进程里还在响的——过了时限的补一条未接，没过的接着计时；已归档的一律未接
  if (ringer !== null) {
    if (archived) ringer.missAll();
    else ringer.resume();
  }

```

- [ ] **Step 8: 跑测试确认通过、类型干净**

Run: `npx vitest run tests/runtime/sessionService.test.ts`
Expected: PASS（全文件，含旧用例）

Run: `npx tsc --noEmit && npx tsc --noEmit -p services/runtime`
Expected: 无输出

- [ ] **Step 9: 提交**

```bash
git add services/runtime/src/sessionService.ts services/runtime/src/daemon.ts services/runtime/checks/smokeAssembly.ts tests/runtime/sessionService.test.ts
git commit -m "feat(runtime): call_user 接进云会话，call 帧认出接听（#1411）" -m "callback 是必需字段：null = 推送关着，刀不挂、名单事件不带 callback（通话块不提回电）。接听不另造帧：发 call 帧的人把正在给他响铃的那只带进名单——新拉进来的或本来就在一场没挂断的通话里——就落 answered，开场白换成回电版。归档记未接，重启接着计时。daemon 先给 null，下一步接上。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: runtime —— daemon 接线（令牌表、`uidOf`、APNs、文档）

**Files:**
- Create: `services/runtime/src/pushDevices.ts`
- Modify: `services/runtime/src/frameHandler.ts`、`services/runtime/src/daemon.ts`、`deploy/otto-runtime.env.example`、`docs/runtime-vps.md`
- Test: `tests/runtime/pushDevices.test.ts`（新建）、`tests/runtime/frameHandler.test.ts`、`tests/runtime/daemonCallbackWiring.test.ts`（新建）

**Interfaces:**
- Consumes：Task 3 的 `createApnsPusher`、`PushDeviceStore`、`PushDevice`、`ApnsEnv`、`config.apns`；Task 5 的 `CloudSessionOpts.callback`。
- Produces：`createSupabasePushDevices(client, bundleId, log): PushDeviceStore`；`FrameHandler.uidOf(cid): string | null`。

- [ ] **Step 1: 写失败测试**

新建 `tests/runtime/pushDevices.test.ts`：

```ts
// pushDevices —— 令牌表的 runtime 那一侧（#1411）。假的 Supabase 客户端只实现用到的那一截查询链。
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabasePushDevices } from "../../services/runtime/src/pushDevices.js";

type Call = [string, ...unknown[]];
function fakeClient(result: { data?: unknown; error: { message: string } | null } | Error) {
  const calls: Call[] = [];
  const chain = () => {
    const q = {
      eq: (k: string, v: unknown) => {
        calls.push(["eq", k, v]);
        return q;
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(res, rej),
    };
    return q;
  };
  const client = {
    from: (table: string) => ({
      select: (cols: string) => {
        calls.push(["select", table, cols]);
        return chain();
      },
      update: (patch: Record<string, unknown>) => {
        calls.push(["update", table, Object.keys(patch).sort()]);
        return chain();
      },
      delete: () => {
        calls.push(["delete", table]);
        return chain();
      },
    }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("createSupabasePushDevices", () => {
  it("list：只取这个人、这个 bundle 的令牌；认不出的环境当没记过", async () => {
    const f = fakeClient({ data: [{ token: "aa", apns_env: "sandbox" }, { token: "bb", apns_env: null }, { token: "cc", apns_env: "weird" }], error: null });
    const store = createSupabasePushDevices(f.client, "com.stanyan.mrotto.mobile", () => {});
    expect(await store.list("u1")).toEqual([
      { token: "aa", env: "sandbox" },
      { token: "bb", env: null },
      { token: "cc", env: null },
    ]);
    expect(f.calls).toEqual([
      ["select", "push_devices", "token, apns_env"],
      ["eq", "user_id", "u1"],
      ["eq", "bundle_id", "com.stanyan.mrotto.mobile"],
    ]);
  });
  it("list 查询失败：往上抛（「查不到」不许说成「他没有设备」）", async () => {
    const f = fakeClient({ error: { message: "boom" } });
    await expect(createSupabasePushDevices(f.client, "b", () => {}).list("u1")).rejects.toThrow("boom");
  });
  it("setEnv / remove：失败只记日志不抛", async () => {
    const logs: string[] = [];
    const f = fakeClient(new Error("offline"));
    const store = createSupabasePushDevices(f.client, "b", (m) => logs.push(m));
    await store.setEnv("aa", "production");
    await store.remove("aa");
    expect(logs).toHaveLength(2);
  });
});
```

`tests/runtime/frameHandler.test.ts` 末尾加：

```ts
describe("uidOf（#1411）", () => {
  it("验过籍的连接回它的 uid；没验过、离场之后回 null", async () => {
    const { deps } = makeDeps();
    const handler = createFrameHandler(deps);
    expect(handler.uidOf("c1")).toBeNull();
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    expect(handler.uidOf("c1")).toBe("u1");
    handler.onGone("c1");
    expect(handler.uidOf("c1")).toBeNull();
  });
});
```

新建 `tests/runtime/daemonCallbackWiring.test.ts`：

```ts
// daemon.ts 进不了 vitest（import 即连 docker / Supabase）。回电（#1411）在它身上的接线，漏了都是安静的：
// 推送永远关着（工具不出现、没人发现）、isWatching 恒假（人正看着聊天也响铃）或恒真（永远不打）。
// 所以判据落在源码上（同 daemonActivityWiring.test.ts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：回电的接线（#1411）", () => {
  it("配了 APNS_* 才造推送：.p8 启动时读一次，令牌表按 bundle 读", () => {
    expect(src).toMatch(/createApnsPusher\(/);
    expect(src).toMatch(/readFileSync\(apnsCfg\.keyFile, "utf8"\)/);
    expect(src).toMatch(/createSupabasePushDevices\(supabase, apnsCfg\.bundleId/);
  });
  it("每条会话的 callback：推送关着给 null；isWatching 读这个房间的在场名单 + frameHandler.uidOf", () => {
    expect(src).toMatch(/callback:\s*apns === null\s*\?\s*null/);
    expect(src).toMatch(/isWatching:\s*\(uid\)\s*=>\s*\[\.\.\.roster\]\.some\(\(cid\)\s*=>\s*frameHandler\.uidOf\(cid\)\s*===\s*uid\)/);
    expect(src).toMatch(/deviceCount:\s*\(uid\)\s*=>\s*apns\.deviceCount\(uid\)/);
    expect(src).toMatch(/push:\s*\(uid, ring\)\s*=>\s*apns\.pushRing\(uid, ring\)/);
    expect(src).not.toMatch(/callback: null, \/\/ 推送的接线在下一步/);
  });
  it("启动日志说清推送开没开", () => {
    expect(src).toMatch(/推送开着/);
    expect(src).toMatch(/推送关着/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/pushDevices.test.ts tests/runtime/frameHandler.test.ts tests/runtime/daemonCallbackWiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 新建 `services/runtime/src/pushDevices.ts`**

```ts
// pushDevices —— 推送令牌表（0045 的 push_devices）的 runtime 那一侧（#1411，spec §1.1 / §1.3）。
// service key 绕过 RLS：按人取令牌（只取这个 bundle 的——别的 App 的令牌拿我们的 topic 去发必然被拒）、
// 回写发成功的那个环境、删掉作废的令牌。
// 读失败往上抛：「查不到」不许说成「他没有设备」（callRinger 会分开说）；写失败只记日志：环境没回写只是
// 下次多试一次，作废令牌没删只是下次多发一次。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApnsEnv, PushDevice, PushDeviceStore } from "./apns.js";

export function createSupabasePushDevices(client: SupabaseClient, bundleId: string, log: (m: string) => void): PushDeviceStore {
  const tryWrite = async (what: string, run: () => PromiseLike<{ error: { message: string } | null }>): Promise<void> => {
    // try/catch 而不是只看 {error}：supabase-js 的查询构造器断网时直接 reject（同 cloudSessionMeta.ts 的那条教训）
    try {
      const { error } = await run();
      if (error) log(`[otto-runtime] push_devices ${what}失败：${error.message}`);
    } catch (err) {
      log(`[otto-runtime] push_devices ${what}失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    async list(uid) {
      const { data, error } = await client.from("push_devices").select("token, apns_env").eq("user_id", uid).eq("bundle_id", bundleId);
      if (error) throw new Error(`push_devices 查询失败：${error.message}`);
      return ((data ?? []) as { token: string; apns_env: string | null }[]).map((r): PushDevice => ({
        token: r.token,
        env: r.apns_env === "production" || r.apns_env === "sandbox" ? r.apns_env : null,
      }));
    },
    setEnv(token: string, env: ApnsEnv) {
      return tryWrite("回写环境", () => client.from("push_devices").update({ apns_env: env, updated_at: new Date().toISOString() }).eq("token", token));
    },
    remove(token: string) {
      return tryWrite("删作废令牌", () => client.from("push_devices").delete().eq("token", token));
    },
  };
}
```

- [ ] **Step 4: `frameHandler.ts` 加 `uidOf`**

`export interface FrameHandler {` 里 `onGone(cid: string): void;` 下面加：

```ts
  /** 这条连接验过的 uid（#1411：runtime 要知道「他此刻开没开着这条会话」）。没验过 / 已离场回 null */
  uidOf(cid: string): string | null;
```

内层 `const inner: FrameHandler = {` 的 `onGone(cid) { cids.delete(cid); },` 后面加：

```ts
    uidOf(cid) {
      return cids.get(cid)?.uid ?? null;
    },
```

最后 `return {` 那个外层对象里 `onGone(cid) { … },` 后面加：

```ts
    uidOf: (cid) => inner.uidOf(cid),
```

- [ ] **Step 5: `daemon.ts` 接上**

import 区加：

```ts
import { createApnsPusher } from "./apns.js";
import { createSupabasePushDevices } from "./pushDevices.js";
```

`  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);` 下面加：

```ts
  // 回电的推送（#1411，ADR-0331）：三个 APNS_* 全有才开（config.ts）；.p8 这里读一次——读不到就起不来，
  // 同 loadConfig 的 fail fast：带着一把读不出来的钥匙跑起来，每一通电话都会安静地失败
  const apnsCfg = config.apns;
  const apns =
    apnsCfg === null
      ? null
      : createApnsPusher({
          key: { keyPem: readFileSync(apnsCfg.keyFile, "utf8"), keyId: apnsCfg.keyId, teamId: apnsCfg.teamId, bundleId: apnsCfg.bundleId },
          devices: createSupabasePushDevices(supabase, apnsCfg.bundleId, (m) => console.warn(m)),
          log: (m) => console.warn(m),
        });
  console.log(
    apnsCfg === null
      ? "[otto-runtime] 推送关着（没配 APNS_*）：智能体没有回电那把刀"
      : `[otto-runtime] 推送开着（APNs，bundle ${apnsCfg.bundleId}）`
  );
```

`createCloudSession({…})` 里 Task 5 留的那一行 `      callback: null, // 推送的接线在下一步（#1411）` 换成：

```ts
      // 回电（#1411）：推送关着 = null（刀不出现）。isWatching = 这个房间里有没有他的连接——手机切后台会
      // 主动断开会话房（mobile/src/cloud/cloudClient.ts），所以「连着」就是「开着这条聊天」
      callback:
        apns === null
          ? null
          : {
              isWatching: (uid) => [...roster].some((cid) => frameHandler.uidOf(cid) === uid),
              deviceCount: (uid) => apns.deviceCount(uid),
              push: (uid, ring) => apns.pushRing(uid, ring),
            },
```

- [ ] **Step 6: 部署文档**

`deploy/otto-runtime.env.example` 的 `#DATA_DIR=/var/lib/otto-runtime` 那一段后面加：

```
# 可选：回电的推送（#1411，ADR-0331）。三个要么全填、要么全不填——只填一部分，daemon 启动就报缺哪几个。
# 全不填 = 推送关着：智能体没有 call_user 那把刀。.p8 在 Apple Developer → Keys 建（勾 APNs），只能下载一次；
# 放到这台机器上、只给 otto 读（见 docs/runtime-vps.md 1.1）。
#APNS_KEY_FILE=/etc/otto-runtime/apns.p8
#APNS_KEY_ID=
#APNS_TEAM_ID=HV982TTRNP
# 缺省 com.stanyan.mrotto.mobile（手机 App 的 bundle id）
#APNS_BUNDLE_ID=
```

`docs/runtime-vps.md` 1.1 那张表里 `DATA_DIR` 那一行下面加两行：

```
| `APNS_KEY_FILE` / `APNS_KEY_ID` / `APNS_TEAM_ID`（可选，三个一组） | 回电的推送（#1411，ADR-0331）。Apple Developer → Certificates, Identifiers & Profiles → Keys → +，勾 Apple Push Notifications service (APNs)，下载 `.p8`（**只能下载一次**）、记下 Key ID；Team ID 是 `HV982TTRNP`。`.p8` 放到 VPS 上只给 daemon 读：`sudo install -d -m 0750 -o root -g otto /etc/otto-runtime && sudo install -m 0440 -o root -g otto AuthKey_XXXXXXXXXX.p8 /etc/otto-runtime/apns.p8`，`APNS_KEY_FILE` 填这个路径。三个要么全有要么全无：只填一部分，启动就报缺哪几个；全不填 = 推送关着，智能体没有 `call_user`。开没开看 journal 里「推送开着 / 推送关着」那一行 |
| `APNS_BUNDLE_ID`（可选） | 推送的 topic，缺省 `com.stanyan.mrotto.mobile`（手机 App 的 bundle id） |
```

- [ ] **Step 7: 跑测试确认通过、类型干净**

Run: `npx vitest run tests/runtime/pushDevices.test.ts tests/runtime/frameHandler.test.ts tests/runtime/daemonCallbackWiring.test.ts tests/runtime/daemonActivityWiring.test.ts`
Expected: PASS

Run: `npx tsc --noEmit && npx tsc --noEmit -p services/runtime`
Expected: 无输出

- [ ] **Step 8: 提交**

```bash
git add services/runtime/src/pushDevices.ts services/runtime/src/frameHandler.ts services/runtime/src/daemon.ts deploy/otto-runtime.env.example docs/runtime-vps.md tests/runtime/pushDevices.test.ts tests/runtime/frameHandler.test.ts tests/runtime/daemonCallbackWiring.test.ts
git commit -m "feat(runtime): daemon 接上回电的推送与在场判断（#1411）" -m "配了 APNS_* 才造推送，.p8 启动时读一次（读不到就起不来）；令牌表按人按 bundle 取，查不到往上抛、写失败只记日志。isWatching 读这个会话房的在场名单加 frameHandler.uidOf。启动日志说清推送开没开。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 手机 —— 推送登记、铃声、配置

**Files:**
- Create: `scripts/make-ringtone.mjs`、`scripts/make-ringtone.d.mts`、`mobile/assets/sounds/ringtone.caf`（脚本生成）、`mobile/src/push/pushRegistration.ts`
- Modify: `mobile/package.json`、`mobile/package-lock.json`（`npx expo install` 改）、`mobile/app.json`、`mobile/App.tsx`、`mobile/src/account/SettingsScreen.tsx`
- Test: `tests/scripts/makeRingtone.test.ts`、`tests/mobile/pushConfig.test.ts`（都新建）

**Interfaces:**
- Consumes：Task 2 的 RPC 名 `register_push_device(p_token, p_bundle)`、`unregister_push_device(p_token)`。
- Produces：`registerPush(): Promise<void>`、`unregisterPush(): Promise<void>`；包里的 `ringtone.caf`（Task 3 的载荷 `sound` 用这个名字）。

- [ ] **Step 1: 装 expo-notifications**

先确认 `mobile/node_modules` 是真目录：`ls -ld mobile/node_modules`（是软链或不存在就 `rm -f mobile/node_modules && npm --prefix mobile ci`）。

Run: `cd mobile && npx expo install expo-notifications && cd ..`
Expected: `mobile/package.json` 多一行 `"expo-notifications": "~57.0.x"`，lock 跟着变。若它顺手在 app.json 的 plugins 里加了一个裸的 `"expo-notifications"`，Step 4 会换掉它。

- [ ] **Step 2: 写失败测试**

新建 `tests/scripts/makeRingtone.test.ts`：

```ts
// 回电铃声（#1411，spec §3.4）：APNs 的通知铃声上限 30 秒，超了系统换成默认提示音——这件事不报错。
import { describe, expect, it } from "vitest";
import { RATE, ringtoneSamples, wavBytes } from "../../scripts/make-ringtone.mjs";

describe("make-ringtone", () => {
  it("总长 20~30 秒、不削波", () => {
    const s = ringtoneSamples();
    expect(s.length / RATE).toBeLessThanOrEqual(30);
    expect(s.length / RATE).toBeGreaterThan(20);
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(1);
  });
  it("WAV 头：RIFF / WAVE、PCM 单声道 16 位、数据长度对得上", () => {
    const s = ringtoneSamples();
    const b = wavBytes(s);
    expect(b.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(b.subarray(8, 12).toString("latin1")).toBe("WAVE");
    expect(b.readUInt16LE(20)).toBe(1);
    expect(b.readUInt16LE(22)).toBe(1);
    expect(b.readUInt32LE(24)).toBe(RATE);
    expect(b.readUInt16LE(34)).toBe(16);
    expect(b.readUInt32LE(40)).toBe(s.length * 2);
  });
});
```

新建 `tests/mobile/pushConfig.test.ts`：

```ts
// 回电推送的手机配置（#1411，spec §1.2 / §3.4）：配置插件、时效性通知的 entitlement、铃声文件。
// 这几格错了不会有任何报错——包照样打得出来，只是锁屏上的来电不响、或者专注模式里被挡掉。
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../mobile/", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", root), "utf8")) as {
  expo: { ios: { entitlements?: Record<string, unknown> }; plugins: unknown[] };
};
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { dependencies: Record<string, string> };

describe("手机端推送配置（#1411）", () => {
  it("装了 expo-notifications（SDK 57 那一版）", () => {
    expect(pkg.dependencies["expo-notifications"]).toMatch(/^~57\.0\./);
  });
  it("插件带上铃声；时效性通知的 entitlement 开着；UIScene 插件还在", () => {
    const plugin = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-notifications") as [string, { sounds?: string[] }] | undefined;
    expect(plugin?.[1].sounds).toEqual(["./assets/sounds/ringtone.caf"]);
    expect(app.expo.plugins).not.toContain("expo-notifications");
    expect(app.expo.ios.entitlements?.["com.apple.developer.usernotifications.time-sensitive"]).toBe(true);
    expect(app.expo.plugins).toContain("./plugins/withSceneLifecycle");
  });
  it("铃声文件在，是 CAF", () => {
    const f = new URL("assets/sounds/ringtone.caf", root);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f).subarray(0, 4).toString("latin1")).toBe("caff");
  });
});
```

Run: `npx vitest run tests/scripts/makeRingtone.test.ts tests/mobile/pushConfig.test.ts`
Expected: FAIL（脚本、配置、铃声都还没有）

- [ ] **Step 3: 铃声脚本与产物**

新建 `scripts/make-ringtone.mjs`：

```js
#!/usr/bin/env node
// make-ringtone —— 回电的铃声（#1411，spec §3.4）。自己合成、不用别人的音频（没有授权问题），产物提交在
// mobile/assets/sounds/ringtone.caf，由 expo-notifications 插件打进包里。
// 形状：两个音交替（E6 / C6，各 0.4 秒、敲一下的衰减）响两遍、停一秒多，一个周期 3 秒，九个周期 27 秒——
// APNs 的通知铃声上限 30 秒，超了系统换成默认提示音。
// 用法：node scripts/make-ringtone.mjs（WAV → CAF 那一步用 macOS 自带的 afconvert，只在 mac 上跑得完）
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RATE = 22_050;
export const CYCLE_S = 3;
export const CYCLES = 9;
const NOTE_S = 0.4;
const NOTES = [
  { at: 0.0, hz: 1318.51 },
  { at: 0.45, hz: 1046.5 },
  { at: 1.0, hz: 1318.51 },
  { at: 1.45, hz: 1046.5 },
];

/** 一整段铃声的采样（-1..1） */
export function ringtoneSamples(rate = RATE) {
  const total = Math.round(CYCLE_S * CYCLES * rate);
  const out = new Float32Array(total);
  const len = Math.round(NOTE_S * rate);
  for (let c = 0; c < CYCLES; c++) {
    for (const n of NOTES) {
      const start = Math.round((c * CYCLE_S + n.at) * rate);
      for (let i = 0; i < len && start + i < total; i++) {
        const t = i / rate;
        const attack = Math.min(1, t / 0.01); // 10ms 起音，免得咔哒一声
        const decay = Math.exp(-t * 6); // 敲一下的衰减
        const tail = Math.min(1, (len - i) / (0.02 * rate)); // 最后 20ms 收干净
        const tone = Math.sin(2 * Math.PI * n.hz * t) + 0.3 * Math.sin(2 * Math.PI * 2 * n.hz * t);
        out[start + i] += 0.45 * attack * decay * tail * tone;
      }
    }
  }
  return out;
}

/** 16 位单声道 PCM 的 WAV 字节 */
export function wavBytes(samples, rate = RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 单声道
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const wav = join(mkdtempSync(join(tmpdir(), "ringtone-")), "ringtone.wav");
  writeFileSync(wav, wavBytes(ringtoneSamples()));
  const out = join(root, "mobile", "assets", "sounds", "ringtone.caf");
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync("afconvert", ["-f", "caff", "-d", "LEI16", wav, out], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("afconvert 失败（它只在 macOS 上有）");
    process.exit(1);
  }
  console.log(`写好了：${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

新建 `scripts/make-ringtone.d.mts`：

```ts
// scripts/make-ringtone.mjs 的类型面（#1411）：同 deploy-stamp.d.mts——脚本是普通 node ESM（不进 tsc），
// 被单测 import 才要这一份。手写的，.mjs 那侧改了签名这里不会自动红，只有调用点会。
export declare const RATE: number;
export declare const CYCLE_S: number;
export declare const CYCLES: number;
export declare function ringtoneSamples(rate?: number): Float32Array;
export declare function wavBytes(samples: Float32Array, rate?: number): Buffer;
```

Run: `node scripts/make-ringtone.mjs`
Expected: `写好了：…/mobile/assets/sounds/ringtone.caf`

- [ ] **Step 4: app.json**

`mobile/app.json`：`ios` 里 `infoPlist` 那一格后面加

```json
      "entitlements": {
        "com.apple.developer.usernotifications.time-sensitive": true
      }
```

`plugins` 数组变成（若 Step 1 加了裸的 `"expo-notifications"`，删掉它）：

```json
    "plugins": [
      "expo-sqlite",
      "expo-web-browser",
      [
        "expo-camera",
        {
          "cameraPermissionText": "扫描电脑上的配对二维码时要用一下相机。",
          "microphonePermission": "语音通话时要用麦克风听你说话。"
        }
      ],
      "expo-font",
      [
        "expo-notifications",
        {
          "sounds": ["./assets/sounds/ringtone.caf"]
        }
      ],
      "./plugins/withSceneLifecycle"
    ]
```

- [ ] **Step 5: 登记 / 注销**

新建 `mobile/src/push/pushRegistration.ts`：

```ts
// 推送登记（#1411，spec §1.2）：智能体办完事打电话回给你，手机先得把自己的推送令牌交给服务端。
//
// · 冷启动（已登录）、每次回到前台、每次登录，各登记一次：令牌可能变，RPC 是幂等的（0045 的
//   register_push_device）。第一次会弹系统的通知权限框——拒了就没有令牌，这个人收不到回电
//   （runtime 那边说「他的手机没开通知」）。
// · 退出登录前注销这台（unregisterPush）：退出之后这台手机不该再响这个账号的来电。最多等 3 秒，断网照样退出。
// · Expo Go 里不登记：那里拿到的是 Expo Go 自己的令牌，拿我们的 bundle 当 topic 去发必然被 APNs 拒。
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";
import { supabase } from "../supabase.js";

const BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier ?? "com.stanyan.mrotto.mobile";
const PUSHABLE = Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

/** 这次启动登记成功的那个令牌（注销用） */
let token: string | null = null;
let inflight: Promise<void> | null = null;

const warn = (what: string, e: unknown): void => {
  console.warn(`推送${what}失败：${e instanceof Error ? e.message : String(e)}`);
};

/** 登记这台手机（登录了才做；没权限就先问一次，问过被拒就算了） */
export function registerPush(): Promise<void> {
  if (!PUSHABLE) return Promise.resolve();
  if (inflight !== null) return inflight;
  inflight = (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session === null) return;
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) {
      perm = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    }
    if (!perm.granted) return;
    const t = (await Notifications.getDevicePushTokenAsync()).data;
    if (typeof t !== "string" || t === "") return;
    const { error } = await supabase.rpc("register_push_device", { p_token: t, p_bundle: BUNDLE_ID });
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
  if (!PUSHABLE || token === null) return;
  const t = token;
  const call = (async () => {
    const { error } = await supabase.rpc("unregister_push_device", { p_token: t });
    if (error) warn("注销", error.message);
    else token = null;
  })().catch((e: unknown) => warn("注销", e));
  await Promise.race([call, new Promise<void>((r) => setTimeout(r, 3_000))]);
}

void registerPush();
AppState.addEventListener("change", (s) => {
  if (s === "active") void registerPush();
});
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN") void registerPush();
});
```

`mobile/App.tsx`：`import { loadThemePref } from "./src/themePref.js";` 下面加：

```ts
// 回电（#1411）：推送登记要在第一条通知到之前挂上——模块一加载就挂
import "./src/push/pushRegistration.js";
```

`mobile/src/account/SettingsScreen.tsx`：import 区加 `import { unregisterPush } from "../push/pushRegistration.js";`；`signOut` 的 `try {` 里第一行（`// 只登出这台手机…` 注释上面）加：

```ts
      // 先注销这台的推送令牌（#1411）：退出之后这台手机不该再响这个账号的来电。最多等 3 秒，断网也照样退出
      await unregisterPush();
```

- [ ] **Step 6: 跑测试确认通过、类型干净**

Run: `npx vitest run tests/scripts/makeRingtone.test.ts tests/mobile/pushConfig.test.ts`
Expected: PASS

Run: `npx tsc --noEmit && npm --prefix mobile run typecheck`
Expected: 无输出

- [ ] **Step 7: 提交**

```bash
git add scripts/make-ringtone.mjs scripts/make-ringtone.d.mts mobile/assets/sounds/ringtone.caf mobile/src/push/pushRegistration.ts mobile/package.json mobile/package-lock.json mobile/app.json mobile/App.tsx mobile/src/account/SettingsScreen.tsx tests/scripts/makeRingtone.test.ts tests/mobile/pushConfig.test.ts
git commit -m "feat(mobile): 推送登记与回电铃声（#1411）" -m "登录后、回前台、再登录各登记一次令牌（RPC 幂等），退出前注销这台（最多等 3 秒）；Expo Go 里不登记。铃声自己合成（两音交替 27 秒，APNs 上限 30 秒），脚本一并提交。时效性通知的 entitlement 打开：专注模式里也要响。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 切后台 = 不在看：会话房主动断开

**Files:**
- Modify: `src/shared/remote/wsTransport.ts`、`mobile/src/cloud/cloudClient.ts`
- Test: `tests/shared/remote/wsTransport.test.ts`

**Interfaces:**
- Produces：`createWsTransport(...)` 的返回类型多一个 `pause(why: string): void`（只在返回类型上，不进 `RemoteTransport` 接口——同 `isOpen` 的理由）。

- [ ] **Step 1: 写失败测试**

`tests/shared/remote/wsTransport.test.ts` 里 `it("close() 之后不再重连", …)` 前面加：

```ts
  // #1411：手机切后台主动断开。不然 iOS 挂起的 socket 在服务端看来还连着，runtime 以为人还开着这条聊天，
  // 回电永远不打
  it("pause：关掉当前连接、通知桥这一轮作废、之后不自己重连；reconnectNow 才接着连", async () => {
    const { t } = make();
    await settle();
    last().open();
    const old = last();
    const closes: number[] = [];
    t.onClose(() => closes.push(1));
    t.pause("切到后台");
    expect(old.closedWith?.code).toBe(1000);
    expect(closes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.instances).toHaveLength(1);
    t.reconnectNow("回到前台");
    await settle();
    expect(FakeWs.instances).toHaveLength(2);
    t.close();
  });

  it("pause 碰上正在等令牌的那次建连：令牌回来之后不连", async () => {
    let release!: (v: string) => void;
    const { t } = make({ authToken: () => new Promise<string>((r) => { release = r; }) });
    t.pause("切到后台");
    release("jwt-abc");
    await settle();
    expect(FakeWs.instances).toHaveLength(0);
    t.close();
  });
```

Run: `npx vitest run tests/shared/remote/wsTransport.test.ts`
Expected: FAIL（`t.pause is not a function`）

- [ ] **Step 2: 改 `src/shared/remote/wsTransport.ts`**

返回类型那个交叉类型里 `isOpen(): boolean;` 下面加：

```ts
  /** 暂停（#1411）：关掉当前连接、不排重连，直到下一次 reconnectNow。手机切后台用——后台的 app 收不了帧、
      人也不在看，而 iOS 挂起的 socket 在服务端看来还连着（中继自己应答心跳，runtime 看不见），于是
      runtime 以为人还开着这条聊天，回电就不打了。主动关掉，中继当场报 :gone。
      同 isOpen 的理由不进 RemoteTransport 接口：那个接口有别的实现 */
  pause(why: string): void;
```

`  let closed = false;` 下面加 `  let paused = false;`

`scheduleReconnect` 第一行 `if (closed || retryTimer) return;` 改成 `if (closed || paused || retryTimer) return;`

`connect` 里两处 `if (closed || ws) return;` 都改成 `if (closed || paused || ws) return;`

`reconnectNow(why: string) {` 里 `if (closed) return;` 下一行加 `      paused = false;`

`reconnectNow` 那个方法后面加：

```ts
    pause(why: string) {
      if (closed) return;
      log(`远程传输:${why},先断开`);
      paused = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const dying = ws;
      ws = null; // 先摘,免得 close 触发的 onclose 把它当"当前连接"再排一次重连
      stopBeat();
      openedAt = null;
      myCid = "";
      if (dying) {
        try { dying.close(1000, "paused"); } catch { /* 已经在关了 */ }
        onClose(); // 桥要知道这一轮作废了（密钥跟着连接走）
      }
    },
```

- [ ] **Step 3: 改 `mobile/src/cloud/cloudClient.ts`**

`import type { RemoteTransport } from "../../../src/shared/remote/transport.js";` 这一行删掉（若别处还用就留着），`let room: RemoteTransport | null = null;` 改成：

```ts
let room: ReturnType<typeof createWsTransport> | null = null;
```

文件头注释第二段改成：

```ts
// App 回到前台时对当前会话房 reconnectNow：iOS 把后台 app 的 socket 掐了之后，退避重连
// 可能还要等好几秒，人一回来就该立刻换一条。切到后台时反过来主动断开（#1411）：后台 = 不在看，
// runtime 据「房里有没有他的连接」决定回电打不打，挂起的 socket 在服务端看来却还连着。
```

AppState 那一段换成：

```ts
AppState.addEventListener("change", (s) => {
  // 已经关掉的传输（leave 之后）reconnectNow / pause 都是空操作
  if (s === "active") room?.reconnectNow("回到前台");
  else if (s === "background") room?.pause("切到后台");
});
```

- [ ] **Step 4: 跑测试确认通过、类型干净**

Run: `npx vitest run tests/shared/remote/wsTransport.test.ts`
Expected: PASS

Run: `npx tsc --noEmit && npm --prefix mobile run typecheck`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add src/shared/remote/wsTransport.ts mobile/src/cloud/cloudClient.ts tests/shared/remote/wsTransport.test.ts
git commit -m "feat(mobile): 切到后台主动断开会话房（#1411）" -m "回电看「房里有没有他的连接」决定打不打。iOS 挂起的 socket 在服务端看来还连着（心跳由中继自己应答），不主动断，挂了电话锁屏之后回电永远打不出去。pause 之后不自己重连，回到前台的 reconnectNow 接着连。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 手机 —— 来电页与接听

**Files:**
- Create: `mobile/src/nav/navRef.ts`、`mobile/src/call/ringStore.ts`、`mobile/src/call/IncomingCall.tsx`
- Modify: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`、`mobile/src/voice/CallOverlay.tsx`、`mobile/App.tsx`、`mobile/src/chat/ChatScreen.tsx`

**Interfaces:**
- Consumes：Task 1 的 `RingPush`、`ringFromPayload`、`ringTarget`、`queueRing`、`dropRing`；Task 7 装好的 expo-notifications；现有 `startCall(sessionId, agentIds)`（`mobile/src/voice/voiceStore.ts`）、`FaceTile`、`agentFaceSlot`、`agentAvatarSlot`、`facePhase`、`homeSnapshot`、`teamsSnapshot`。
- Produces：`navRef`；`useRings()`、`answerRing(ring)`、`declineRing(ring)`、`pruneRings()`、`flushPendingNav()`；路由参数 `Chat: ChatRoute & { autoCall?: boolean; answerRing?: { ringId: string; agentId: string } }`；`CallOverlay.tsx` 导出 `RoundControl`、`SHELL`、`FG`、`FG2`。

这一片没有 vitest 能跑的部分（判据已在 Task 1 的 `callRing.test.ts` 里钉了）；验收是 mobile 的 tsc 与 Task 12 的真机。

- [ ] **Step 1: 导航引用与路由参数**

新建 `mobile/src/nav/navRef.ts`：

```ts
// 导航引用（#1411）：来电是从通知里来的，不在任何一页里——接听要从外面把人送进那条聊天
import { createNavigationContainerRef } from "@react-navigation/native";
import type { RootStackParams } from "./types.js";

export const navRef = createNavigationContainerRef<RootStackParams>();
```

`mobile/src/nav/types.ts`：

```ts
  /** autoCall：从智能体资料点「语音通话」进来——房间一 ready 就把电话打出去（一次） */
  Chat: ChatRoute & { autoCall?: boolean };
```

换成

```ts
  /** autoCall：从智能体资料点「语音通话」进来——房间一 ready 就把电话打出去（一次）。
      answerRing：从来电页点「接听」进来（#1411）——房间一 ready 就把打电话的那只拉进通话（一次） */
  Chat: ChatRoute & { autoCall?: boolean; answerRing?: { ringId: string; agentId: string } };
```

- [ ] **Step 2: `CallOverlay.tsx` 导出来电页要复用的几样**

把 `const SHELL = "#141416";`、`const FG = "#ffffff";`、`const FG2 = "rgba(255, 255, 255, 0.62)";` 三行前面各加 `export `；`function RoundControl({` 前面加 `export `。

- [ ] **Step 3: 新建 `mobile/src/call/ringStore.ts`**

```ts
// 来电（#1411，spec §3.1–3.2）：推送里带 `ring` 的那种通知 → 全屏来电页。三个入口汇进一个队列：
// App 在前台时收到的（不弹横幅、铃声照响、直接弹来电页）；在后台 / 锁屏时点开的（没过期 → 来电页，
// 过期了 → 直接打开那条聊天，照微信：点未接来电的通知不自动回拨）；冷启动时点开的那一条
// （getLastNotificationResponseAsync）。同一时刻只弹一张，后到的排在后面（queueRing）。
//
// 接听 = 撤掉那条通知 → 导航重置成「首页 → 那条聊天」、带上 answerRing → 聊天页房间 ready 后把这只拉进通话
// （runtime 的 setVoiceCall 认出「正在给他响铃」，记接通、换成回电开场白）。重置而不是推一页：手机只有
// 一份「当前聊天」store，聊天页叠聊天页会让下面那一页在返回时对着一份已关掉的 store。
// 挂断 = 只撤掉来电页与通知，服务端到点记未接，不另发「拒接」（spec §3.2）。
import { CommonActions } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import { useSyncExternalStore } from "react";
import { dropRing, queueRing, ringFromPayload, ringTarget, type RingPush } from "../../../src/shared/callRing.js";
import { createStore } from "../externalStore.js";
import { navRef } from "../nav/navRef.js";

interface RingQueue {
  queue: RingPush[];
}
const store = createStore<RingQueue>({ queue: [] });

export function useRings(): RingQueue {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** 通知里的 ring。只认远程推送：本地通知没有 payload */
function ringOf(n: Notifications.Notification): RingPush | null {
  const t = n.request.trigger;
  if (t === null || typeof t !== "object" || !("type" in t) || t.type !== "push") return null;
  return ringFromPayload((t as { payload?: unknown }).payload);
}

/** 那一通对应的系统通知（接听 / 挂断时撤掉它，铃声跟着停——停不停要真机验，见 spec §8） */
const noticeOf = new Map<string, string>();

function enqueue(ring: RingPush, noticeId: string): void {
  noticeOf.set(ring.ringId, noticeId);
  store.set((s) => ({ queue: queueRing(s.queue, ring, Date.now()) }));
}

async function dismissNotice(ringId: string): Promise<void> {
  const id = noticeOf.get(ringId);
  noticeOf.delete(ringId);
  if (id !== undefined) await Notifications.dismissNotificationAsync(id).catch(() => undefined);
}

let pendingNav: (() => void) | null = null;

/** 把人送进那条聊天。冷启动时导航还没挂上，先记着，RootNavigator 的 onReady 再送 */
function openChatOf(ring: RingPush, answer: boolean): void {
  const params = { ...ringTarget(ring), ...(answer ? { answerRing: { ringId: ring.ringId, agentId: ring.agentId } } : {}) };
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
  store.set((s) => ({ queue: dropRing(s.queue, ring.ringId, Date.now()) }));
  void dismissNotice(ring.ringId);
  openChatOf(ring, true);
}

export function declineRing(ring: RingPush): void {
  store.set((s) => ({ queue: dropRing(s.queue, ring.ringId, Date.now()) }));
  void dismissNotice(ring.ringId);
}

/** 过了时限的清出队列（来电页每秒对一次表时调） */
export function pruneRings(): void {
  const now = Date.now();
  if (store.get().queue.some((r) => r.expiresTs <= now)) {
    store.set((s) => ({ queue: s.queue.filter((r) => r.expiresTs > now) }));
  }
}

function onResponse(r: Notifications.NotificationResponse): void {
  const ring = ringOf(r.notification);
  if (ring === null) return;
  if (ring.expiresTs > Date.now()) enqueue(ring, r.notification.request.identifier);
  else openChatOf(ring, false);
}

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const ring = ringOf(n);
    if (ring === null) return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
    // App 开着：来电页就是横幅，不再弹一条；铃声照响（通知里那 30 秒）
    enqueue(ring, n.request.identifier);
    return { shouldShowBanner: false, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
  },
});
Notifications.addNotificationResponseReceivedListener(onResponse);
// 冷启动：点通知把 App 叫起来的那一次，发生在监听器挂上之前
void Notifications.getLastNotificationResponseAsync()
  .then((r) => {
    if (r !== null) onResponse(r);
    return Notifications.clearLastNotificationResponseAsync();
  })
  .catch(() => undefined);
```

- [ ] **Step 4: 新建 `mobile/src/call/IncomingCall.tsx`**

```tsx
// 全屏来电页（#1411，spec §3.2）：它的脸（waiting——唯一左右摆的那一档，「等你」）、名字、它要说的那句话、
// 「挂断」「接听」。手机一直震，直到接了、挂了或过了时限。同一时刻只弹一张（队列在 ringStore）。
// 样子照通话整屏（CallOverlay）：深色一屏、两个主题同一个样子。
// 按了接听 / 挂断先让这一页退场，退场完（onDismiss）才真去做：iOS 不许在正在退场的 Modal 上再叠一个，
// 而聊天页马上要弹通话整屏（同 wx/ActionSheet 的规矩）。
import { useEffect, useState } from "react";
import { Modal, Text, Vibration, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { agentAvatarSlot } from "../../../src/shared/agentAvatarSlot.js";
import type { RingPush } from "../../../src/shared/callRing.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { homeSnapshot } from "../home/homeStore.js";
import { teamsSnapshot } from "../inbox/teamsStore.js";
import { FG, FG2, RoundControl, SHELL } from "../voice/CallOverlay.js";
import { FaceTile } from "../wx/Avatar.js";
import { answerRing, declineRing, pruneRings, useRings } from "./ringStore.js";

/** 震的节奏：震一下、停一下（iOS 忽略时长，只认「一震一停」的次数） */
const VIBRATE = [0, 800, 1200];

/** 这通电话所在的工作区快照（画脸要它）。找不到就按 id 派生一张：来电一定要有张脸 */
function wsOf(ring: RingPush): WorkspaceSnapshot | null {
  const home = homeSnapshot().home;
  if (home !== null && home.id === ring.workspaceId) return home;
  const t = teamsSnapshot();
  return t.teams.find((x) => x.ws.id === ring.workspaceId)?.ws ?? t.guests.find((g) => g.ws.id === ring.workspaceId)?.ws ?? null;
}

export function IncomingCall() {
  const { queue } = useRings();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(() => Date.now());
  const [leaving, setLeaving] = useState<{ ring: RingPush; answer: boolean } | null>(null);
  const ring = leaving?.ring ?? queue.find((r) => r.expiresTs > now) ?? null;
  const ringId = ring?.ringId ?? null;

  // 一秒对一次表：过了时限的清出去（下一通顶上来，或者整页收起）
  useEffect(() => {
    if (queue.length === 0) return;
    const id = setInterval(() => {
      setNow(Date.now());
      pruneRings();
    }, 1_000);
    return () => clearInterval(id);
  }, [queue.length]);

  useEffect(() => {
    if (ringId === null || leaving !== null) return;
    Vibration.vibrate(VIBRATE, true);
    return () => Vibration.cancel();
  }, [ringId, leaving]);

  if (ring === null) return null;
  const ws = wsOf(ring);
  const slot = ws !== null ? agentFaceSlot(ws, ring.agentId) : agentAvatarSlot(ring.agentId, []);
  const leave = (answer: boolean): void => {
    Vibration.cancel();
    setLeaving({ ring, answer });
  };
  const finish = (): void => {
    if (leaving === null) return;
    if (leaving.answer) answerRing(leaving.ring);
    else declineRing(leaving.ring);
    setLeaving(null);
  };

  return (
    <Modal visible={leaving === null} animationType="slide" presentationStyle="fullScreen" statusBarTranslucent onDismiss={finish} onRequestClose={() => leave(false)}>
      <View style={{ flex: 1, backgroundColor: SHELL, paddingTop: insets.top + 56, paddingBottom: insets.bottom + 40, paddingHorizontal: 32 }}>
        <View style={{ flex: 1, alignItems: "center", gap: 14 }}>
          <FaceTile slot={slot} size={168} radius={46} state="waiting" phase={facePhase(ring.agentId)} />
          <Text numberOfLines={1} style={{ fontSize: 28, fontWeight: "600", color: FG, marginTop: 10 }}>{ring.agentName}</Text>
          <Text style={{ fontSize: 15, color: FG2 }}>邀请你语音通话</Text>
          <Text numberOfLines={3} style={{ fontSize: 17, lineHeight: 24, color: FG, textAlign: "center", marginTop: 18 }}>{ring.reason}</Text>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
          <RoundControl icon="phone-off" label="挂断" tone="end" onPress={() => leave(false)} />
          <RoundControl icon="phone" label="接听" tone="go" onPress={() => leave(true)} />
        </View>
      </View>
    </Modal>
  );
}
```

- [ ] **Step 5: 挂进根上**

`mobile/src/nav/RootNavigator.tsx`：import 区加

```ts
import { IncomingCall } from "../call/IncomingCall.js";
import { flushPendingNav } from "../call/ringStore.js";
import { navRef } from "./navRef.js";
```

`<NavigationContainer theme={theme}>` 换成 `<NavigationContainer ref={navRef} theme={theme} onReady={flushPendingNav}>`；`      <ToastHost />` 下一行加 `      <IncomingCall />`。

`mobile/App.tsx`：Task 7 加的 `import "./src/push/pushRegistration.js";` 下一行加 `import "./src/call/ringStore.js";`（通知处理器要在第一条通知到之前挂上；RootNavigator 也会 import 它，这里写明是为了说清楚它是有副作用的模块）。

- [ ] **Step 6: 聊天页接住 `answerRing`**

`mobile/src/chat/ChatScreen.tsx`：在

```tsx
  useEffect(() => {
    if (route.params.autoCall !== true || autoCalled.current || !offerPhone) return;
    autoCalled.current = true;
    void onStartCall();
    // onStartCall 每次渲染都是新的；这里只跟「打得了没有」走
  }, [route.params.autoCall, offerPhone]);
```

后面加：

```tsx
  // 接回电（#1411）：从来电页点「接听」进来——房间一 ready 就把打电话的那只拉进通话（一次）。通话本来就开着
  // （锁屏没挂，ADR-0320）时把它并进现在的名单：runtime 认的是「他发的名单里有没有正在给他响铃的那只」
  const answeredRing = useRef<string | null>(null);
  useEffect(() => {
    const ar = route.params.answerRing;
    if (ar === undefined || answeredRing.current === ar.ringId || !ready || session === null) return;
    answeredRing.current = ar.ringId;
    if (!usable) {
      setPageNote({ text: "这台手机上打不了电话（要装开发版）", tone: "muted" });
      return;
    }
    const ids = call === null ? [ar.agentId] : [...new Set([...call.participants.map((p) => p.agentId), ar.agentId])];
    const sid = session.sessionId;
    void (async () => {
      setCallOp("start");
      setCallOpen(true);
      const r = await startCall(sid, ids);
      setCallOp(null);
      if (!r.ok) {
        setCallOpen(false);
        setPageNote(r.unknown ? { text: "没有收到回执，不确定接通了没有", tone: "muted" } : { text: r.message, tone: "error" });
      }
    })();
    // 只跟「房间好了没有」走（同 autoCall）
  }, [route.params.answerRing, ready, session?.sessionId]);
```

- [ ] **Step 7: 类型干净**

Run: `npm --prefix mobile run typecheck && npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 8: 提交**

```bash
git add mobile/src/nav/navRef.ts mobile/src/nav/types.ts mobile/src/nav/RootNavigator.tsx mobile/src/call/ringStore.ts mobile/src/call/IncomingCall.tsx mobile/src/voice/CallOverlay.tsx mobile/App.tsx mobile/src/chat/ChatScreen.tsx
git commit -m "feat(mobile): 全屏来电页与接听（#1411）" -m "前台收到回电不弹横幅、铃声照响、直接弹来电页；后台点开没过期的进来电页，过期的直接开那条聊天。接听把导航重置成首页 → 那条聊天，房间 ready 后把它拉进通话（通话本来就开着就并进名单）。按钮先让来电页退场，onDismiss 再真去做：iOS 不许在退场中的 Modal 上再叠一个。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 手机 —— 聊天里的来电卡

**Files:**
- Modify: `src/shared/mobileChat.ts`、`mobile/src/chat/Bubbles.tsx`
- Test: `tests/shared/mobileChat.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `callRingFoldOf`、`ringCardStatus`、`RING_STATUS_TEXT`、`type RingCardStatus`。
- Produces：`ChatRow` 多一种 `{ kind: "ring"; key: string; ts: number; agentId: string; name: string; reason: string; status: RingCardStatus }`。

- [ ] **Step 1: 写失败测试**

`tests/shared/mobileChat.test.ts` 末尾加（`WS`、`DAY`、`e`、`seq` 是文件顶上现成的夹具）：

```ts
describe("chatRows：回电那张卡（#1411）", () => {
  it("一次响铃一张卡，卡在打出去那一条的位置，状态取这一通最后一条", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "user_message", content: "[Stan]: 部署一下，办完打给我", fromUid: "me", mentions: ["a_000000000002"] }),
        e({ type: "call_ring", ringId: "r1", phase: "ringing", fromAgentId: "a_000000000002", toUid: "me", reason: "部署完了", expiresTs: DAY + 45_000, ignorable: true }),
        e({ type: "call_ring", ringId: "r1", phase: "answered", fromAgentId: "a_000000000002", toUid: "me", reason: "部署完了", expiresTs: DAY + 45_000, ignorable: true }),
      ],
      ws: WS, selfUid: "me", now: DAY + 60_000,
    });
    expect(rows.map((r) => r.kind)).toEqual(["time", "mine", "ring"]);
    expect(rows[2]).toEqual({ kind: "ring", key: "ring-r1", ts: DAY, agentId: "a_000000000002", name: "运维", reason: "部署完了", status: "answered" });
  });
  it("还挂在响但过了时限（runtime 那一刻没在跑）：按未接画", () => {
    seq = 0;
    const rows = chatRows({
      events: [e({ type: "call_ring", ringId: "r2", phase: "ringing", fromAgentId: "a_000000000002", toUid: "me", reason: "要你拍板", expiresTs: DAY + 45_000, ignorable: true })],
      ws: WS, selfUid: "me", now: DAY + 46_000,
    });
    expect(rows.find((r) => r.kind === "ring")).toMatchObject({ status: "missed" });
  });
});
```

Run: `npx vitest run tests/shared/mobileChat.test.ts`
Expected: FAIL（没有 ring 这种行：`call_ring` 被 `hiddenFromCloudTimeline` 整条藏了）

- [ ] **Step 2: 改 `src/shared/mobileChat.ts`**

import 区加 `import { callRingFoldOf, ringCardStatus, type RingCardStatus } from "./callRing.js";`

`ChatRow` 联合里 `approval` 那一种前面加：

```ts
  /** 它打来的一通电话（#1411）：居中一张小卡——「运维 打来电话」、那句话、状态（正在响 / 已接通 / 未接）。
      一次响铃一张，卡在打出去那一条的位置，状态取这一通最后一条 */
  | { kind: "ring"; key: string; ts: number; agentId: string; name: string; reason: string; status: RingCardStatus }
```

`chatRows` 里 `const calls = voiceCallCards(o.events, o.ws, o.selfUid);` 下面加：

```ts
  // 回电（#1411）：状态要看这一通后面的事件，同审批那样在循环外先折一遍
  const rings = callRingFoldOf(o.events);
```

循环里 `if (calls.folded.has(e.seq)) continue;` 下面加：

```ts
    // 要在 rowOf 之前认出来：rowOf 先问 hiddenFromCloudTimeline，而桌面把 call_ring 整条藏了
    if (e.type === "call_ring") {
      const r = rings.get(e.ringId);
      if (e.phase === "ringing" && r !== undefined) {
        items.push({
          kind: "ring", key: `ring-${e.ringId}`, ts: e.ts, agentId: r.fromAgentId,
          name: agentNameOf(o.ws, r.fromAgentId), reason: r.reason, status: ringCardStatus(r, o.now),
        });
      }
      continue;
    }
```

- [ ] **Step 3: 改 `mobile/src/chat/Bubbles.tsx`**

import 区加 `import { RING_STATUS_TEXT } from "../../../src/shared/callRing.js";`

`ChatRowView` 的 switch 里 `case "approval":` 前面加：

```tsx
    case "ring":
      return <RingCard row={row} ws={ws} />;
```

`NotePill` 那个函数后面加：

```tsx
/** 它打来的一通电话（#1411）：居中一张小卡——脸 + 电话 +「运维 打来电话」、那句话、状态。未接用红字 */
function RingCard({ row, ws }: { row: Extract<ChatRow, { kind: "ring" }>; ws: WorkspaceSnapshot }) {
  const { c } = usePalette();
  const face = agentFaceIfKnown(ws, row.agentId);
  const tone = row.status === "missed" ? c.destructive : row.status === "ringing" ? c.voice : c.mutedForeground;
  return (
    <View
      accessible
      accessibilityLabel={`${row.name} 打来电话：${row.reason}，${RING_STATUS_TEXT[row.status]}`}
      style={{ alignSelf: "center", maxWidth: "80%", alignItems: "center", gap: 4, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: withAlpha(c.foreground, 0.05) }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {face !== null ? <FaceTile slot={face.slot} size={16} radius={4} /> : null}
        <Icon name="phone" size={13} stroke={2} color={tone} />
        <Text style={{ fontSize: 13, fontWeight: "600", color: c.foreground }}>{`${row.name} 打来电话`}</Text>
      </View>
      <Text numberOfLines={2} style={{ fontSize: 12, lineHeight: 18, color: c.mutedForeground, textAlign: "center" }}>{row.reason}</Text>
      <Text style={{ fontSize: 12, color: tone }}>{RING_STATUS_TEXT[row.status]}</Text>
    </View>
  );
}
```

- [ ] **Step 4: 跑测试确认通过、类型干净**

Run: `npx vitest run tests/shared/mobileChat.test.ts`
Expected: PASS

Run: `npx tsc --noEmit && npm --prefix mobile run typecheck`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add src/shared/mobileChat.ts mobile/src/chat/Bubbles.tsx tests/shared/mobileChat.test.ts
git commit -m "feat(mobile): 聊天里的来电卡（#1411）" -m "一次响铃一张卡，卡在打出去那一条的位置，状态取这一通最后一条；还挂在 ringing 但过了时限的按未接画。要在 rowOf 之前认出 call_ring：桌面那条规则把它整条藏了。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: ADR、索引、spec 回写

**Files:**
- Create: `docs/adr/0331-智能体回电走runtime直发APNs-通知加App内来电页.md`
- Modify: `AGENTS.md`、`docs/superpowers/specs/2026-09-28-agent-callback-design.md`
- Test: `tests/docs/adrNumbers.test.ts`（现成的）

- [ ] **Step 1: 写 ADR**

新建 `docs/adr/0331-智能体回电走runtime直发APNs-通知加App内来电页.md`：

```markdown
# ADR-0331：智能体回电走 runtime 直发 APNs，手机是一条会响的通知加 App 内来电页

- 状态：已采纳
- 日期：2026-09-28
- Issue：#1411
- Spec：`docs/superpowers/specs/2026-09-28-agent-callback-design.md`
- 关系：ADR-0320（手机语音通话；锁屏 = 这台停听、通话还在）、ADR-0271 / 0272（通话与「拉进来的先开口」）、ADR-0256（它的已知代价「手机没有推送凭据那一层」由这一条补上）、ADR-0325（主场群里客人点起的那一轮每一刀都问群主）、ADR-0298（个人主场）

## 背景

维护者原话：「用户可以打电话给智能体交代任务，智能体把事儿办完了，也可以选择打电话回给用户」。打给智能体、挂断后它照样干活，这两件已经有了；缺的是反方向——它办完了、或者要你拍板时，让你的手机响。手机端此前一行推送代码都没有。

## 决定

1. **手机怎么响：一条带 30 秒铃声的时效性通知 + App 内全屏来电页，不用 CallKit**（维护者拍板）。CallKit 要 VoIP 推送与后台音频，得推翻 ADR-0320「锁屏就停听」，原生工作量大几倍；中国大陆 App Store 不允许 CallKit。
2. **什么时候打由智能体判断**，`call_user` 的说明里写清楚：说过「办完打给我」一定打；办了很久、人已经不在、或者要他拍板时可以打；别为小事打。**硬限制在 runtime**（`callRinger.ts`）：对方开着这条聊天不打、同一只打给同一个人 10 分钟一次（从日志算，重启不清零）、没有能收推送的设备不打、这一轮不是人叫起来的没人可打。推送关着时（没配 APNS_*）这把刀根本不出现，通话块也不提回电——不能让模型许诺一通打不出去的电话。
3. **推送走 runtime 直发 APNs**（ES256 provider token + node:http2）。否决 edge 代发（APNs 只收 HTTP/2，Worker 往外走不走得了 HTTP/2 没把握，还多一跳）与 Expo 推送服务（通知内容过第三方，还要配 EAS）。令牌在新表 `push_devices`（0045），客户端只走两个 security definer RPC；按令牌记下的环境发，没记过先生产、不认再沙盒（从 Xcode 装的包只有沙盒认，手机自己分不出来）。
4. **事实在日志**：新事件 `call_ring`（ringing → answered / missed，`ignorable`，模型不可见）。字段叫 `fromAgentId` 不叫 `agentId`：带 agentId 的事件会被 openTurns / foldActivity / agentView 当成那只自己的动静，一通电话不是它的一轮。冷却、重启接着计时 / 补未接、聊天里那张卡都从它推，投影在 `src/shared/callRing.ts`，runtime 与手机共用。
5. **接听不另造帧、不进协议位**：手机发现成的 `call` 帧把那只拉进通话，`setVoiceCall` 认出「发帧的人把正在给他响铃的那只带进了名单」——新拉进来的，或者本来就在一场没人挂断的通话里——就落 answered、把它的开场白换成回电版（`greeting: "callback"`）。过了响铃时限 30 秒内接起来的照样算（手机开页面、连房间要时间）。
6. **「正在通话不打」并进「开着聊天不打」**：锁屏 = 这台停听、通话还在，名单非空不等于人在通话里；人真在通话里时他必然连着这条会话。对应地，**手机切后台主动断开会话房**：iOS 挂起的 socket 在服务端看来还连着（中继自己应答心跳，runtime 看不见），不断开的话挂了电话锁屏之后回电永远打不出去。

## 代价

- 锁屏时是一条会响的通知，不是整屏来电：接听要点通知、解锁、再点一次「接听」。
- 挂断 = 未接，不单独记「拒接」。
- 只有手机响；桌面这一版不画回电（等 #1403 的微信式布局）。
- 桌面开着这条聊天时手机不响：「开着」以连接为准，人不在电脑前也算。
- reason 会显示在锁屏上；要藏预览走 iOS 自己的「显示预览」。
- 前台接听后铃声停不停、`dismissNotificationAsync` 能不能掐掉正在响的通知声，要真机验。
- 切后台就断开会话房：切出去再回来要重连一次（原来 iOS 迟早也会掐，只是时机不定）。
- 部署多一个手工步骤：在 Apple Developer 建 APNs 密钥、把 .p8 放到 VPS（`docs/runtime-vps.md` 1.1）。

## 推翻前提

- time-sensitive 通知在真机上被专注模式挡掉，或者铃声只响一声：退一步，通知只负责叫醒 App，响铃交给 App 内来电页。
- 维护者改主意要整屏来电：那就是 CallKit + PushKit，推翻决定 1 与 ADR-0320 的「锁屏就停听」。
```

- [ ] **Step 2: 索引**

`AGENTS.md` 的「Where to find things」列表末尾加一条：

```markdown
- `src/shared/callRing.ts` / `services/runtime/src/callRinger.ts` / `callUserTool.ts` / `apns.ts` / `pushDevices.ts` / `supabase/migrations/0045_push_devices.sql` / `mobile/src/push/` / `mobile/src/call/` — **智能体回电**（ADR-0331，#1411）：智能体调 `call_user`，叫起这一轮的那个人的手机响——锁屏是一条带 30 秒铃声（`mobile/assets/sounds/ringtone.caf`，`scripts/make-ringtone.mjs` 合成）的时效性通知，App 开着直接弹全屏来电页。一次响铃是日志里的 `call_ring`（ringing → answered / missed，字段叫 `fromAgentId` 不叫 `agentId`：一通电话不是那只的一轮），投影 `callRing.ts` runtime 与手机共用。硬限制在 runtime：开着这条聊天不打（**正在通话不单列**：锁屏 = 停听、通话还在，名单非空不等于人在通话里）、同一对 10 分钟一次（从日志算）、没设备不打；推送关着（没配 `APNS_*`）时刀不出现、通话块不提回电（`voice_call_changed.callback`）。**接听不另造帧**：`setVoiceCall` 认出「发帧的人把正在给他响铃的那只带进名单」就记接通、开场白换成回电版（`greeting: "callback"`），有 30 秒宽限。**手机切后台主动断开会话房**（`wsTransport.pause`）：不断的话挂起的 socket 在服务端看来还连着，回电永远不打。推送按令牌记下的环境发、没记过先生产再沙盒。部署：先跑 0045、在 Apple Developer 建 APNs 密钥放到 VPS（`docs/runtime-vps.md` 1.1）、再部署 runtime、再打手机包；真机才收得到推送
```

- [ ] **Step 3: spec 回写**

`docs/superpowers/specs/2026-09-28-agent-callback-design.md`：
- §1.1 `register_push_device` 那一条的「（`apns_env` 置空）」改成「（新插入的行 `apns_env` 为空；同一个人重复登记不清它——同一个令牌的环境不会变）」。
- §1.3 载荷的 `ring` 里加上 `"agentName": "…", "reason": "…"`，并补一句「名字与那句话也带上：来电页要画，而 App 刚被点醒时手上未必有那个团队的快照」。
- §2.2 第 2 条改成「~~这条会话正在通话~~ 并进第 1 条（计划阶段的补全，见 §9）」，第 3 条「按会话在内存里记，重启清零」改成「从日志折叠，重启不清零」。
- §2.3「接听」那一段末尾加「过了响铃时限 30 秒内接起来的照样算（`RING_ANSWER_GRACE_MS`）；它本来就在一场没人挂断的通话里时，名单没变也认接听」；回电开场白改成带「运维：」点名的那一版。
- §2.4 末尾加「只在推送开着时说：`voice_call_changed` 带 `callback: true` 才说」。
- §4 `agentView.OTHER_AGENT_VERDICTS（drop）` 改成 `（keep：没有 agentId，那张表轮不到它）`。
- §8 加一条「切后台就断开会话房：切出去再回来要重连一次」。
- 文末加 `## 9. 计划阶段的补全（2026-09-28）`，把实施计划开头「计划阶段对 spec 的补全」那 11 条原样抄过来。

- [ ] **Step 4: 跑文档断言**

Run: `npx vitest run tests/docs`
Expected: PASS（ADR 编号唯一、不跳号）

- [ ] **Step 5: 提交**

```bash
git add "docs/adr/0331-智能体回电走runtime直发APNs-通知加App内来电页.md" AGENTS.md docs/superpowers/specs/2026-09-28-agent-callback-design.md
git commit -m "docs: 回电的 ADR-0331、索引与 spec 回写（#1411）" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12（controller，不派子 agent）：门禁、PR、部署、真机

- [ ] **Step 1:** 全量门禁：`npm test > gate.log 2>&1; echo "GATE_EXIT=$?" >> gate.log`，以 `GATE_EXIT=0` 为准。
- [ ] **Step 2:** push，开 PR（正文：做了什么、计划阶段对 spec 的 11 条补全、部署顺序、真机验收清单，关联 #1411），`ccd_pr get_status` / `bind_pr` 看 CI。
- [ ] **Step 3:** 合并前 re-fetch：ADR 号（#1403 可能先占 0331）与 migration 号（0045）撞了就改成 max+1，加 `原为 …` 一行、改所有引用。
- [ ] **Step 4（要维护者点头）：** 生产库跑 0045（`run_migration.py`，跑前 `--dry`），跑后核对：表存在、RLS 开、只有一条 select 策略、两个函数是 security definer、`authenticated` 有 execute。
- [ ] **Step 5（要维护者动手）：** Apple Developer → Keys → + 勾 APNs，下载 .p8、给出 Key ID。把 .p8 放到 VPS 的 `/etc/otto-runtime/apns.p8`、三个变量写进 `/etc/otto-runtime.env`（`docs/runtime-vps.md` 1.1，涉及生产机要维护者点头）。
- [ ] **Step 6:** 部署 runtime，`npm run deploy:check` 核指纹，journal 里看到「推送开着」。
- [ ] **Step 7:** 打手机包装到真机（App ID 要带 Push Notifications 与 Time Sensitive Notifications，Xcode 自动签名会补）。
- [ ] **Step 8（真机）：** 登录后弹通知权限 → 允许；`push_devices` 里出现这台的令牌。私聊里说「部署一下，办完打给我」→ 锁屏 → 手机响、通知写「运维 来电」→ 点开 → 来电页 → 接听 → 进通话、它先开口说清为什么打。再验：45 秒不接 → 聊天里那张卡写「未接」；App 开着时来电直接弹来电页；前台接听后铃声停不停（spec §8 那条待验）。
