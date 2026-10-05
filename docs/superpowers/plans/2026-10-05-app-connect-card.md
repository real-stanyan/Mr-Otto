# 应用连接卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 云端智能体要用一个还没连上的连接器目录应用时，会话里出一张「连接卡」，主人正看着就自动弹居中弹窗，点进现有的接入 / 重新登录流程；连上或忽略后起一轮让智能体接着说（#1666）。

**Architecture:** 新事件 `app_connect`（offered / connected / dismissed，ignorable，形状照 `friend_pick`）+ 纯逻辑模块 `src/shared/appConnect.ts`（目录解析、折叠与状态、手机侧按钮判断、文案）。runtime 加工具 `request_app_connect`、连接器 409 `needs_login` 兜底发卡、上行帧 `app_connect`（协议 29 → 30）。手机端加 `app_connect` 行、`AppConnectCard`、自动弹窗，复用 `ConnectAppDialog` 与 `lendToTeam`。

**Tech Stack:** TypeScript strict（`exactOptionalPropertyTypes: true`）、vitest、React Native（Expo）、services/runtime（Node）。

**Spec:** `docs/superpowers/specs/2026-10-05-app-connect-card-design.md`

## Global Constraints

- 事件类型名 `app_connect`；字段 `connectId` / `phase: "offered" | "connected" | "dismissed"` / `fromAgentId` / offered 才有 `catalogId` `appName` `why` `reason: "missing" | "needs_login"`；`ignorable: true`。
- 新 greeting 值两个：`"app_connected"`、`"app_declined"`（都算主人亲口，同 `collab_accept`）。
- 工具名 `request_app_connect`，参数 `{ app: string; why: string }`。
- 常量：`APP_CONNECT_TTL_MS = 24 * 60 * 60_000`、`APP_CONNECT_PER_HOUR_MAX = 3`、`APP_CONNECT_WHY_MAX = 120`。
- 帧：上行 `{ t: "app_connect"; connectId: string; outcome: "connected" | "dismissed" }`，下行 `{ t: "app_connect_result"; connectId: string; ok: boolean; message?: string }`；`CS_PROTOCOL_VERSION` 29 → 30（合并前 re-fetch，别人先进位就 +1 并改注释）。
- 工具只在：主场（`opts.approveAll`）、非外联、非私密车道（`!isPair`）、非受监督轮、L0 或 L1、`connectorsAllowed(me, turnRoster)` 为真。
- 改连接卡状态 / 发卡只认会话主人（`byUid === opts.ownerUid`）。
- 代码注释、测试标题中文，引 `#1666`。commit 尾行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 门禁 `npm test`（root tsc + mobile tsc + vitest）。

---

### Task 1: 事件与共享逻辑（`app_connect` 事件 + `src/shared/appConnect.ts`）

**Files:**
- Modify: `src/session/events.ts`（新 interface、`SessionEvent` 联合、`KNOWN_EVENT_TYPES_MAP`、greeting 联合尾巴）
- Modify: `src/session/persistencePolicy.ts`、`src/session/agentView.ts`、`src/session/deriveMessages.ts`、`src/shared/contextEstimate.ts`、`src/shared/cloudTimeline.ts`、`src/shared/sessionPackage.ts`、`src/shared/taskSync.ts`、`src/renderer/src/components/Timeline.tsx`（每处照 `friend_pick` 那一行加 `app_connect`）
- Modify: `src/shared/outreach.ts`（`openingTraits.ownerSpoke` 放行两个新 greeting）
- Create: `src/shared/appConnect.ts`
- Test: `tests/shared/appConnect.test.ts`；`tests/shared/outreach.test.ts`（加一条 ownerSpoke 用例）

**Interfaces:**
- Produces（后面所有任务用）：

```ts
// src/session/events.ts
export interface AppConnectEvent extends SessionEventBase {
  type: "app_connect";
  connectId: string;
  phase: "offered" | "connected" | "dismissed";
  fromAgentId: string;
  catalogId?: string;
  appName?: string;
  why?: string;
  reason?: "missing" | "needs_login";
  ignorable: true;
}

// src/shared/appConnect.ts
export const REQUEST_APP_CONNECT_TOOL_NAME = "request_app_connect";
export const APP_CONNECT_TTL_MS: number;          // 24h
export const APP_CONNECT_PER_HOUR_MAX = 3;
export const APP_CONNECT_WHY_MAX = 120;
export type ResolvedApp = { kind: "ok"; entry: CuratedEntry } | { kind: "blocked"; entry: CuratedEntry; reason: string } | { kind: "unknown" };
export function resolveConnectApp(app: string): ResolvedApp;
export function cloudServerIdOf(catalogId: string): string;          // "cloud-<id>"
export function catalogIdOfServer(serverId: string): string | null;  // 反过来；不是 cloud- 前缀回 null
export interface AppConnectState { connectId: string; fromAgentId: string; offeredTs: number; seq: number; catalogId: string; appName: string; why: string; reason: "missing" | "needs_login"; phase: AppConnectEvent["phase"]; superseded: boolean }
export type AppConnectFold = Map<string, AppConnectState>;
export function applyAppConnect(fold: AppConnectFold, e: SessionEvent): void;
export function appConnectFoldOf(events: readonly SessionEvent[]): AppConnectFold;
export type AppConnectStatus = "open" | "connected" | "dismissed" | "expired";
export function appConnectStatus(st: AppConnectState, now: number): AppConnectStatus;
export function openCardFor(fold: AppConnectFold, catalogId: string, now: number): AppConnectState | null;
export type AppConnectAction = "connect" | "relogin" | "grant" | "ready";
export function appConnectAction(view: readonly CloudViewItem[], catalogId: string, workspaceId: string): AppConnectAction;
export function appConnectTitle(action: AppConnectAction, appName: string): string;
export const APP_CONNECT_BUTTON: Record<AppConnectAction, string>;
export function appConnectToolText(appName: string): string;
export function appConnectedOpening(appName: string): string;
export function appDeclinedOpening(appName: string): string;
```

- [ ] **Step 1: 写失败的测试** `tests/shared/appConnect.test.ts`

```ts
// 应用连接卡（#1666）：目录解析、折叠与状态、手机侧按钮判断、文案
import { describe, expect, it } from "vitest";
import {
  APP_CONNECT_BUTTON, APP_CONNECT_TTL_MS, appConnectAction, appConnectFoldOf, appConnectStatus, appConnectTitle,
  appConnectedOpening, appDeclinedOpening, catalogIdOfServer, cloudServerIdOf, openCardFor, resolveConnectApp,
} from "../../src/shared/appConnect.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { CloudViewItem } from "../../src/shared/remote/pxCloud.js";

let seq = 0;
const ev = (o: Record<string, unknown>): SessionEvent =>
  ({ seq: seq++, sessionId: "s1", ts: 1000, type: "app_connect", fromAgentId: "admin", ignorable: true, ...o }) as unknown as SessionEvent;
const offered = (connectId: string, catalogId: string, ts = 1000) =>
  ev({ connectId, phase: "offered", catalogId, appName: catalogId === "supabase" ? "Supabase" : catalogId, why: "查表", reason: "missing", ts });

describe("resolveConnectApp", () => {
  it("目录 id 精确命中；名字不分大小写命中", () => {
    expect(resolveConnectApp("supabase")).toMatchObject({ kind: "ok", entry: { id: "supabase" } });
    expect(resolveConnectApp("  SupaBase ")).toMatchObject({ kind: "ok", entry: { id: "supabase" } });
  });
  it("手机接不了的（实测回调被拒）回 blocked 带原因；目录外 / 本机工具回 unknown", () => {
    expect(resolveConnectApp("vercel")).toMatchObject({ kind: "blocked", entry: { id: "vercel" } });
    expect(resolveConnectApp("不存在的应用")).toEqual({ kind: "unknown" });
  });
});

describe("serverId ↔ catalogId", () => {
  it("cloud- 前缀互转；别的形状回 null", () => {
    expect(cloudServerIdOf("supabase")).toBe("cloud-supabase");
    expect(catalogIdOfServer("cloud-supabase")).toBe("supabase");
    expect(catalogIdOfServer("github")).toBeNull();
    expect(catalogIdOfServer("cloud-")).toBeNull();
  });
});

describe("折叠与状态", () => {
  it("offered → open；connected / dismissed 落了就是结局", () => {
    seq = 0;
    const f = appConnectFoldOf([offered("c1", "supabase"), offered("c2", "github"), ev({ connectId: "c2", phase: "dismissed" })]);
    expect(appConnectStatus(f.get("c1")!, 1000)).toBe("open");
    expect(appConnectStatus(f.get("c2")!, 1000)).toBe("dismissed");
    expect(f.get("c1")).toMatchObject({ catalogId: "supabase", appName: "Supabase", why: "查表", reason: "missing" });
  });
  it("24 小时没动算过期；同一应用来了新卡，旧卡算过期；别的应用的卡不顶", () => {
    seq = 0;
    const f = appConnectFoldOf([offered("c1", "supabase"), offered("c2", "github"), offered("c3", "supabase")]);
    expect(appConnectStatus(f.get("c1")!, 1000)).toBe("expired");
    expect(appConnectStatus(f.get("c2")!, 1000)).toBe("open");
    expect(appConnectStatus(f.get("c3")!, 1000 + APP_CONNECT_TTL_MS + 1)).toBe("expired");
  });
  it("openCardFor：同一应用此刻开着的那张；没有回 null", () => {
    seq = 0;
    const f = appConnectFoldOf([offered("c1", "supabase")]);
    expect(openCardFor(f, "supabase", 1000)?.connectId).toBe("c1");
    expect(openCardFor(f, "github", 1000)).toBeNull();
    expect(openCardFor(f, "supabase", 1000 + APP_CONNECT_TTL_MS + 1)).toBeNull();
  });
  it("结局事件找不到开头（窗口裁掉）就忽略", () => {
    seq = 0;
    expect(appConnectFoldOf([ev({ connectId: "x", phase: "connected" })]).size).toBe(0);
  });
});

describe("appConnectAction（手机判断该给哪个按钮）", () => {
  const item = (o: Partial<CloudViewItem>): CloudViewItem =>
    ({ serverId: "cloud-supabase", catalogId: "supabase", status: "ok", tools: [], grants: ["home1"], connectedTs: 0, ...o });
  it("四种情况", () => {
    expect(appConnectAction([], "supabase", "home1")).toBe("connect");
    expect(appConnectAction([item({ status: "needs_login" })], "supabase", "home1")).toBe("relogin");
    expect(appConnectAction([item({ grants: [] })], "supabase", "home1")).toBe("grant");
    expect(appConnectAction([item({})], "supabase", "home1")).toBe("ready");
  });
  it("标题与按钮字", () => {
    expect(appConnectTitle("connect", "Supabase")).toBe("要连上 Supabase 才能办");
    expect(appConnectTitle("relogin", "Supabase")).toBe("Supabase 的登录过期了");
    expect(appConnectTitle("grant", "Supabase")).toBe("Supabase 还没开给这里");
    expect(appConnectTitle("ready", "Supabase")).toBe("Supabase 已经连好了");
    expect(APP_CONNECT_BUTTON).toEqual({ connect: "去连接", relogin: "重新登录", grant: "打开", ready: "好了，接着办" });
  });
});

describe("开场白", () => {
  it("连上 / 没连各一句，点名应用", () => {
    expect(appConnectedOpening("Supabase")).toContain("连上了 Supabase");
    expect(appDeclinedOpening("Supabase")).toContain("没连 Supabase");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run tests/shared/appConnect.test.ts`，预期 FAIL（模块不存在）。

- [ ] **Step 3: events.ts**。在 `FriendPickEvent` 之后加 `AppConnectEvent`（上面的形状，注释写清：offered 开头、之后至多一条 connected / dismissed；过期与被顶掉读的时候算；叫 `fromAgentId`；模型不可见，出卡由工具结果告诉它、结局由 `app_connected` / `app_declined` 开场白告诉它）。加进 `SessionEvent` 联合（`| AppConnectEvent` 紧跟 `| FriendPickEvent`）、`KNOWN_EVENT_TYPES_MAP`（`app_connect: true`）。greeting 联合尾巴追加 `| "app_connected" | "app_declined"`，联合上方的注释加一句：连接卡结局（#1666），算主人亲口（只有主人点得出来）。

- [ ] **Step 4: 八处登记**，每处紧挨 `friend_pick` 那一行，注释写「连接卡（#1666）」：
  - `persistencePolicy.ts`：`case "app_connect":`（必须落：卡开没开从日志折）
  - `agentView.ts`：`app_connect: "keep",`
  - `deriveMessages.ts`：`case "app_connect":`（不进模型：出卡由工具结果说，结局由开场白说）
  - `contextEstimate.ts`：`case "app_connect":`
  - `cloudTimeline.ts` 的 `hiddenFromCloudTimeline`：`e.type === "app_connect" ||`（手机画，桌面不画）
  - `sessionPackage.ts`：`app_connect: "strip",`
  - `taskSync.ts`：`app_connect: "executor",`
  - `src/renderer/src/components/Timeline.tsx`：`case "app_connect": return null;`

- [ ] **Step 5: openingTraits**（`src/shared/outreach.ts:161`）：`ownerSpoke` 的放行列表加 `o.greeting === "app_connected" || o.greeting === "app_declined"`，注释「连接卡结局（#1666）同 collab_accept：只有主人点得出来」。在 `tests/shared/outreach.test.ts` 的 openingTraits 段加一条：主人 fromUid + `greeting: "app_connected"` → `ownerSpoke: true`、`report: false`。

- [ ] **Step 6: 写 `src/shared/appConnect.ts`**：

```ts
// 应用连接卡（#1666，spec 2026-10-05-app-connect-card-design）：智能体要用一个还没连上的连接器目录应用时，
// 会话里出一张卡。纯逻辑零 IO，runtime 与手机共用——「这张卡此刻还开着吗」「手机该给哪个按钮」只能各有一处判据
// （同 friendPick.ts 的纪律）。runtime 读不到主人的云箱（edge 对平台身份回 403），所以按钮由手机按自己的视图判
import type { AppConnectEvent, SessionEvent } from "../session/events.js";
import { MCP_CATALOG, type CuratedEntry } from "./mcpCatalog.js";
import { MOBILE_OAUTH_BLOCKED } from "./mobileConnectors.js";
import type { CloudViewItem } from "./remote/pxCloud.js";

export const REQUEST_APP_CONNECT_TOOL_NAME = "request_app_connect";
export const APP_CONNECT_TTL_MS = 24 * 60 * 60_000;
export const APP_CONNECT_PER_HOUR_MAX = 3;
export const APP_CONNECT_WHY_MAX = 120;

export type ResolvedApp = { kind: "ok"; entry: CuratedEntry } | { kind: "blocked"; entry: CuratedEntry; reason: string } | { kind: "unknown" };

/** 手机上接得了的那份目录（同 mobileConnectors.connectCatalog 的头两道筛：http、不是本机工具）。预览期条目不筛：
    发卡时不知道主人是不是内测账号，接不上由接入弹窗当场说 */
const phoneCatalog = (): CuratedEntry[] => MCP_CATALOG.filter((e) => e.transport === "http" && e.category !== "本机工具");

export function resolveConnectApp(app: string): ResolvedApp {
  const q = app.trim().toLowerCase();
  if (q === "") return { kind: "unknown" };
  const list = phoneCatalog();
  const entry = list.find((e) => e.id === q) ?? list.find((e) => e.name.toLowerCase() === q);
  if (entry === undefined) return { kind: "unknown" };
  const reason = entry.blocked ?? MOBILE_OAUTH_BLOCKED[entry.id];
  return reason !== undefined ? { kind: "blocked", entry, reason } : { kind: "ok", entry };
}

const CLOUD_PREFIX = "cloud-";
export const cloudServerIdOf = (catalogId: string): string => `${CLOUD_PREFIX}${catalogId}`;
export function catalogIdOfServer(serverId: string): string | null {
  return serverId.startsWith(CLOUD_PREFIX) && serverId.length > CLOUD_PREFIX.length ? serverId.slice(CLOUD_PREFIX.length) : null;
}

export interface AppConnectState {
  connectId: string; fromAgentId: string; offeredTs: number; seq: number;
  catalogId: string; appName: string; why: string; reason: "missing" | "needs_login";
  phase: AppConnectEvent["phase"];
  /** 之后同一会话里同一个应用又出了一张卡（这张还开着时被顶掉） */
  superseded: boolean;
}
export type AppConnectFold = Map<string, AppConnectState>;

export function applyAppConnect(fold: AppConnectFold, e: SessionEvent): void {
  if (e.type !== "app_connect") return;
  if (e.phase === "offered") {
    const catalogId = e.catalogId ?? "";
    for (const s of fold.values()) if (s.phase === "offered" && s.catalogId === catalogId) s.superseded = true;
    fold.set(e.connectId, {
      connectId: e.connectId, fromAgentId: e.fromAgentId, offeredTs: e.ts, seq: e.seq,
      catalogId, appName: e.appName ?? catalogId, why: e.why ?? "", reason: e.reason ?? "missing",
      phase: "offered", superseded: false,
    });
    return;
  }
  const prev = fold.get(e.connectId);
  if (prev === undefined) return; // 窗口裁掉了开头
  fold.set(e.connectId, { ...prev, phase: e.phase });
}
export function appConnectFoldOf(events: readonly SessionEvent[]): AppConnectFold {
  const fold: AppConnectFold = new Map();
  for (const e of events) applyAppConnect(fold, e);
  return fold;
}

export type AppConnectStatus = "open" | "connected" | "dismissed" | "expired";
export function appConnectStatus(st: AppConnectState, now: number): AppConnectStatus {
  if (st.phase !== "offered") return st.phase;
  return st.superseded || now - st.offeredTs > APP_CONNECT_TTL_MS ? "expired" : "open";
}
export function openCardFor(fold: AppConnectFold, catalogId: string, now: number): AppConnectState | null {
  for (const s of fold.values()) if (s.catalogId === catalogId && appConnectStatus(s, now) === "open") return s;
  return null;
}

export type AppConnectAction = "connect" | "relogin" | "grant" | "ready";
/** 手机按自己的云端视图判（spec §4.1）：没有 = 新接；needs_login = 重新登录；正常但没开给这个工作区 = 打开；都好 = 直接接着办 */
export function appConnectAction(view: readonly CloudViewItem[], catalogId: string, workspaceId: string): AppConnectAction {
  const item = view.find((v) => v.catalogId === catalogId);
  if (item === undefined) return "connect";
  if (item.status === "needs_login") return "relogin";
  return item.grants.includes(workspaceId) ? "ready" : "grant";
}
export function appConnectTitle(action: AppConnectAction, appName: string): string {
  switch (action) {
    case "connect": return `要连上 ${appName} 才能办`;
    case "relogin": return `${appName} 的登录过期了`;
    case "grant": return `${appName} 还没开给这里`;
    case "ready": return `${appName} 已经连好了`;
  }
}
export const APP_CONNECT_BUTTON: Record<AppConnectAction, string> = { connect: "去连接", relogin: "重新登录", grant: "打开", ready: "好了，接着办" };

/** 工具结果：卡已经出了，用一句话告诉主人（这句走现有回复推送），这一轮别再试那个应用 */
export function appConnectToolText(appName: string): string {
  return `已经在会话里给主人发了一张连接 ${appName} 的卡。用一句话告诉他要连 ${appName}、为什么，然后这一轮就停下，别再试 ${appName}。他连上或者不连，都会有一条消息回到这里，你到时候再接着办。`;
}
export function appConnectedOpening(appName: string): string {
  return `（系统）主人刚连上了 ${appName}，它的工具现在能用了。接着办刚才要用它的那件事。`;
}
export function appDeclinedOpening(appName: string): string {
  return `（系统）主人没连 ${appName}。别再提这件事，看看不用它能不能办；办不了就简单说一句办不了。`;
}
```

  注意：`MOBILE_OAUTH_BLOCKED` 从 `mobileConnectors.ts` 导入；那个文件 import `mcpCatalog` 等，确认不会形成运行时循环（`mobileConnectors` 不 import `appConnect`，没有循环）。`CuratedEntry` 是否有 `blocked` 字段以 `mcpCatalog.ts` 实际定义为准（`connectCatalog` 里用了 `e.blocked`，应该有）。

- [ ] **Step 7: 跑测试**：`npx vitest run tests/shared/appConnect.test.ts tests/shared/outreach.test.ts`，预期 PASS；`npx tsc --noEmit` 干净（`switch` 穷尽检查会逼出漏登记的地方——每一处 `Record<SessionEvent["type"], …>` 都要加）。再跑邻居 `npx vitest run tests/shared tests/session tests/runtime tests/renderer`。

- [ ] **Step 8: Commit** `feat(shared): 连接卡事件 app_connect + appConnect 纯逻辑（#1666）`

---

### Task 2: 协议帧 `app_connect` / `app_connect_result`（协议 30）+ 客户端方法

**Files:**
- Modify: `src/shared/remote/cloudSession.ts`（版本常量 + 头注一段、`CsUp`、`CsDown`、两个解析器）
- Modify: `src/shared/remote/cloudSessionClient.ts`（接口方法 `answerAppConnect`、`pendingConnect` 表、下行分派、`settleConnect`）
- Test: `tests/shared/cloudSessionFrames.test.ts`、`tests/shared/remote/cloudSessionClient.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `CsUp` 成员 `{ t: "app_connect"; connectId: string; outcome: "connected" | "dismissed" }`；`CsDown` 成员 `{ t: "app_connect_result"; connectId: string; ok: boolean; message?: string }`；客户端 `answerAppConnect(connectId: string, outcome: "connected" | "dismissed"): Promise<CloudAck>`。

- [ ] **Step 1: 写失败的测试**。照 `pick_friend` 在 `cloudSessionFrames.test.ts` 里的用例抄：上行 `app_connect` 合法往返；`outcome` 不是两值之一 → null；`connectId` 非字符串 → null。下行 `app_connect_result` 带 / 不带 message 往返；`ok` 非布尔 → null。`CS_PROTOCOL_VERSION` 断言（若文件里有）改成 30。客户端测试照 `pickFriend` 的用例抄：发出帧形状对；回执 ok 解析成 `{ok:true}`；同一 connectId 回执没到再按 → `{ok:false, message:"这张卡的回执还没到，稍等"}`；超时走 `ACK_TIMEOUT_MESSAGE`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。版本 `29 → 30`，头注最上面加一段：`30（#1666）：连接卡。CsUp 加 app_connect（主人在卡上点了「连上了 / 不用了」），CsDown 加 app_connect_result（带 connectId）。加帧照样进位（握手精确相等）：老 runtime 会把 app_connect 当未知帧丢掉，卡一直转圈。` 解析器照 `pick_friend` / `pick_friend_result` 写。客户端照 `pickFriend` 整套抄（`pendingConnect: Map<string, CsPending>`、`settleConnect`、断线清表的地方也要清它——grep `pendingPick` 的每一处照加）。
- [ ] **Step 4: 跑测试 PASS + `npx tsc --noEmit`**；邻居 `npx vitest run tests/shared tests/runtime`。
- [ ] **Step 5: Commit** `feat(protocol): 连接卡帧 app_connect（协议 30，#1666）`

---

### Task 3: runtime 工具 `request_app_connect` + 发卡落盘

**Files:**
- Create: `services/runtime/src/requestAppConnectTool.ts`
- Modify: `services/runtime/src/sessionService.ts`（`appConnectFold` 种子与 `notify` 里 apply、`logAppConnect`、工具装配与挂载条件、每小时窗口）
- Test: `tests/runtime/requestAppConnectTool.test.ts`、`tests/runtime/sessionService.appConnect.test.ts`（新；夹具照 `tests/runtime/sessionService.friendRelay.test.ts` 的 `openWith` 抄）

**Interfaces:**
- Consumes: Task 1 的 `resolveConnectApp`、`cloudServerIdOf`、`openCardFor`、`appConnectToolText`、常量。
- Produces: `createRequestAppConnectTool(deps: RequestAppConnectDeps): Tool`，

```ts
export interface RequestAppConnectDeps {
  /** 发卡；回给模型的那句话。参数已校验、目录已解析 */
  offer: (o: { catalogId: string; appName: string; why: string }) => string;
}
```

  sessionService 内部：`logAppConnect(e: Omit<AppConnectEvent, "type" | "seq" | "sessionId" | "ts" | "ignorable">): void`（归档后空操作，同 `logFriendPickEvent`）；`offerAppConnect({ agentId, catalogId, appName, why, reason }): string`（Task 4 的 409 兜底也调它）。

- [ ] **Step 1: 工具的失败测试** `tests/runtime/requestAppConnectTool.test.ts`（照 `relayToOwnerTool.test.ts`）：名字 = `REQUEST_APP_CONNECT_TOOL_NAME`、`required: ["app","why"]`、`exposure: "direct"`、`requiresApproval: false`；描述里含「目录」和「这一轮就停下」；`app` 是目录外 → 抛 `目录里没有「X」`；`app` 是 blocked（`vercel`）→ 抛错并带上原因；`why` 空 → 抛「不能是空的」；`why` 超过 `APP_CONNECT_WHY_MAX` → 截到上限加「…」再交给 offer（不抛）；正常 → `offer` 收到 `{catalogId:"supabase", appName:"Supabase", why}`，回 offer 的那句。
- [ ] **Step 2: 跑确认失败**。
- [ ] **Step 3: 实现工具**：

```ts
// request_app_connect —— 智能体要用一个还没连上的连接器目录应用时，请主人连（#1666）。只管参数与目录解析；
// 发不发卡（已经能用 / 已有开着的卡 / 每小时上限）与落盘在 sessionService 的 offer。只在自己会话里画一张卡、
// 真正的授权在主人手里：不过审批门（同 ADR-0358 的论证）
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { APP_CONNECT_WHY_MAX, REQUEST_APP_CONNECT_TOOL_NAME, resolveConnectApp } from "../../../src/shared/appConnect.js";

export interface RequestAppConnectDeps {
  offer: (o: { catalogId: string; appName: string; why: string }) => string;
}

export function createRequestAppConnectTool(deps: RequestAppConnectDeps): Tool {
  return {
    def: {
      name: REQUEST_APP_CONNECT_TOOL_NAME,
      description:
        "请主人连上一个应用（连接器目录里的，比如 Supabase、GitHub、Notion、飞书）：会话里会出一张卡，主人点一下就去连 / 重新登录。" +
        "用在你要办的事必须用某个应用、而你手上没有它的工具的时候。调了之后用一句话告诉主人要连什么、为什么，然后这一轮就停下；" +
        "他连上或者不连，都会有一条消息回到这里。",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "应用名或目录 id，如 supabase / GitHub" },
          why: { type: "string", description: `为什么要连（${APP_CONNECT_WHY_MAX} 字以内，写给主人看）：要用它办什么` },
        },
        required: ["app", "why"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld): Promise<string> {
      const a = (args ?? {}) as Record<string, unknown>;
      const app = typeof a.app === "string" ? a.app : "";
      const rawWhy = typeof a.why === "string" ? a.why.replace(/\s+/gu, " ").trim() : "";
      if (rawWhy === "") throw new Error("request_app_connect: why 不能是空的");
      const why = [...rawWhy].length > APP_CONNECT_WHY_MAX ? `${[...rawWhy].slice(0, APP_CONNECT_WHY_MAX).join("")}…` : rawWhy;
      const r = resolveConnectApp(app);
      if (r.kind === "unknown") throw new Error(`request_app_connect: 目录里没有「${app.trim()}」，手机上连不了。让主人去电脑上的 Mr Otto 里接`);
      if (r.kind === "blocked") throw new Error(`request_app_connect: ${r.entry.name} ${r.reason}`);
      return deps.offer({ catalogId: r.entry.id, appName: r.entry.name, why });
    },
  };
}
```

- [ ] **Step 4: sessionService 接线**：
  - import `appConnectFoldOf, applyAppConnect, openCardFor, appConnectToolText, cloudServerIdOf, APP_CONNECT_PER_HOUR_MAX, type AppConnectFold`。
  - 照 `friendPickFold`（`:909` 种子、`:1402` apply）加 `appConnectFold`。
  - `logAppConnect`：照 `logFriendPickEvent`（`:3328`），`type: "app_connect"`、`ignorable: true`。`CloudSession` 接口不用加它（只在内部用）。
  - `let appConnectOffered: number[] = [];`（照 `outreachChatSent` 的滑动一小时窗口，用 `pruneBridgeWindow`）。
  - `offerAppConnect({ agentId, catalogId, appName, why, reason })`：
    1. 当前快照 `grantsSnapshot?.value` 里有 `serverId === cloudServerIdOf(catalogId)` → 回 `${appName} 已经连上了，直接用它的工具。`（不发卡）。
    2. `openCardFor(appConnectFold, catalogId, now)` 非 null → 回 `连 ${appName} 的卡已经在会话里了，等主人点。这一轮别再试它。`
    3. 窗口满 `APP_CONNECT_PER_HOUR_MAX` → 回 `这个小时已经发了 ${APP_CONNECT_PER_HOUR_MAX} 张连接卡了。直接用文字告诉主人要连什么，让他去「我 → 应用」里连。`
    4. 否则 `logAppConnect({ connectId: d.newId 同款（grep friend_pick 出卡处的 id 生成，用 randomUUID 即可）, phase: "offered", fromAgentId: agentId, catalogId, appName, why, reason })`，记窗口，回 `appConnectToolText(appName)`。
  - 工具装配（`replyToFriendTool` 下面）：`const appConnectTool = !opts.approveAll || isOutreach || isPair ? null : createRequestAppConnectTool({ offer: (o) => offerAppConnect({ agentId: spec.agentId, ...o, reason: "missing" }) });`
  - `tools()` 的 `list` 里（`...px` 前）：`...(appConnectTool !== null && !supervisedTurn() && (me === null || tierOf(me) <= 1) && (me === null || connectorsAllowed(me, turnRoster)) ? [appConnectTool] : []),`
  - 确认这把刀**不被**下面「客人轮掀审批」的包装改成要批：它在受监督轮里本来就不挂，所以无需例外；若包装按名字白名单处理（grep `RELAY_TO_OWNER_TOOL_NAME` 在 tools() 后半段的用法），照 message_friend_agent 的方式处理。
- [ ] **Step 5: sessionService 的失败测试**（`sessionService.appConnect.test.ts`），用脚本化 adapter 让管理员调一次 `request_app_connect`：
  - 主场私聊、主人亲口：日志里落一条 `app_connect` offered（catalogId supabase、appName Supabase、why、reason missing、fromAgentId、ignorable），tool_result 等于 `appConnectToolText("Supabase")`。
  - 已有开着的卡再调：不落第二条，tool_result 含「已经在会话里了」。
  - 连调 4 次不同应用（supabase/github/notion/linear）：只落 3 条，第 4 次 tool_result 含「这个小时已经发了 3 张」。
  - 外联会话 / 团队会话（`approveAll: false`）/ 受监督轮：工具不在工具表里（断言 adapter 收到的 tools 名字里没有 `request_app_connect`）。
  - grants 快照里已有 `cloud-supabase`：不发卡，tool_result 含「已经连上了」（夹具的 `px` / `fetchImpl` 怎么喂 grants 照现有 px 相关测试，grep `px:` in tests/runtime）。
- [ ] **Step 6: 跑 PASS + tsc + 邻居 `npx vitest run tests/shared tests/session tests/runtime`**。
- [ ] **Step 7: Commit** `feat(runtime): request_app_connect 发连接卡（#1666）`

---

### Task 4: 连接器 409 `needs_login` 兜底自动发卡

**Files:**
- Modify: `services/runtime/src/pxTools.ts`（`buildPxTools` 的 opts 加 `onNeedsLogin`）
- Modify: `services/runtime/src/sessionService.ts`（`buildPxTools(...)` 调用处 `:3087` 传回调）
- Test: `tests/runtime/pxTools.test.ts`（现有文件，grep 一下名字）、`tests/runtime/sessionService.appConnect.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `offerAppConnect`、Task 1 的 `catalogIdOfServer`、`resolveConnectApp`。
- Produces: `buildPxTools(deps, fromUid, granted, opts?: { requiresApproval?: boolean; onNeedsLogin?: (g: { hostUid: string; serverId: string }) => string | null })`。回调回非 null = 用这句替掉错误文本抛出。

- [ ] **Step 1: 失败测试**（pxTools）：`fetchImpl` 对 `/px/v1/call` 回 409 `{error:{message:"这个应用要在手机上重新登录",code:"needs_login"}}`：有 `onNeedsLogin` 且回 `"X"` → `run` 抛 `X`，回调收到 `{hostUid, serverId}`；回调回 null → 抛原 message；别的 code（如 403 `forbidden`）→ 不调回调。
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 实现**：`if (!res.ok)` 里先判 `isObj(payload) && isObj(payload.error) && payload.error.code === "needs_login"`，是就 `const alt = opts?.onNeedsLogin?.({ hostUid: g.hostUid, serverId: g.serverId }) ?? null; if (alt !== null) throw new Error(alt);`，然后照旧抛。
- [ ] **Step 4: sessionService**：调用处传 `onNeedsLogin: ({ hostUid, serverId }) => { if (hostUid !== opts.ownerUid) return null; const catalogId = catalogIdOfServer(serverId); const r = catalogId === null ? null : resolveConnectApp(catalogId); if (r === null || r.kind !== "ok") return null; offerAppConnect({ agentId: <这一轮的 agentId，读 runJob 里 job.agentId / spec.agentId>, catalogId: r.entry.id, appName: r.entry.name, why: "它的登录过期了，要重新登录才能接着用", reason: "needs_login" }); return \`${r.entry.name} 的登录过期了，已经在会话里请主人重新登录；这一轮别再调它。\`; }`。只认主人自己云箱里的（`hostUid === opts.ownerUid`）：别人借来的应用过期了轮不到这位主人去登。只在发卡条件成立时（`opts.approveAll && !isOutreach && !isPair`）传这个回调，否则不传。
- [ ] **Step 5: sessionService 测试**：管理员调一把主人自己的 `cloud-supabase` 工具、edge 回 409 needs_login → 日志落 `app_connect` offered（reason needs_login），tool_result 含「登录过期了」；再调一次不重发卡。
- [ ] **Step 6: PASS + tsc + 邻居**。
- [ ] **Step 7: Commit** `feat(runtime): 连接器登录过期时自动发重新登录卡（#1666）`

---

### Task 5: runtime 收卡：`answerAppConnect` + 帧处理

**Files:**
- Modify: `services/runtime/src/sessionService.ts`（`CloudSession` 接口与实现 `answerAppConnect`）
- Modify: `services/runtime/src/frameHandler.ts`（`case "app_connect"`）
- Test: `tests/runtime/sessionService.appConnect.test.ts`、`tests/runtime/frameHandler.test.ts`

**Interfaces:**
- Consumes: Task 1 fold/status/开场白，Task 2 帧类型，Task 3 `logAppConnect`、`appConnectFold`。
- Produces: `CloudSession.answerAppConnect(connectId: string, byUid: string, outcome: "connected" | "dismissed"): { ok: true } | { ok: false; message: string }`（同步即可）。

- [ ] **Step 1: 失败测试**（sessionService）：
  - 非主人 → `{ok:false, message:"只有他本人能点。"}`，日志不变。
  - 卡不存在 / 不是 open（已连、已忽略、过期）→ `{ok:false, message:"这张卡已经用过或过期了。"}`。
  - `connected`：落 `app_connect` connected；紧接一条 `user_message`，`greeting: "app_connected"`、`fromUid: ownerUid`、`mentions: [fromAgentId]`、`content === appConnectedOpening(appName)`；起了一轮（脚本 adapter 被调到）；grants 快照被清（下一轮重新 fetch grants：断言 grants 的 fetch 次数 +1）。
  - `dismissed`：落 dismissed + `greeting: "app_declined"` 开场白，同样起一轮。
  - 那只已经不在名单里：仍落结局事件，但不写开场白、不起轮（照 `queuePairCallSummary` 前的名单检查方式；名单读法照 `reportOutreach`）——如果实现起来要 await 名单，`answerAppConnect` 改成 async，接口跟着改，帧处理 await。
  - 归档后 → `{ok:false, message:"这条聊天已经归档了。"}`。
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 实现**（放在 `pickFriend` 旁边）：校验顺序：archived → `isOutreach || isPair || !opts.approveAll || byUid !== opts.ownerUid` → 卡状态。先落结局事件（同步推进 fold，连点第二帧就会被拒），`connected` 时 `grantsSnapshot = null`，再照 `queuePairCallSummary` 写开场白并 `coordinator.enqueue(...) === "start_turn" && startDrain()`。
- [ ] **Step 4: frameHandler**：照 `case "pick_friend"`（`:973`）写 `case "app_connect"`：`requireStillMemberIn` → `session.answerAppConnect(msg.connectId, entry.uid, msg.outcome)` → 回 `app_connect_result`。frameHandler 测试照 pick_friend 的用例抄两条（成功回 ok、失败带 message）。
- [ ] **Step 5: PASS + tsc + 邻居**。
- [ ] **Step 6: Commit** `feat(runtime): 主人点连接卡——连上 / 不用了都起一轮接着说（#1666）`

---

### Task 6: 手机端连接卡（行 + 卡 + 点了做什么）

**Files:**
- Modify: `src/shared/mobileChat.ts`（`ChatRow` 加 `app_connect` 行；`chatRows` 里照 `friend_pick`（`:224`、`:289`）的方式出行）
- Modify: `mobile/src/chat/Bubbles.tsx`（`AppConnectCard` + `ChatRowView` 的 case + 新 props）
- Modify: `mobile/src/chat/ChatScreen.tsx`（`useConnectors`、点了之后的分流、`ConnectAppDialog` 挂载、发帧）
- Test: `tests/shared/mobileChat.test.ts`

**Interfaces:**
- Consumes: Task 1 全部，Task 2 `answerAppConnect`（客户端）。
- Produces: `ChatRow` 成员

```ts
| {
  kind: "app_connect"; key: string; ts: number; seq: number; connectId: string; agentId: string; name: string;
  catalogId: string; appName: string; why: string; status: AppConnectStatus;
  /** 我点得了吗：只有这条会话的主人 */
  canAct: boolean;
}
```

- [ ] **Step 1: 失败测试**（mobileChat）：offered 一张 → 一行 `app_connect`，key `app_connect-<id>`、seq、status open、canAct（selfUid = ownerUid 时 true，否则 false）；之后落 connected → 同一行 status connected，不多出行；过期（`now` 超 24h）→ expired。
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: mobileChat 实现**：照 friend_pick：`const connects = appConnectFoldOf(o.events)`；遇到 `e.type === "app_connect" && e.phase === "offered"` 出行（其余 phase 不出行），name 用 `agentNameOf(ws, st.fromAgentId)`（同 friend_pick 取名的写法），`canAct = ws.ownerUid === selfUid`（照 friend_pick 的 canPick 判据原样抄）。注意 `rowOf` 开头的 `hiddenFromCloudTimeline` 会挡掉它——照 friend_pick 在那之前 / 外面处理的位置放。
- [ ] **Step 4: AppConnectCard**（Bubbles.tsx，放在 `FriendPickCard` 后面）。照 demo 与 `FriendPickCard` 的骨架：左边 `AgentAvatar`，卡底色 `c.bubbleAgent`、`borderRadius: RADIUS`、`borderTopLeftRadius: 4`、`minWidth: 240`、`maxWidth: "76%"`。上半：40×40 圆角 10 的应用图标（用 `mobile/src/machine/AppTile.tsx` 的 `AppTile`，看它的 props 传 catalogId / name）+ 标题（16/22 600）+ why（14/20 muted）。下半按状态：
  - open 且 `canAct`：一条顶边线，两格按钮「不用了 | {APP_CONNECT_BUTTON[action]}」，主按钮 `c.brand` 600；按下 opacity 0.55；`busy`（本地态：这张卡发了帧回执未到）时两格都 disabled、主按钮位置放 `ActivityIndicator`。
  - open 且不能点：灰字「等 {主人名} 连」（主人名拿不到写「等主人连」）。
  - connected：绿字（`c.ok`）勾 +「已连上，接着办」。dismissed：「没连。要用再跟我说。」expired：「这张卡过期了，要用再跟我说。」
  - 标题用 `appConnectTitle(action, appName)`；action 由调用方算好传进来（卡本身不读 store）。
  - props：`{ row; ws; action: AppConnectAction; busy: boolean; ready: boolean; onPrimary: (row) => void; onDismiss: (row) => void }`。`ChatRowView` 加 `appConnectActionOf: (catalogId: string) => AppConnectAction`、`connecting: string | null`、`onAppConnect`、`onAppConnectDismiss` 四个 props，`case "app_connect"` 渲染卡。
- [ ] **Step 5: ChatScreen 接线**：
  - `const cloudApps = useConnectors();`，进页时 `refreshConnectors()` 一次（不 force）。`appConnectActionOf = (id) => appConnectAction(cloudApps.apps ?? [], id, ws.id)`（`apps` 字段名以 `ConnectorsState` 实际为准）。
  - 本地态 `connecting: string | null`（connectId）与 `connectEntry: { entry: CuratedEntry; relogin: boolean; connectId: string } | null`。
  - `onAppConnect(row)`：按 action 分流——`connect` / `relogin`：`setConnectEntry({ entry: MCP_CATALOG.find(e => e.id === row.catalogId)!, relogin: action === "relogin", connectId })`（找不到条目就 `setPageNote("目录里没有这个应用了")`）；`grant`：`lendToTeam({ serverId: item.serverId, workspaceId: ws.id, on: true, label: ws.name, uid: selfUid })`（label 字段的含义以 `lendToTeamWith` 实际为准），成功后 `refreshConnectors({force:true})` 再发帧 connected；`ready`：直接发帧 connected。
  - 发帧：`setConnecting(id)` → `await cloudClient.answerAppConnect(id, outcome)` → 失败 `setPageNote(message)` → `setConnecting(null)`。守卫同 `pickFriendOn`（`!ready || connecting !== null` 就不发）。
  - `{connectEntry !== null ? <ConnectAppDialog entry={...} relogin={...} onClose={(landed) => { const id = connectEntry.connectId; setConnectEntry(null); if (landed !== null) void answer(id, "connected"); }} /> : null}`——人取消了（landed null）卡保持开着。
  - `onAppConnectDismiss(row)` → 发帧 dismissed。
- [ ] **Step 6: PASS（mobileChat 测试）+ 根 tsc + `npx tsc --noEmit -p mobile`（以 package.json 的 test 脚本里 mobile tsc 的实际命令为准）**。
- [ ] **Step 7: Commit** `feat(mobile): 连接卡——会话里一张卡，点了去连 / 重新登录 / 打开（#1666）`

---

### Task 7: 手机端自动弹窗

**Files:**
- Create: `mobile/src/chat/AppConnectPrompt.tsx`
- Modify: `mobile/src/chat/ChatScreen.tsx`
- Create: `src/shared/appConnectPopup.ts` + Test: `tests/shared/appConnectPopup.test.ts`（「该不该弹」的纯判据）

**Interfaces:**
- Consumes: Task 6 的行、`appConnectAction`、`appConnectTitle`、`APP_CONNECT_BUTTON`，Task 6 ChatScreen 里的 `onAppConnect`。
- Produces: `popupCandidate(rows: readonly ChatRow[], o: { baselineSeq: number; popped: ReadonlySet<string>; focused: boolean }): Extract<ChatRow, { kind: "app_connect" }> | null`——最新一张满足 `seq > baselineSeq && status === "open" && canAct && !popped.has(connectId)` 的卡；`focused` 为假回 null。

- [ ] **Step 1: 失败测试**（appConnectPopup）：基线之前的卡不弹；基线之后开着、我能点、没弹过 → 弹；已弹过 / 不能点 / 不是 open / 页面不在前台 → null；两张都符合取 seq 大的。
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 实现** `popupCandidate`（文件头注释写清 spec §4.2 的「只弹一次、翻历史不弹」）。
- [ ] **Step 4: AppConnectPrompt**：`mobile/src/dialog.tsx` 的 `Dialog`（不给 `dismissible`），内容居中：`AppTile` 56、灰字发卡那只的名字、标题、why、主按钮（`Button` 主样式，字 = `APP_CONNECT_BUTTON[action]`）、次按钮「稍后」。props `{ row; action; onPrimary: () => void; onLater: () => void; onExited: () => void; visible: boolean }`。
- [ ] **Step 5: ChatScreen 接线**：
  - `baselineSeq`：会话第一次拿到事件时记下日志里最大的 seq（`useRef`，只设一次；切会话重置）。
  - `popped: useRef(new Set<string>())`；`focused = useIsFocused()`（`@react-navigation/native`）且 `AppState` 为 active（ChatScreen 里若已有前后台状态就复用）。
  - `const cand = popupCandidate(rows, {...})`；有 cand 且当前没有弹窗、没有 `connectEntry` 时：`popped.add(id)`、`setPrompt({ row: cand, visible: true })`。
  - 主按钮：`setPrompt(p => p && { ...p, visible: false, then: "primary" })`；`onExited` 里若 `then === "primary"` 再调 Task 6 的 `onAppConnect(row)`（这样 `ConnectAppDialog` 在弹窗完全收起后才挂，避开 `ConnectAppDialog.tsx:4` 的坑），然后 `setPrompt(null)`。「稍后」只收起。
- [ ] **Step 6: PASS + 两份 tsc + 邻居**。
- [ ] **Step 7: Commit** `feat(mobile): 连接卡发来时正看着就弹窗，只弹一次（#1666）`

---

### Task 8: 文档

**Files:**
- Create: `docs/adr/0374-智能体要连应用时发连接卡-按钮由手机判断-连上和不用了都起一轮.md`（号码合并前 re-fetch 再核）
- Modify: `docs/where-to-find-things.md`（一条，列 `src/shared/appConnect.ts` / `appConnectPopup.ts` / `requestAppConnectTool.ts` / `pxTools.onNeedsLogin` / `sessionService.answerAppConnect` / `frameHandler app_connect` / `Bubbles.AppConnectCard` / `AppConnectPrompt`，说清为什么按钮由手机判、协议 30、只在主场）
- Modify: `CONTEXT.md`（产品术语段加「连接卡」：智能体请主人连上一个应用时会话里出的那张卡，ADR-0374）

- [ ] **Step 1: ADR**（格式照最近一条 ADR，比如 0372）：背景（#1666 原话）、决定（1. 显式工具 + 409 兜底；2. 按钮由手机判断，因为 edge 对平台身份 403；3. 连上 / 不用了都起一轮，开场白算主人亲口；4. 只在主场、非外联 / 车道 / 受监督轮、L0 / L1；5. 协议 30）、代价（旧手机被握手拒；团队工作区一期不发卡；桌面不画；Supabase 目录连接器只读，接上也跑不了 migration）。
- [ ] **Step 2: where-to-find-things + CONTEXT.md**。
- [ ] **Step 3: 全量门禁** `npm test`，日志里认 `GATE_EXIT=0`。
- [ ] **Step 4: Commit** `docs: 连接卡 ADR-0374 + 代码地图 + 术语（#1666）`
