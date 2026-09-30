# 手机 App 里接入应用（云端连接器）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机上点「接入应用」→ 浏览器登录 / 粘 token / 直接连 → 这个应用进 edge 上本账号的云端连接器，自己的智能体马上能用，并能在手机上开关「借给团队」。

**Architecture:** Escrow DO 加第二个封存键 `cloud`（写者只有本计划新加的 `/px/v1/cloud*` 端点），`grants` / `call` 两个 op 把 `sealed` 与 `cloud` 合成一份 `EscrowDoc` 再过原来的 `pxGate` / `grantedView`。OAuth 全在 edge 做（发现 → 动态注册 → PKCE → 回调换 token），回调地址是 edge 自己的 https。纯逻辑分三层进 vitest：线上形状与箱操作（`src/shared/remote/pxCloud.ts`）、OAuth 与编排（`services/edge/src/pxOAuth.ts`、`pxCloudOps.ts`，存储与网络全注入）、手机界面判据（`src/shared/mobileConnectors.ts`）；`worker.ts` 只剩接线，用读源码的断言钉。

**Tech Stack:** TypeScript strict（`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`）、Cloudflare Workers + Durable Objects、vitest、Expo / React Native（`expo-web-browser`）、Supabase（`workspace_connectors`）。

**Spec:** `docs/superpowers/specs/2026-09-30-mobile-connectors-design.md`（#1430）

## Global Constraints

- `serverId` 一律 `"cloud-" + catalogId`；`cloud` 键只归 `/px/v1/cloud*`，桌面的 PUT / DELETE 只碰 `sealed`。
- 回调地址固定：`https://edge.mrotto.agency/px/v1/cloud/callback`（由 `edgeBaseUrl` 拼，**不**写死在两处）；手机拦截的深链：`mrotto://connector-done`。
- 最终 URL 由 edge 按**自己手上的** `MCP_CATALOG` 拼，必须 `https://`；手机只报 `catalogId` + 参数值。
- `state` = `<uid>.<32 字节随机 base64url>`，10 分钟、一次性、查到即删；pending 每人最多 5 条；`/cloud/connect` 每人每分钟 10 次。
- 写 `cloud` 一律「外呼在前、读改写在后」，读改写包在 `atomic`（`blockConcurrencyWhile`）里，临界区里**不许**有 `fetch`。
- `needs_login` 的应用不进 `/grants` 的工具清单。
- `GET /px/v1/cloud` 永远是无凭据视图（不带 url / headers / oauth）。
- 退出登录**不**清 `cloud`。
- 平台身份（`x-runtime-secret`）不许打 `/px/v1/cloud*`。
- 手机表单用**居中弹窗**；破坏性确认右边那颗实底红（`DialogFooter` 的 `tone:"destructive"`）。
- 源码里不许写 NUL 转义字面量（`tests/architecture.noControlChars.test.ts`）。
- 门禁：`npm test`（先 `npm --prefix mobile ci`）。

## 与 spec 的两处出入（实现前先改 spec，Task 14 一起提交）

1. **撤销顺序统一成「授权先删、目录行后删」**。spec §6「关」与 §7「断开」写的是先删目录行，§6.1 桌面写的是先撤授权——互相矛盾。取后者：半路失败时留下的是「目录行在、授权没了」（团队设置页上看得见、智能体拿不到刀、再点一次即清），反过来留下的是 §6.1 自己点名的暗门「目录没了、授权还在」（谁都看不见）。接入仍是「箱先于目录」。
2. **runtime 要改一处、要重新部署**（spec §5 / §12 说不用）：`px_<uid8>_cloud-<id>_<tool>` 比桌面那条多 6 个字符，而 `pxTools.ts` 的 `safeName` 从来没管过长度——超过 64 的工具名会让整次请求被模型厂商拒掉（一轮直接失败，不是少一把刀）。Task 8 加长度封顶，部署顺序里 runtime 排在手机打包之前。

## 文件结构

| 文件 | 新 / 改 | 职责 |
|---|---|---|
| `src/shared/remote/pxCloud.ts` | 新 | `CloudBox` 形状、结构门、箱操作（增 / 删 / 授权 / 续期 / needs_login）、`mergeEscrow`、无凭据视图、错误文案常量、深链结果解析。edge 与手机共用 |
| `src/shared/mcpCatalogFill.ts` | 新 | 目录模板代入（`fillHttpEntry`），edge 与桌面 `configFromEntry` 共用 |
| `src/renderer/src/lib/mcpDirectory.ts` | 改 | `configFromEntry` 的 http 分支改调 `fillHttpEntry`（行为不变） |
| `services/edge/src/px.ts` | 改 | `sealJson` / `openJson` 泛化密封；`pxMcpListTools`（initialize + tools/list） |
| `services/edge/src/pxOAuth.ts` | 新 | state / PKCE / 发现（9728 → 8414）/ 动态注册 / 授权 URL / 换 token / 按记下的 tokenEndpoint 续期 |
| `services/edge/src/pxCloudOps.ts` | 新 | DO 里 `cloud_*` 各 op 的编排（端口注入：存储、fetch、时钟、随机、查主场、查在籍） |
| `services/edge/src/edge.ts` | 改 | `/px/v1/cloud`、`/cloud/connect`、`/cloud/callback`（免 JWT）、`/cloud/grant`、`DELETE /cloud/:id` |
| `services/edge/src/worker.ts` | 改 | Escrow DO：`cloud_*` op 接 `pxCloudOps`；`grants` / `call` 用合并视图；cloud 应用 401 走 `cloudRefresh` |
| `services/runtime/src/pxTools.ts` | 改 | `pxToolName`：工具名封顶 64 |
| `src/shared/workspaceView.ts` | 改 | 连接器行认出 `cloud-`：`origin: "phone"`、云端状态 `"phone"` |
| `src/main/workspaceManager.ts` | 改 | `withdrawConnector` 对 `cloud-` 走 `deps.cloudGrant(..., false)` |
| `src/main/pxCloudGrant.ts` | 新 | 桌面打 `POST /px/v1/cloud/grant` 的那一小段（注入 fetch，可测） |
| `src/main/index.ts` | 改 | 接线 `cloudGrant` |
| `src/renderer/src/components/WorkspaceConnectorsTab.tsx` | 改 | `cloud-` 行标「手机上接的」、不画点 |
| `src/shared/mobileConnectors.ts` | 新 | 手机界面判据：可接条目、分组搜索、接入方式、参数校验、两段列表、详情、借给团队行 |
| `src/shared/mobileMachine.ts` | 改 | `appRows` 滤掉 `cloud-`；文案换成新的 |
| `mobile/src/machine/connectorsApi.ts` | 新 | 手机打 `/px/v1/cloud*` |
| `mobile/src/machine/connectorsStore.ts` | 新 | 云端视图的外部 store（读不到 ≠ 空） |
| `mobile/src/machine/connectApp.ts` | 新 | 接入编排：connect → 浏览器 → 解析深链 |
| `mobile/src/machine/AppsScreen.tsx` | 改 | 两段列表 + 右上「接入」 |
| `mobile/src/machine/ConnectAppScreen.tsx` | 新 | 目录：搜索 + 分组 |
| `mobile/src/machine/ConnectAppDialog.tsx` | 新 | 接入前那一张居中弹窗（介绍 + 参数） |
| `mobile/src/machine/AppDetailScreen.tsx` | 新 | 工具清单、借给团队、重新登录、断开 |
| `mobile/src/nav/types.ts` / `RootNavigator.tsx` | 改 | 两个新路由 |
| `scripts/probe-cloud-oauth.mjs` | 新 | 上线前逐条跑目录 OAuth 前半段（https 回调），产出 blocked 清单 |
| `docs/adr/NNNN-cloud-connectors.md` / `CONTEXT.md` / `AGENTS.md` | 改 | 决策、术语、索引 |

---

### Task 1: 云端连接器的线上形状与箱操作（`pxCloud.ts`）

**Files:**
- Create: `src/shared/remote/pxCloud.ts`
- Test: `tests/shared/remote/pxCloud.test.ts`

**Interfaces:**
- Consumes: `EscrowDoc` / `EscrowGrant` / `WORKSPACE_ID_RE` from `src/shared/remote/pxEscrow.ts`
- Produces:
  - `CLOUD_PREFIX = "cloud-"`、`isCloudServerId(id: string): boolean`、`cloudServerId(catalogId: string): string`
  - `interface CloudOAuth { tokens?: Record<string, unknown>; clientInformation?: Record<string, unknown>; tokenEndpoint: string }`
  - `interface CloudGrant { workspaceId: string; allow: string[] }`
  - `interface CloudService { serverId; catalogId; url; headers?; oauth?: CloudOAuth; toolDefs: EscrowToolDef[]; status: "ok" | "needs_login"; grants: CloudGrant[]; connectedTs: number }`
  - `interface CloudBox { v: 1; hostUid: string; services: CloudService[]; updatedTs: number }`
  - `type EscrowToolDef = EscrowService["toolDefs"][number]`
  - `parseCloudBox(raw: unknown): CloudBox | null`
  - `emptyCloudBox(hostUid: string, now: number): CloudBox`
  - `upsertCloudService(box: CloudBox, svc: CloudServiceInput, homeId: string | null, now: number): CloudBox`（`CloudServiceInput = Omit<CloudService, "grants" | "connectedTs" | "status">`）
  - `removeCloudService(box, serverId, now): CloudBox`
  - `setCloudGrant(box, serverId, workspaceId, on: boolean, now): CloudBox | null`（`null` = 没有这台）
  - `ensureHomeGrant(box, homeId: string, now): CloudBox`
  - `withCloudOAuth(box, serverId, oauth: CloudOAuth, now): CloudBox`
  - `markNeedsLogin(box, serverId, now): CloudBox`
  - `mergeEscrow(sealed: EscrowDoc | null, box: CloudBox | null): EscrowDoc | null`
  - `cloudNeedsLogin(box: CloudBox | null, serverId: string): boolean`
  - `interface CloudViewItem { serverId; catalogId; status; tools: string[]; grants: string[]; connectedTs: number }`
  - `cloudView(box: CloudBox | null): CloudViewItem[]`、`parseCloudView(raw: unknown): CloudViewItem[] | null`
  - `type ConnectReply = { kind: "authorize"; authorizeUrl: string } | { kind: "connected"; serverId: string }`、`parseConnectReply(raw): ConnectReply | null`
  - `CONNECT_DONE_URL = "mrotto://connector-done"`、`parseConnectDone(url: string): { ok: true; serverId: string } | { ok: false; message: string }`
  - `connectDoneUrl(r: { ok: true; serverId: string } | { ok: false; message: string }): string`
  - `toConnectDone(raw: unknown): ConnectDone`（DO 回什么形状都收成 `ConnectDone`；认不出 = `{ok:false, message: CLOUD_TEXT.unknown}`）
  - `CLOUD_TEXT`（spec §9 的文案，edge 与手机共用）
  - `parseCloudError(status: number, payload: unknown): string | null`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/remote/pxCloud.test.ts
import { describe, expect, it } from "vitest";
import {
  CLOUD_TEXT, cloudNeedsLogin, cloudServerId, cloudView, connectDoneUrl, emptyCloudBox, ensureHomeGrant,
  isCloudServerId, markNeedsLogin, mergeEscrow, parseCloudBox, parseCloudError, parseCloudView, parseConnectDone,
  parseConnectReply, removeCloudService, setCloudGrant, toConnectDone, upsertCloudService, withCloudOAuth,
  type CloudBox,
} from "../../../src/shared/remote/pxCloud.js";
import type { EscrowDoc } from "../../../src/shared/remote/pxEscrow.js";

const HOME = "11111111-1111-1111-1111-111111111111";
const TEAM = "22222222-2222-2222-2222-222222222222";
const tool = (name: string) => ({ name, description: "", inputSchema: {} });

function boxWithNotion(): CloudBox {
  return upsertCloudService(emptyCloudBox("u1", 1), {
    serverId: "cloud-notion", catalogId: "notion", url: "https://mcp.notion.com/mcp",
    oauth: { tokens: { access_token: "AT", refresh_token: "RT" }, clientInformation: { client_id: "c" }, tokenEndpoint: "https://api.notion.com/token" },
    toolDefs: [tool("search"), tool("create_page")],
  }, HOME, 2);
}

describe("serverId 前缀", () => {
  it("cloud- 前缀只认开头", () => {
    expect(cloudServerId("notion")).toBe("cloud-notion");
    expect(isCloudServerId("cloud-notion")).toBe(true);
    expect(isCloudServerId("notion-cloud-x")).toBe(false);
  });
});

describe("parseCloudBox", () => {
  it("往返", () => {
    const box = boxWithNotion();
    expect(parseCloudBox(JSON.parse(JSON.stringify(box)))).toEqual(box);
  });
  it("拒非 https、拒缺 tokenEndpoint 的 oauth、拒坏 workspaceId、拒坏 status", () => {
    const good = JSON.parse(JSON.stringify(boxWithNotion()));
    const bad = (mut: (b: any) => void) => { const b = JSON.parse(JSON.stringify(good)); mut(b); return parseCloudBox(b); };
    expect(bad((b) => { b.services[0].url = "http://x"; })).toBeNull();
    expect(bad((b) => { delete b.services[0].oauth.tokenEndpoint; })).toBeNull();
    expect(bad((b) => { b.services[0].grants[0].workspaceId = "x),or(1"; })).toBeNull();
    expect(bad((b) => { b.services[0].status = "weird"; })).toBeNull();
    expect(bad((b) => { b.services[0].serverId = "notion"; })).toBeNull(); // 必须带 cloud- 前缀
    expect(bad((b) => { b.v = 2; })).toBeNull();
  });
});

describe("箱操作", () => {
  it("新接入默认带主场授权；没主场就不带", () => {
    expect(boxWithNotion().services[0]!.grants).toEqual([{ workspaceId: HOME, allow: [] }]);
    const noHome = upsertCloudService(emptyCloudBox("u1", 1), {
      serverId: "cloud-x", catalogId: "x", url: "https://x.example", toolDefs: [],
    }, null, 2);
    expect(noHome.services[0]!.grants).toEqual([]);
  });
  it("重新登录覆盖凭据与工具清单、保留授权、状态回 ok", () => {
    let box = setCloudGrant(boxWithNotion(), "cloud-notion", TEAM, true, 3)!;
    box = markNeedsLogin(box, "cloud-notion", 4);
    box = upsertCloudService(box, {
      serverId: "cloud-notion", catalogId: "notion", url: "https://mcp.notion.com/mcp",
      oauth: { tokens: { access_token: "AT2" }, tokenEndpoint: "https://api.notion.com/token" },
      toolDefs: [tool("search")],
    }, HOME, 5);
    const s = box.services[0]!;
    expect(s.status).toBe("ok");
    expect(s.toolDefs.map((t) => t.name)).toEqual(["search"]);
    expect(s.grants.map((g) => g.workspaceId).sort()).toEqual([HOME, TEAM].sort());
    expect(s.connectedTs).toBe(5);
  });
  it("授权开关幂等；没有这台回 null", () => {
    const on = setCloudGrant(boxWithNotion(), "cloud-notion", TEAM, true, 3)!;
    expect(setCloudGrant(on, "cloud-notion", TEAM, true, 4)!.services[0]!.grants).toHaveLength(2);
    const off = setCloudGrant(on, "cloud-notion", TEAM, false, 5)!;
    expect(off.services[0]!.grants.map((g) => g.workspaceId)).toEqual([HOME]);
    expect(setCloudGrant(on, "cloud-nope", TEAM, true, 6)).toBeNull();
  });
  it("ensureHomeGrant 只补没有主场授权的那几台", () => {
    const noHome = upsertCloudService(emptyCloudBox("u1", 1), {
      serverId: "cloud-x", catalogId: "x", url: "https://x.example", toolDefs: [],
    }, null, 2);
    const fixed = ensureHomeGrant(noHome, HOME, 3);
    expect(fixed.services[0]!.grants).toEqual([{ workspaceId: HOME, allow: [] }]);
    expect(ensureHomeGrant(fixed, HOME, 4)).toBe(fixed); // 没变就原样返回（调用方据此不写库）
  });
  it("续期写回 oauth；删除", () => {
    const box = withCloudOAuth(boxWithNotion(), "cloud-notion", { tokens: { access_token: "NEW" }, tokenEndpoint: "https://t" }, 9);
    expect(box.services[0]!.oauth!.tokens).toEqual({ access_token: "NEW" });
    expect(removeCloudService(box, "cloud-notion", 10).services).toEqual([]);
  });
});

describe("mergeEscrow", () => {
  const sealed: EscrowDoc = {
    v: 1, hostUid: "u1", updatedTs: 1,
    services: [{ serverId: "linear", url: "https://mcp.linear.app/mcp", toolDefs: [tool("list")] }],
    grants: [{ workspaceId: HOME, allow: [{ serverId: "linear", tools: [] }] }],
  };
  it("两边摊平成一份；cloud 的授权变成 EscrowGrant", () => {
    const m = mergeEscrow(sealed, boxWithNotion())!;
    expect(m.services.map((s) => s.serverId)).toEqual(["linear", "cloud-notion"]);
    expect(m.grants).toContainEqual({ workspaceId: HOME, allow: [{ serverId: "cloud-notion", tools: [] }] });
    expect(m.grants).toContainEqual(sealed.grants[0]);
  });
  it("needs_login 的不进 services 也不进 grants", () => {
    const m = mergeEscrow(null, markNeedsLogin(boxWithNotion(), "cloud-notion", 3));
    expect(m!.services).toEqual([]);
    expect(m!.grants).toEqual([]);
    expect(cloudNeedsLogin(markNeedsLogin(boxWithNotion(), "cloud-notion", 3), "cloud-notion")).toBe(true);
  });
  it("两边都没有 = null；只有 sealed 原样", () => {
    expect(mergeEscrow(null, null)).toBeNull();
    expect(mergeEscrow(sealed, null)).toEqual(sealed);
  });
});

describe("无凭据视图", () => {
  it("不漏 url / headers / token", () => {
    const view = cloudView(boxWithNotion());
    expect(JSON.stringify(view)).not.toMatch(/AT|RT|notion\.com|client_id/);
    expect(view).toEqual([{ serverId: "cloud-notion", catalogId: "notion", status: "ok", tools: ["search", "create_page"], grants: [HOME], connectedTs: 2 }]);
    expect(parseCloudView({ apps: view })).toEqual(view);
    expect(parseCloudView({ apps: [{ serverId: 1 }] })).toBeNull();
  });
});

describe("线上回包与深链", () => {
  it("connect 回包两种", () => {
    expect(parseConnectReply({ kind: "authorize", authorizeUrl: "https://a" })).toEqual({ kind: "authorize", authorizeUrl: "https://a" });
    expect(parseConnectReply({ kind: "connected", serverId: "cloud-x" })).toEqual({ kind: "connected", serverId: "cloud-x" });
    expect(parseConnectReply({ kind: "authorize" })).toBeNull();
  });
  it("深链往返（中文原话能回来）", () => {
    expect(parseConnectDone(connectDoneUrl({ ok: true, serverId: "cloud-notion" }))).toEqual({ ok: true, serverId: "cloud-notion" });
    expect(parseConnectDone(connectDoneUrl({ ok: false, message: CLOUD_TEXT.stateExpired }))).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
    expect(parseConnectDone("mrotto://connector-done")).toEqual({ ok: false, message: CLOUD_TEXT.unknown });
  });
  it("toConnectDone 归一化 DO 的回包", () => {
    expect(toConnectDone({ ok: true, serverId: "cloud-x" })).toEqual({ ok: true, serverId: "cloud-x" });
    expect(toConnectDone({ ok: false, message: "坏" })).toEqual({ ok: false, message: "坏" });
    expect(toConnectDone({ ok: true })).toEqual({ ok: false, message: CLOUD_TEXT.unknown });
    expect(toConnectDone(null)).toEqual({ ok: false, message: CLOUD_TEXT.unknown });
  });
  it("错误回包：认 otto_edge 形状，其余 null", () => {
    expect(parseCloudError(400, { error: { message: "坏", type: "otto_edge", code: "x" } })).toBe("坏");
    expect(parseCloudError(200, { error: { message: "坏", type: "otto_edge" } })).toBeNull();
    expect(parseCloudError(500, "oops")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/remote/pxCloud.test.ts`
Expected: FAIL（`Cannot find module .../pxCloud.js`）

- [ ] **Step 3: 实现**

```ts
// src/shared/remote/pxCloud.ts
// pxCloud —— 云端连接器（手机上接的应用）的线上约定（#1430，spec 2026-09-30）。
//
// 与 pxEscrow.ts 同一个定位：**两方共用一份**——edge 的 Escrow DO（解析 + 密封 + 合并）与手机（读无凭据视图、
// 解析深链）。它住在同一只 DO 的第二个封存键 `cloud` 下：`sealed` 归桌面（整箱覆盖、零授权删箱），`cloud` 归
// `/px/v1/cloud*`。两个键一个写者，谁都不会冲掉谁（spec §2）。
//
// 智能体用它们不经过任何新路：DO 的 grants / call 两个 op 先 `mergeEscrow` 成一份 EscrowDoc，再过原来的
// pxGate / grantedView（spec §5），所以闸序、在籍判据、审计一个字都不用改。

import { WORKSPACE_ID_RE, type EscrowDoc, type EscrowGrant, type EscrowService } from "./pxEscrow.js";

export const CLOUD_PREFIX = "cloud-";
export const isCloudServerId = (id: string): boolean => id.startsWith(CLOUD_PREFIX);
export const cloudServerId = (catalogId: string): string => CLOUD_PREFIX + catalogId;

export type EscrowToolDef = EscrowService["toolDefs"][number];

export interface CloudOAuth {
  tokens?: Record<string, unknown>;
  clientInformation?: Record<string, unknown>;
  /** 接入时记下，续期直接用——不再像桌面那只箱的兜底自刷那样每次猜 discovery */
  tokenEndpoint: string;
}

/** allow 口径同 workspace_connectors：[] = 整台放行 */
export interface CloudGrant { workspaceId: string; allow: string[] }

export interface CloudService {
  serverId: string;
  catalogId: string;
  url: string;
  headers?: Record<string, string>;
  oauth?: CloudOAuth;
  toolDefs: EscrowToolDef[];
  status: "ok" | "needs_login";
  grants: CloudGrant[];
  connectedTs: number;
}

export interface CloudBox {
  v: 1;
  hostUid: string;
  services: CloudService[];
  updatedTs: number;
}

export type CloudServiceInput = Omit<CloudService, "grants" | "connectedTs" | "status">;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStrRecord = (v: unknown): v is Record<string, string> =>
  isObj(v) && Object.values(v).every((x) => typeof x === "string");

function parseService(s: unknown): CloudService | null {
  if (!isObj(s)) return null;
  if (typeof s.serverId !== "string" || !isCloudServerId(s.serverId)) return null;
  if (typeof s.catalogId !== "string" || s.catalogId === "") return null;
  if (typeof s.url !== "string" || !/^https:\/\//.test(s.url)) return null;
  if (s.headers !== undefined && !isStrRecord(s.headers)) return null;
  if (s.oauth !== undefined) {
    if (!isObj(s.oauth) || typeof s.oauth.tokenEndpoint !== "string" || !/^https:\/\//.test(s.oauth.tokenEndpoint)) return null;
  }
  if (!Array.isArray(s.toolDefs)) return null;
  if (s.status !== "ok" && s.status !== "needs_login") return null;
  if (!Array.isArray(s.grants)) return null;
  for (const g of s.grants) {
    if (!isObj(g) || typeof g.workspaceId !== "string" || !WORKSPACE_ID_RE.test(g.workspaceId)) return null;
    if (!Array.isArray(g.allow) || !g.allow.every((t) => typeof t === "string")) return null;
  }
  if (typeof s.connectedTs !== "number") return null;
  return s as unknown as CloudService;
}

/** 解封后的结构门。认不出回 null——DO 把 null 当「箱子不在」处理（写的时候从空箱重建） */
export function parseCloudBox(raw: unknown): CloudBox | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.hostUid !== "string" || raw.hostUid === "") return null;
  if (!Array.isArray(raw.services) || typeof raw.updatedTs !== "number") return null;
  const services: CloudService[] = [];
  for (const s of raw.services) {
    const p = parseService(s);
    if (!p) return null;
    services.push(p);
  }
  return { v: 1, hostUid: raw.hostUid, services, updatedTs: raw.updatedTs };
}

export function emptyCloudBox(hostUid: string, now: number): CloudBox {
  return { v: 1, hostUid, services: [], updatedTs: now };
}

const touch = (box: CloudBox, services: CloudService[], now: number): CloudBox => ({ ...box, services, updatedTs: now });

/** 接入 / 重新登录。同一个 serverId 已在 = 重新登录：凭据与工具清单覆盖、授权保留（spec §4）。
    新接入且知道主场 id 时默认带一条主场授权（spec §3.4） */
export function upsertCloudService(box: CloudBox, svc: CloudServiceInput, homeId: string | null, now: number): CloudBox {
  const prior = box.services.find((s) => s.serverId === svc.serverId);
  const grants = prior ? prior.grants : homeId ? [{ workspaceId: homeId, allow: [] }] : [];
  const next: CloudService = { ...svc, status: "ok", grants, connectedTs: now };
  const rest = box.services.filter((s) => s.serverId !== svc.serverId);
  return touch(box, prior ? box.services.map((s) => (s.serverId === svc.serverId ? next : s)) : [...rest, next], now);
}

export function removeCloudService(box: CloudBox, serverId: string, now: number): CloudBox {
  return touch(box, box.services.filter((s) => s.serverId !== serverId), now);
}

/** 借给团队的开关（v1 只做整台，allow 恒为 []）。没有这台回 null——调用方回 404 */
export function setCloudGrant(box: CloudBox, serverId: string, workspaceId: string, on: boolean, now: number): CloudBox | null {
  const svc = box.services.find((s) => s.serverId === serverId);
  if (!svc) return null;
  const others = svc.grants.filter((g) => g.workspaceId !== workspaceId);
  const grants = on ? [...others, { workspaceId, allow: [] }] : others;
  return touch(box, box.services.map((s) => (s.serverId === serverId ? { ...s, grants } : s)), now);
}

/** 接入那一刻还没建主场的，下一次读视图时补上。没有要补的就**原样返回同一个对象**——调用方拿 `!==` 判要不要写库 */
export function ensureHomeGrant(box: CloudBox, homeId: string, now: number): CloudBox {
  if (box.services.every((s) => s.grants.some((g) => g.workspaceId === homeId))) return box;
  return touch(box, box.services.map((s) =>
    s.grants.some((g) => g.workspaceId === homeId) ? s : { ...s, grants: [...s.grants, { workspaceId: homeId, allow: [] }] }
  ), now);
}

export function withCloudOAuth(box: CloudBox, serverId: string, oauth: CloudOAuth, now: number): CloudBox {
  return touch(box, box.services.map((s) => (s.serverId === serverId ? { ...s, oauth, status: "ok" } : s)), now);
}

export function markNeedsLogin(box: CloudBox, serverId: string, now: number): CloudBox {
  return touch(box, box.services.map((s) => (s.serverId === serverId ? { ...s, status: "needs_login" } : s)), now);
}

export function cloudNeedsLogin(box: CloudBox | null, serverId: string): boolean {
  return box?.services.some((s) => s.serverId === serverId && s.status === "needs_login") ?? false;
}

/** sealed + cloud → 一份 EscrowDoc，交给原来的 pxGate / grantedView（spec §5）。
    needs_login 的整台不进（spec §4：智能体看不到一把必然失败的刀） */
export function mergeEscrow(sealed: EscrowDoc | null, box: CloudBox | null): EscrowDoc | null {
  if (!box || box.services.length === 0) return sealed;
  const live = box.services.filter((s) => s.status === "ok");
  const services: EscrowService[] = live.map((s) => ({
    serverId: s.serverId,
    url: s.url,
    ...(s.headers ? { headers: s.headers } : {}),
    ...(s.oauth ? { oauth: { ...(s.oauth.tokens ? { tokens: s.oauth.tokens } : {}), ...(s.oauth.clientInformation ? { clientInformation: s.oauth.clientInformation } : {}) } } : {}),
    toolDefs: s.toolDefs,
  }));
  const grants: EscrowGrant[] = live.flatMap((s) =>
    s.grants.map((g) => ({ workspaceId: g.workspaceId, allow: [{ serverId: s.serverId, tools: [...g.allow] }] }))
  );
  return {
    v: 1,
    hostUid: sealed?.hostUid ?? box.hostUid,
    services: [...(sealed?.services ?? []), ...services],
    grants: [...(sealed?.grants ?? []), ...grants],
    updatedTs: Math.max(sealed?.updatedTs ?? 0, box.updatedTs),
  };
}

// ─── 无凭据视图（GET /px/v1/cloud，spec §4）──────────────────────────

export interface CloudViewItem {
  serverId: string;
  catalogId: string;
  status: "ok" | "needs_login";
  tools: string[];
  grants: string[];
  connectedTs: number;
}

/** 只挑白名单字段——不是「删掉凭据字段」：哪天 CloudService 多一格秘密，这里默认就不带 */
export function cloudView(box: CloudBox | null): CloudViewItem[] {
  return (box?.services ?? []).map((s) => ({
    serverId: s.serverId,
    catalogId: s.catalogId,
    status: s.status,
    tools: s.toolDefs.map((t) => t.name),
    grants: s.grants.map((g) => g.workspaceId),
    connectedTs: s.connectedTs,
  }));
}

export function parseCloudView(raw: unknown): CloudViewItem[] | null {
  if (!isObj(raw) || !Array.isArray(raw.apps)) return null;
  const out: CloudViewItem[] = [];
  for (const a of raw.apps) {
    if (!isObj(a) || typeof a.serverId !== "string" || typeof a.catalogId !== "string") return null;
    if (a.status !== "ok" && a.status !== "needs_login") return null;
    if (!Array.isArray(a.tools) || !a.tools.every((t) => typeof t === "string")) return null;
    if (!Array.isArray(a.grants) || !a.grants.every((t) => typeof t === "string")) return null;
    if (typeof a.connectedTs !== "number") return null;
    out.push({ serverId: a.serverId, catalogId: a.catalogId, status: a.status, tools: a.tools, grants: a.grants, connectedTs: a.connectedTs });
  }
  return out;
}

// ─── connect 回包 / 回调深链 ─────────────────────────────────────────

export type ConnectReply = { kind: "authorize"; authorizeUrl: string } | { kind: "connected"; serverId: string };

export function parseConnectReply(raw: unknown): ConnectReply | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "authorize" && typeof raw.authorizeUrl === "string" && /^https:\/\//.test(raw.authorizeUrl)) {
    return { kind: "authorize", authorizeUrl: raw.authorizeUrl };
  }
  if (raw.kind === "connected" && typeof raw.serverId === "string") return { kind: "connected", serverId: raw.serverId };
  return null;
}

/** 手机传给 openAuthSessionAsync 的拦截目标；edge 回调页 302 到它（spec §3.1 第 6 步） */
export const CONNECT_DONE_URL = "mrotto://connector-done";

export type ConnectDone = { ok: true; serverId: string } | { ok: false; message: string };

export function connectDoneUrl(r: ConnectDone): string {
  const q = r.ok
    ? new URLSearchParams({ ok: "1", serverId: r.serverId })
    : new URLSearchParams({ ok: "0", message: r.message });
  return `${CONNECT_DONE_URL}?${q.toString()}`;
}

/** 不用 new URL：自定义 scheme 各实现切法不一（同 mobile/src/oauth.ts 的 queryOf） */
export function parseConnectDone(url: string): ConnectDone {
  const i = url.indexOf("?");
  const q = new URLSearchParams(i < 0 ? "" : url.slice(i + 1));
  const serverId = q.get("serverId");
  if (q.get("ok") === "1" && serverId) return { ok: true, serverId };
  return { ok: false, message: q.get("message") || CLOUD_TEXT.unknown };
}

export function toConnectDone(raw: unknown): ConnectDone {
  if (isObj(raw) && raw.ok === true && typeof raw.serverId === "string" && raw.serverId !== "") return { ok: true, serverId: raw.serverId };
  if (isObj(raw) && raw.ok === false && typeof raw.message === "string" && raw.message !== "") return { ok: false, message: raw.message };
  return { ok: false, message: CLOUD_TEXT.unknown };
}

// ─── 文案（spec §9，每种情形各说各的话）───────────────────────────────

export const CLOUD_TEXT = {
  stateExpired: "授权超时了，再点一次连接",
  noDcr: "这个应用暂时不能在手机上直接登录，去电脑上接",
  badToken: "这个 token 用不了，检查一下再粘一次",
  needsLogin: "这个应用要在手机上重新登录",
  tooMany: "操作太频繁了，过一分钟再试",
  unknown: "没接上，再试一次",
} as const;

/** edge 的错误回包（`{error:{message,type:"otto_edge",code}}`）→ 那句话。认不出回 null，调用方写 HTTP 状态 */
export function parseCloudError(status: number, payload: unknown): string | null {
  if (status < 400 || !isObj(payload) || !isObj(payload.error)) return null;
  const e = payload.error;
  return e.type === "otto_edge" && typeof e.message === "string" && e.message !== "" ? e.message : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/remote/pxCloud.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/remote/pxCloud.ts tests/shared/remote/pxCloud.test.ts
git commit -m "feat(px): 云端连接器的线上形状与箱操作（#1430）

cloud 键归 /px/v1/cloud*、sealed 归桌面，两个键一个写者；mergeEscrow 把两份摊平成
EscrowDoc 交给原来的 pxGate / grantedView，needs_login 的整台不进。无凭据视图按白名单挑字段。"
```

---

### Task 2: 目录模板代入抽进 shared（`mcpCatalogFill.ts`）

**Files:**
- Create: `src/shared/mcpCatalogFill.ts`
- Modify: `src/renderer/src/lib/mcpDirectory.ts:138-167`（`configFromEntry` 的 http 分支）
- Test: `tests/shared/mcpCatalogFill.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry` from `src/shared/mcpCatalog.ts`
- Produces: `fillHttpEntry(entry: CatalogEntry, values: Readonly<Record<string, string>>): { url: string; headers: Record<string, string> }`；`missingParams(entry, values): string[]`（必填但空的参数名）

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/mcpCatalogFill.test.ts
import { describe, expect, it } from "vitest";
import { MCP_CATALOG } from "../../src/shared/mcpCatalog.js";
import { fillHttpEntry, missingParams } from "../../src/shared/mcpCatalogFill.js";
import { configFromEntry } from "../../src/renderer/src/lib/mcpDirectory.js";

const github = MCP_CATALOG.find((e) => e.id === "github")!;

describe("fillHttpEntry", () => {
  it("代进请求头模板，键是真实请求头名", () => {
    expect(fillHttpEntry(github, { github_token: "ghp_x" })).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ghp_x" },
    });
  });
  it("没填的不落请求头（不写装着 {hole} 的键）", () => {
    expect(fillHttpEntry(github, {}).headers).toEqual({});
  });
  it("missingParams 只报必填且空的", () => {
    expect(missingParams(github, {})).toEqual(["github_token"]);
    expect(missingParams(github, { github_token: " " })).toEqual(["github_token"]);
    expect(missingParams(github, { github_token: "x" })).toEqual([]);
  });
  it("桌面 configFromEntry 的 http 结果与它逐字一致", () => {
    for (const e of MCP_CATALOG.filter((x) => x.transport === "http")) {
      const values = Object.fromEntries(e.params.map((p) => [p.name, `v-${p.name}`]));
      const cfg = configFromEntry(e, values);
      expect(cfg).toEqual({ kind: "http", ...fillHttpEntry(e, values), enabled: true });
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/mcpCatalogFill.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现，并让 `configFromEntry` 改调它**

```ts
// src/shared/mcpCatalogFill.ts
// 目录条目 + 参数值 → http 连接要用的 url 与请求头（#1430 从 renderer/lib/mcpDirectory.ts 抽出）。
// 两个消费方：桌面装一台（configFromEntry）与 edge 替手机接一台（pxCloudOps）。**判据只能有一份**——
// 桌面能连上的一台，手机那边代出来的地址差一个字就是一次莫名其妙的 401。规矩原样照搬：请求头只从
// headerTemplates 生成、键是真实请求头名；空值与代完仍带 {占位符} 的一律不落。
import type { CatalogEntry } from "./mcpCatalog.js";

export function fillHttpEntry(
  entry: CatalogEntry,
  values: Readonly<Record<string, string>>
): { url: string; headers: Record<string, string> } {
  const fill = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const v = values[name];
      return v === undefined || v === "" ? whole : v;
    });
  const hasHole = (text: string): boolean => /\{\w+\}/.test(text);
  const headers: Record<string, string> = {};
  for (const [headerName, template] of Object.entries(entry.headerTemplates ?? {})) {
    const value = fill(template);
    if (value === "" || hasHole(value)) continue;
    headers[headerName] = value;
  }
  return { url: fill(entry.url ?? ""), headers };
}

/** 必填但空（含全空白）的参数名，按目录顺序 */
export function missingParams(entry: CatalogEntry, values: Readonly<Record<string, string>>): string[] {
  return entry.params.filter((p) => p.required && (values[p.name] ?? "").trim() === "").map((p) => p.name);
}
```

`src/renderer/src/lib/mcpDirectory.ts` 里 `configFromEntry` 的 http 分支替换为：

```ts
  if (entry.transport === "http") {
    return { kind: "http", ...fillHttpEntry(entry, values), enabled: true };
  }
```

文件头加 `import { fillHttpEntry } from "../../../shared/mcpCatalogFill.js";`；删掉只剩 stdio 用的变量里不再需要的部分（`fill` / `used` 仍给 stdio 分支用，保留）；头注里「值代进 url / 请求头」那段末尾加一句「http 那半在 shared/mcpCatalogFill.ts，edge 替手机接应用时用同一份」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/mcpCatalogFill.test.ts tests/renderer/lib/mcpDirectory.test.ts`
Expected: PASS（后者若不存在，只跑前者）

- [ ] **Step 5: 提交**

```bash
git add src/shared/mcpCatalogFill.ts src/renderer/src/lib/mcpDirectory.ts tests/shared/mcpCatalogFill.test.ts
git commit -m "refactor(mcp): 目录模板代入抽进 shared，edge 替手机接应用用同一份（#1430）"
```

---

### Task 3: 泛化密封 + 迷你 MCP 客户端补 `tools/list`（`px.ts`）

**Files:**
- Modify: `services/edge/src/px.ts`（密封段、迷你客户端段）
- Test: `tests/edge/px.test.ts`（追加）

**Interfaces:**
- Produces:
  - `sealJson(keyB64: string, value: unknown): Promise<string>`、`openJson(keyB64: string, sealed: string): Promise<unknown | null>`
  - `sealEscrow` / `openEscrow` 改为调它们（签名不变）
  - `pxMcpListTools(fetchLike, conn: { url: string; headers?: Record<string, string>; accessToken?: string }): Promise<{ ok: true; toolDefs: EscrowToolDef[] } | { ok: false; status: number; code: "upstream_auth" | "upstream_init" | "upstream_list"; message: string }>`

- [ ] **Step 1: 追加失败的测试**

```ts
// tests/edge/px.test.ts 末尾追加
import { openJson, pxMcpListTools, sealJson } from "../../services/edge/src/px.js";

describe("sealJson / openJson", () => {
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  it("往返；换 key 解不开回 null", async () => {
    const s = await sealJson(KEY, { a: 1 });
    expect(await openJson(KEY, s)).toEqual({ a: 1 });
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
    expect(await openJson(other, s)).toBeNull();
    expect(await openJson(KEY, "garbage")).toBeNull();
  });
});

describe("pxMcpListTools", () => {
  const ok = (id: number, result: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json", ...extra } });
  it("initialize → initialized → tools/list，带 bearer 与会话头", async () => {
    const seen: { body: any; headers: Record<string, string> }[] = [];
    const fetchLike = async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ body, headers: init.headers as Record<string, string> });
      if (body.method === "initialize") return ok(1, {}, { "mcp-session-id": "sess" });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return ok(2, { tools: [{ name: "search", description: "d", inputSchema: { type: "object" } }, { name: 3 }] });
    };
    const r = await pxMcpListTools(fetchLike, { url: "https://m.example/mcp", accessToken: "AT" });
    expect(r).toEqual({ ok: true, toolDefs: [{ name: "search", description: "d", inputSchema: { type: "object" } }] });
    expect(seen[0]!.headers.authorization).toBe("Bearer AT");
    expect(seen[2]!.headers["mcp-session-id"]).toBe("sess");
  });
  it("401 报 upstream_auth；list 报错报 upstream_list 带原话", async () => {
    expect(await pxMcpListTools(async () => new Response("", { status: 401 }), { url: "https://m.example" }))
      .toMatchObject({ ok: false, code: "upstream_auth" });
    const errList = async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") return ok(1, {});
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "workspace not found" } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    expect(await pxMcpListTools(errList, { url: "https://m.example" })).toMatchObject({ ok: false, code: "upstream_list", message: "workspace not found" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/edge/px.test.ts`
Expected: FAIL（`sealJson` / `pxMcpListTools` 未导出）

- [ ] **Step 3: 实现**

密封段替换为：

```ts
/** 密封任意 JSON（cloud 键与 pending 授权也用它）。keyB64 = 32 字节 base64（worker secret ESCROW_KEY） */
export async function sealJson(keyB64: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), te.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(ct)}`;
}

/** 解封。解不开（换过 key / 数据坏）回 null——调用方各自决定 null 意味着什么 */
export async function openJson(keyB64: string, sealed: string): Promise<unknown | null> {
  try {
    const [ivB64, ctB64] = sealed.split(".");
    if (!ivB64 || !ctB64) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, await aesKey(keyB64), unb64(ctB64));
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}

/** 密封整箱 */
export async function sealEscrow(keyB64: string, doc: EscrowDoc): Promise<string> {
  return sealJson(keyB64, doc);
}

/** 解封整箱。解不开回 null——上传方重传一次就能修好 */
export async function openEscrow(keyB64: string, sealed: string): Promise<EscrowDoc | null> {
  const raw = await openJson(keyB64, sealed);
  return raw === null ? null : parseEscrowDoc(raw);
}
```

迷你客户端段：把 `rpcHeaders` 改成收连接信息，`pxMcpCall` 传 `connOf(service)`；追加 `pxMcpListTools`：

```ts
/** 一次 MCP 连接需要的全部（EscrowService 与接入中途的临时连接都能给出这个形状） */
export interface McpConn { url: string; headers?: Record<string, string>; accessToken?: string }

const connOf = (service: EscrowService): McpConn => {
  const token = (service.oauth?.tokens as { access_token?: string } | undefined)?.access_token;
  return { url: service.url, ...(service.headers ? { headers: service.headers } : {}), ...(token ? { accessToken: token } : {}) };
};

function rpcHeaders(conn: McpConn, sessionId?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(conn.accessToken ? { authorization: `Bearer ${conn.accessToken}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...conn.headers,
  };
}

/** initialize + initialized。两个调用方（call / list）共用——握手那段各写一份迟早分家 */
async function mcpHandshake(
  fetchLike: FetchLike, conn: McpConn
): Promise<{ ok: true; sessionId: string | undefined } | { ok: false; status: number; code: "upstream_auth" | "upstream_init"; message: string }> {
  const initRes = await fetchLike(conn.url, {
    method: "POST",
    headers: rpcHeaders(conn),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "otto-px", version: "1" } } }),
  });
  if (initRes.status === 401) return { ok: false, status: 401, code: "upstream_auth", message: "托管凭据被上游拒绝" };
  if (!initRes.ok) return { ok: false, status: 502, code: "upstream_init", message: `上游 initialize 失败（${initRes.status}）` };
  const sessionId = initRes.headers.get("mcp-session-id") ?? undefined;
  const initBody = await readRpcResponse(initRes, 1);
  if (!initBody || isObj(initBody.error)) return { ok: false, status: 502, code: "upstream_init", message: "上游 initialize 响应不可解" };
  await fetchLike(conn.url, {
    method: "POST",
    headers: rpcHeaders(conn, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => undefined);
  return { ok: true, sessionId };
}

/** 接入时验一次凭据 + 拿工具清单（spec §3：成功才存）。形状不对的工具项跳过，不拒整份 */
export async function pxMcpListTools(
  fetchLike: FetchLike,
  conn: McpConn
): Promise<{ ok: true; toolDefs: EscrowService["toolDefs"] } | { ok: false; status: number; code: "upstream_auth" | "upstream_init" | "upstream_list"; message: string }> {
  const hs = await mcpHandshake(fetchLike, conn);
  if (!hs.ok) return hs;
  const res = await fetchLike(conn.url, {
    method: "POST",
    headers: rpcHeaders(conn, hs.sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  if (res.status === 401) return { ok: false, status: 401, code: "upstream_auth", message: "托管凭据被上游拒绝" };
  if (!res.ok) return { ok: false, status: 502, code: "upstream_list", message: `上游 tools/list 失败（${res.status}）` };
  const body = await readRpcResponse(res, 2);
  if (!body) return { ok: false, status: 502, code: "upstream_list", message: "上游 tools/list 响应不可解" };
  if (isObj(body.error)) {
    const m = (body.error as { message?: unknown }).message;
    return { ok: false, status: 502, code: "upstream_list", message: typeof m === "string" ? m : "上游报错" };
  }
  const tools = isObj(body.result) && Array.isArray(body.result.tools) ? body.result.tools : [];
  const toolDefs = tools.flatMap((t: unknown) =>
    isObj(t) && typeof t.name === "string"
      ? [{ name: t.name, description: typeof t.description === "string" ? t.description : "", inputSchema: t.inputSchema ?? {} }]
      : []
  );
  return { ok: true, toolDefs };
}
```

`pxMcpCall` 里 `post` 与握手换成 `const conn = connOf(service); const hs = await mcpHandshake(fetchLike, conn); if (!hs.ok) return hs;`，其后 `tools/call` 用 `rpcHeaders(conn, hs.sessionId)`；返回类型不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/edge/px.test.ts`
Expected: PASS（原有用例一条不改也全绿）

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/px.ts tests/edge/px.test.ts
git commit -m "feat(edge): 密封泛化成 sealJson/openJson；迷你 MCP 客户端补 tools/list（#1430）

握手那段抽成 mcpHandshake 两处共用。接入时要验一次凭据并拿工具清单，成功才存。"
```

---

### Task 4: edge 上的 OAuth（`pxOAuth.ts`）

**Files:**
- Create: `services/edge/src/pxOAuth.ts`
- Test: `tests/edge/pxOAuth.test.ts`

**Interfaces:**
- Consumes: `CloudOAuth` from `src/shared/remote/pxCloud.ts`
- Produces:
  - `type Random = (n: number) => Uint8Array`
  - `b64url(bytes: Uint8Array): string`
  - `makeState(uid: string, random: Random): string`、`stateUid(state: string): string | null`
  - `pkcePair(random: Random): Promise<{ verifier: string; challenge: string }>`
  - `interface OAuthMeta { authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; scopes: string[] }`
  - `type OAuthFail = { ok: false; code: "discovery" | "no_dcr" | "register" | "token"; message: string }`
  - `discoverOAuth(fetchLike, resourceUrl: string): Promise<{ ok: true; meta: OAuthMeta } | OAuthFail>`
  - `registerClient(fetchLike, meta, redirectUri: string): Promise<{ ok: true; client: Record<string, unknown> & { client_id: string } } | OAuthFail>`
  - `authorizeUrl(o: { meta: OAuthMeta; clientId: string; redirectUri: string; challenge: string; state: string; resource: string }): string`
  - `exchangeCode(fetchLike, o: { tokenEndpoint: string; code: string; verifier: string; clientId: string; redirectUri: string; resource: string }): Promise<{ ok: true; tokens: Record<string, unknown> & { access_token: string } } | OAuthFail>`
  - `refreshCloudOAuth(fetchLike, oauth: CloudOAuth): Promise<CloudOAuth | null>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/pxOAuth.test.ts
import { describe, expect, it } from "vitest";
import {
  authorizeUrl, b64url, discoverOAuth, exchangeCode, makeState, pkcePair, refreshCloudOAuth, registerClient, stateUid,
} from "../../services/edge/src/pxOAuth.js";

const rnd = (n: number) => new Uint8Array(n).fill(1);
const J = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const UID = "8f0c6a0e-1111-4222-8333-444455556666";

describe("state", () => {
  it("uid + 32 字节随机；拆得回 uid；坏形状 null", () => {
    const s = makeState(UID, rnd);
    expect(s.startsWith(`${UID}.`)).toBe(true);
    expect(s.slice(UID.length + 1)).toHaveLength(43);
    expect(stateUid(s)).toBe(UID);
    expect(stateUid("nouid")).toBeNull();
    expect(stateUid(`${UID}.short`)).toBeNull();
    expect(stateUid(`../x.${"A".repeat(43)}`)).toBeNull();
  });
});

describe("PKCE", () => {
  it("challenge = base64url(sha256(verifier))（RFC 7636 附录 B 的向量）", async () => {
    // 附录 B：verifier 由这 32 字节生成
    const bytes = new Uint8Array([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
    const { verifier, challenge } = await pkcePair(() => bytes);
    expect(verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(b64url(new Uint8Array([251, 255]))).toBe("-_8");
  });
});

describe("discoverOAuth", () => {
  it("9728 给了授权服务器就去它那儿读 8414", async () => {
    const hits: string[] = [];
    const f = async (u: string) => {
      hits.push(u);
      if (u === "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp") return J(200, { authorization_servers: ["https://auth.notion.com"] });
      if (u === "https://auth.notion.com/.well-known/oauth-authorization-server") {
        return J(200, { authorization_endpoint: "https://auth.notion.com/a", token_endpoint: "https://auth.notion.com/t", registration_endpoint: "https://auth.notion.com/r", scopes_supported: ["read"] });
      }
      return J(404, {});
    };
    const r = await discoverOAuth(f, "https://mcp.notion.com/mcp");
    expect(r).toEqual({ ok: true, meta: { authorizationEndpoint: "https://auth.notion.com/a", tokenEndpoint: "https://auth.notion.com/t", registrationEndpoint: "https://auth.notion.com/r", scopes: ["read"] } });
  });
  it("9728 没有就退回资源同源的 8414", async () => {
    const f = async (u: string) =>
      u === "https://mcp.linear.app/.well-known/oauth-authorization-server"
        ? J(200, { authorization_endpoint: "https://mcp.linear.app/authorize", token_endpoint: "https://mcp.linear.app/token" })
        : J(404, {});
    const r = await discoverOAuth(f, "https://mcp.linear.app/mcp");
    expect(r).toMatchObject({ ok: true, meta: { registrationEndpoint: null } });
  });
  it("拒非 https 的端点；都找不到回 discovery", async () => {
    const f = async () => J(200, { authorization_endpoint: "http://x/a", token_endpoint: "https://x/t" });
    expect(await discoverOAuth(f, "https://x.example/mcp")).toMatchObject({ ok: false, code: "discovery" });
    expect(await discoverOAuth(async () => J(404, {}), "https://x.example/mcp")).toMatchObject({ ok: false, code: "discovery" });
  });
});

describe("registerClient", () => {
  const meta = { authorizationEndpoint: "https://a/a", tokenEndpoint: "https://a/t", registrationEndpoint: "https://a/r", scopes: [] };
  it("没有注册端点 = no_dcr", async () => {
    expect(await registerClient(async () => J(200, {}), { ...meta, registrationEndpoint: null }, "https://e/cb")).toMatchObject({ ok: false, code: "no_dcr" });
  });
  it("带 https 回调、无密钥、名字 Mr Otto", async () => {
    let sent: any = null;
    const r = await registerClient(async (_u, init) => { sent = JSON.parse(String(init.body)); return J(201, { client_id: "cid" }); }, meta, "https://e/cb");
    expect(r).toEqual({ ok: true, client: { client_id: "cid" } });
    expect(sent).toMatchObject({ redirect_uris: ["https://e/cb"], token_endpoint_auth_method: "none", client_name: "Mr Otto", grant_types: ["authorization_code", "refresh_token"] });
  });
  it("注册被拒带厂商原话", async () => {
    const r = await registerClient(async () => J(400, { error_description: "redirect_uri not allowed" }), meta, "https://e/cb");
    expect(r).toEqual({ ok: false, code: "register", message: "redirect_uri not allowed" });
  });
});

describe("authorizeUrl / exchangeCode / refresh", () => {
  const meta = { authorizationEndpoint: "https://a/authorize?x=1", tokenEndpoint: "https://a/t", registrationEndpoint: null, scopes: ["read", "write"] };
  it("授权 URL 带 S256、resource、scope，保留原有 query", () => {
    const u = new URL(authorizeUrl({ meta, clientId: "cid", redirectUri: "https://e/cb", challenge: "ch", state: "st", resource: "https://m/mcp" }));
    expect(u.searchParams.get("x")).toBe("1");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: "cid", redirect_uri: "https://e/cb", code_challenge: "ch", code_challenge_method: "S256", state: "st", resource: "https://m/mcp", scope: "read write" });
  });
  it("换 token：表单体；没 access_token 算失败", async () => {
    let body = "";
    const ok = await exchangeCode(async (_u, init) => { body = String(init.body); return J(200, { access_token: "AT", refresh_token: "RT" }); },
      { tokenEndpoint: "https://a/t", code: "c", verifier: "v", clientId: "cid", redirectUri: "https://e/cb", resource: "https://m/mcp" });
    expect(ok).toEqual({ ok: true, tokens: { access_token: "AT", refresh_token: "RT" } });
    expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v", client_id: "cid", redirect_uri: "https://e/cb" });
    expect(await exchangeCode(async () => J(400, { error: "invalid_grant" }), { tokenEndpoint: "https://a/t", code: "c", verifier: "v", clientId: "cid", redirectUri: "https://e/cb", resource: "r" }))
      .toEqual({ ok: false, code: "token", message: "invalid_grant" });
  });
  it("续期用记下的 tokenEndpoint；不轮换就保留旧 refresh_token；缺料回 null", async () => {
    const oauth = { tokens: { access_token: "old", refresh_token: "RT" }, clientInformation: { client_id: "cid" }, tokenEndpoint: "https://a/t" };
    let hit = "";
    const r = await refreshCloudOAuth(async (u) => { hit = u; return J(200, { access_token: "new" }); }, oauth);
    expect(hit).toBe("https://a/t");
    expect(r!.tokens).toEqual({ access_token: "new", refresh_token: "RT" });
    expect(await refreshCloudOAuth(async () => J(200, {}), { tokenEndpoint: "https://a/t" })).toBeNull();
    expect(await refreshCloudOAuth(async () => J(400, {}), oauth)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/edge/pxOAuth.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// services/edge/src/pxOAuth.ts
// edge 替手机做的那一轮 OAuth（#1430，spec §3.1）。桌面那一轮在 src/main/mcpOAuth.ts，走 SDK + 本机回环回调；
// 这里回调是 edge 自己的 https，所以不用 SDK 的那套「自定义 scheme 被动态注册拒收」的绕法，也不把 SDK 拉进 Worker。
// 只做授权码 + PKCE（S256）+ 动态注册（RFC 7591）这一条路；不支持动态注册的应用明说（v1 不做手填 client，spec §13）。
// 纯函数 + 注入 fetch，全部进根门禁（tests/edge/pxOAuth.test.ts）。

import type { CloudOAuth } from "../../../src/shared/remote/pxCloud.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Random = (n: number) => Uint8Array;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const httpsStr = (v: unknown): v is string => typeof v === "string" && /^https:\/\//.test(v);

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const c of bytes) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<uid>.<32 字节随机 base64url>`。前半段让回调（不带 JWT）找得到那只 DO；后半段才是秘密 */
export function makeState(uid: string, random: Random): string {
  return `${uid}.${b64url(random(32))}`;
}

/** 回调里认 uid。形状不对一律 null——这个值要拿去 getByName，不能让一个随手拼的字符串开出一只新 DO */
export function stateUid(state: string): string | null {
  const i = state.indexOf(".");
  if (i < 0) return null;
  const uid = state.slice(0, i);
  const secret = state.slice(i + 1);
  return UUID_RE.test(uid) && /^[A-Za-z0-9_-]{43}$/.test(secret) ? uid : null;
}

export async function pkcePair(random: Random): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(random(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export interface OAuthMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopes: string[];
}

export type OAuthFail = { ok: false; code: "discovery" | "no_dcr" | "register" | "token"; message: string };

async function getJson(fetchLike: FetchLike, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchLike(url, { method: "GET", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isObj(body) ? body : null;
  } catch {
    return null;
  }
}

/** 厂商报错里最像人话的那一句 */
async function upstreamReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j: unknown = JSON.parse(text);
    if (isObj(j)) {
      for (const k of ["error_description", "message", "error"]) if (typeof j[k] === "string" && j[k]) return j[k] as string;
    }
  } catch { /* 不是 JSON */ }
  return text.slice(0, 200) || `HTTP ${res.status}`;
}

/** RFC 9728 → RFC 8414。9728 先试路径感知的那一格（/.well-known/oauth-protected-resource/<path>），再试根 */
export async function discoverOAuth(fetchLike: FetchLike, resourceUrl: string): Promise<{ ok: true; meta: OAuthMeta } | OAuthFail> {
  const res = new URL(resourceUrl);
  const path = res.pathname === "/" ? "" : res.pathname.replace(/\/$/, "");
  const prm =
    (path ? await getJson(fetchLike, `${res.origin}/.well-known/oauth-protected-resource${path}`) : null) ??
    (await getJson(fetchLike, `${res.origin}/.well-known/oauth-protected-resource`));
  const servers = prm && Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter(httpsStr) : [];
  const issuer = new URL(servers[0] ?? res.origin);
  const ipath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const candidates = [
    ...(ipath ? [`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`] : []),
    `${issuer.origin}/.well-known/oauth-authorization-server`,
    `${issuer.origin}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    const m = await getJson(fetchLike, url);
    if (!m) continue;
    if (!httpsStr(m.authorization_endpoint) || !httpsStr(m.token_endpoint)) continue;
    return {
      ok: true,
      meta: {
        authorizationEndpoint: m.authorization_endpoint,
        tokenEndpoint: m.token_endpoint,
        registrationEndpoint: httpsStr(m.registration_endpoint) ? m.registration_endpoint : null,
        scopes: Array.isArray(m.scopes_supported) ? m.scopes_supported.filter((s): s is string => typeof s === "string") : [],
      },
    };
  }
  return { ok: false, code: "discovery", message: "找不到这个应用的登录服务" };
}

/** RFC 7591。public client（无密钥）：换 token 靠 PKCE，DO 里不存 client_secret */
export async function registerClient(
  fetchLike: FetchLike, meta: OAuthMeta, redirectUri: string
): Promise<{ ok: true; client: Record<string, unknown> & { client_id: string } } | OAuthFail> {
  if (!meta.registrationEndpoint) return { ok: false, code: "no_dcr", message: "不支持动态注册" };
  try {
    const res = await fetchLike(meta.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Mr Otto",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!res.ok) return { ok: false, code: "register", message: await upstreamReason(res) };
    const body: unknown = await res.json();
    if (!isObj(body) || typeof body.client_id !== "string") return { ok: false, code: "register", message: "注册回包里没有 client_id" };
    return { ok: true, client: body as Record<string, unknown> & { client_id: string } };
  } catch (e) {
    return { ok: false, code: "register", message: e instanceof Error ? e.message : String(e) };
  }
}

export function authorizeUrl(o: { meta: OAuthMeta; clientId: string; redirectUri: string; challenge: string; state: string; resource: string }): string {
  const u = new URL(o.meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", o.state);
  u.searchParams.set("resource", o.resource);
  if (o.meta.scopes.length > 0) u.searchParams.set("scope", o.meta.scopes.join(" "));
  return u.toString();
}

export async function exchangeCode(
  fetchLike: FetchLike,
  o: { tokenEndpoint: string; code: string; verifier: string; clientId: string; redirectUri: string; resource: string }
): Promise<{ ok: true; tokens: Record<string, unknown> & { access_token: string } } | OAuthFail> {
  try {
    const res = await fetchLike(o.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: o.code, code_verifier: o.verifier,
        client_id: o.clientId, redirect_uri: o.redirectUri, resource: o.resource,
      }).toString(),
    });
    if (!res.ok) return { ok: false, code: "token", message: await upstreamReason(res) };
    const body: unknown = await res.json();
    if (!isObj(body) || typeof body.access_token !== "string") return { ok: false, code: "token", message: "换回来的没有 access_token" };
    return { ok: true, tokens: body as Record<string, unknown> & { access_token: string } };
  } catch (e) {
    return { ok: false, code: "token", message: e instanceof Error ? e.message : String(e) };
  }
}

/** spec §4：用接入时记下的 tokenEndpoint 续，不再猜 discovery。不轮换 refresh_token 的厂商保留旧的 */
export async function refreshCloudOAuth(fetchLike: FetchLike, oauth: CloudOAuth): Promise<CloudOAuth | null> {
  const refresh = (oauth.tokens as { refresh_token?: unknown } | undefined)?.refresh_token;
  const clientId = (oauth.clientInformation as { client_id?: unknown } | undefined)?.client_id;
  if (typeof refresh !== "string" || typeof clientId !== "string") return null;
  try {
    const res = await fetchLike(oauth.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }).toString(),
    });
    if (!res.ok) return null;
    const tokens: unknown = await res.json();
    if (!isObj(tokens) || typeof tokens.access_token !== "string") return null;
    return { ...oauth, tokens: { ...oauth.tokens, ...tokens } };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/edge/pxOAuth.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/pxOAuth.ts tests/edge/pxOAuth.test.ts
git commit -m "feat(edge): 替手机做 OAuth——发现 9728→8414、动态注册、PKCE、换 token、按记下的端点续期（#1430）"
```

---

### Task 5: DO 里 `cloud_*` 的编排（`pxCloudOps.ts`）

**Files:**
- Create: `services/edge/src/pxCloudOps.ts`
- Test: `tests/edge/pxCloudOps.test.ts`

**Interfaces:**
- Consumes: Task 1 全部箱操作与 `CLOUD_TEXT` / `cloudServerId` / `cloudView`；Task 2 `fillHttpEntry` / `missingParams`；Task 3 `pxMcpListTools`；Task 4 全部；`MCP_CATALOG` / `CatalogEntry`
- Produces:
  - `interface PendingAuth { state: string; uid: string; catalogId: string; url: string; verifier: string; clientInformation: Record<string, unknown> & { client_id: string }; tokenEndpoint: string; exp: number }`
  - `interface CloudStore { getBox(): Promise<CloudBox | null>; putBox(b: CloudBox): Promise<void>; getPending(state: string): Promise<PendingAuth | null>; putPending(p: PendingAuth): Promise<void>; deletePending(state: string): Promise<void>; listPending(): Promise<PendingAuth[]>; getRate(): Promise<number[]>; putRate(ts: number[]): Promise<void>; atomic<T>(fn: () => Promise<T>): Promise<T> }`
  - `interface CloudOpsDeps { store: CloudStore; fetch: FetchLike; now: () => number; random: Random; catalog: readonly CatalogEntry[]; callbackUrl: string; homeIdOf(uid: string): Promise<string | null>; isMember(uid: string, workspaceId: string): Promise<boolean>; log?: (m: string) => void }`
  - `type OpFail = { ok: false; status: number; code: string; message: string }`
  - `cloudConnect(d, uid, req: { catalogId: string; params: Record<string, string> }): Promise<{ ok: true; reply: ConnectReply } | OpFail>`
  - `cloudCallback(d, uid, q: { state: string; code: string | null; error: string | null }): Promise<ConnectDone>`
  - `cloudGrant(d, uid, req: { serverId: string; workspaceId: string; on: boolean }): Promise<{ ok: true } | OpFail>`
  - `cloudRemove(d, serverId: string): Promise<{ ok: true } | OpFail>`
  - `cloudViewOf(d, uid): Promise<CloudViewItem[]>`
  - `cloudRefresh(d, serverId: string): Promise<CloudOAuth | null>`（续不上时写 `needs_login`）
  - 常量 `PENDING_TTL_MS = 600_000`、`PENDING_CAP = 5`、`CONNECT_PER_MIN = 10`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/pxCloudOps.test.ts
import { describe, expect, it } from "vitest";
import {
  cloudCallback, cloudConnect, cloudGrant, cloudRefresh, cloudRemove, cloudViewOf,
  type CloudOpsDeps, type CloudStore, type PendingAuth,
} from "../../services/edge/src/pxCloudOps.js";
import { CLOUD_TEXT, type CloudBox } from "../../src/shared/remote/pxCloud.js";
import type { CatalogEntry } from "../../src/shared/mcpCatalog.js";

const UID = "8f0c6a0e-1111-4222-8333-444455556666";
const HOME = "11111111-1111-1111-1111-111111111111";
const TEAM = "22222222-2222-2222-2222-222222222222";
const J = (status: number, body: unknown, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...h } });

const CATALOG: CatalogEntry[] = [
  { id: "notion", name: "Notion", description: "", transport: "http", url: "https://mcp.notion.com/mcp", params: [], auth: "oauth", authNote: "" },
  { id: "github", name: "GitHub", description: "", transport: "http", url: "https://api.githubcopilot.com/mcp/", params: [{ name: "github_token", description: "", required: true }], auth: "token", authNote: "", headerTemplates: { Authorization: "Bearer {github_token}" } },
  { id: "context7", name: "Context7", description: "", transport: "http", url: "https://mcp.context7.com/mcp", params: [], auth: "none", authNote: "" },
  { id: "local", name: "Local", description: "", transport: "stdio", command: "npx", params: [], auth: "none", authNote: "" },
  { id: "plain", name: "Plain", description: "", transport: "http", url: "http://insecure.example/mcp", params: [], auth: "none", authNote: "" },
];

/** 内存假货。atomic 串行化并记录临界区里有没有打过 fetch（Global Constraints：临界区里不许外呼） */
function memStore() {
  let box: CloudBox | null = null;
  const pending = new Map<string, PendingAuth>();
  let rate: number[] = [];
  let inAtomic = false;
  const store: CloudStore & { inAtomic: () => boolean } = {
    getBox: async () => box, putBox: async (b) => { box = b; },
    getPending: async (s) => pending.get(s) ?? null, putPending: async (p) => { pending.set(p.state, p); },
    deletePending: async (s) => { pending.delete(s); }, listPending: async () => [...pending.values()],
    getRate: async () => rate, putRate: async (r) => { rate = r; },
    atomic: async (fn) => { inAtomic = true; try { return await fn(); } finally { inAtomic = false; } },
    inAtomic: () => inAtomic,
  };
  return { store, peekBox: () => box, pending };
}

/** 假上游：MCP（initialize/tools/list）+ Notion 的 OAuth 全套。临界区里被打到就抛 */
function upstream(store: { inAtomic: () => boolean }, opts: { token401?: boolean; noDcr?: boolean } = {}) {
  const calls: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    if (store.inAtomic()) throw new Error(`临界区里外呼了：${url}`);
    calls.push(url);
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) return J(200, { authorization_servers: ["https://auth.notion.com"] });
    if (url === "https://auth.notion.com/.well-known/oauth-authorization-server") {
      return J(200, { authorization_endpoint: "https://auth.notion.com/a", token_endpoint: "https://auth.notion.com/t", ...(opts.noDcr ? {} : { registration_endpoint: "https://auth.notion.com/r" }) });
    }
    if (url === "https://auth.notion.com/r") return J(201, { client_id: "cid" });
    if (url === "https://auth.notion.com/t") {
      const b = new URLSearchParams(String(init.body));
      return b.get("grant_type") === "refresh_token" ? J(400, { error: "invalid_grant" }) : J(200, { access_token: "AT", refresh_token: "RT" });
    }
    if (url.startsWith("https://")) {
      if (opts.token401) return new Response("", { status: 401 });
      const body = JSON.parse(String(init.body ?? "{}"));
      if (body.method === "initialize") return J(200, { jsonrpc: "2.0", id: 1, result: {} });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return J(200, { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search", description: "", inputSchema: {} }] } });
    }
    return J(404, {});
  };
  return { f, calls };
}

function deps(over: Partial<CloudOpsDeps> = {}) {
  const m = memStore();
  const up = upstream(m.store, {});
  let t = 1_000_000;
  const d: CloudOpsDeps = {
    store: m.store, fetch: up.f, now: () => t, random: (n) => new Uint8Array(n).fill(9),
    catalog: CATALOG, callbackUrl: "https://edge.example/px/v1/cloud/callback",
    homeIdOf: async () => HOME, isMember: async () => true,
    ...over,
  };
  return { d, m, up, tick: (ms: number) => { t += ms; } };
}

describe("cloudConnect：token / 免登录", () => {
  it("token：验过才存，默认主场授权，头按模板代入", async () => {
    const { d, m } = deps();
    const r = await cloudConnect(d, UID, { catalogId: "github", params: { github_token: "ghp_x" } });
    expect(r).toEqual({ ok: true, reply: { kind: "connected", serverId: "cloud-github" } });
    const s = m.peekBox()!.services[0]!;
    expect(s).toMatchObject({ serverId: "cloud-github", catalogId: "github", headers: { Authorization: "Bearer ghp_x" }, status: "ok", grants: [{ workspaceId: HOME, allow: [] }] });
    expect(s.toolDefs.map((t) => t.name)).toEqual(["search"]);
  });
  it("token 401 → 不存，说「token 用不了」", async () => {
    const { d, m } = deps();
    d.fetch = upstream(m.store, { token401: true }).f;
    const r = await cloudConnect(d, UID, { catalogId: "github", params: { github_token: "bad" } });
    expect(r).toMatchObject({ ok: false, message: CLOUD_TEXT.badToken });
    expect(m.peekBox()).toBeNull();
  });
  it("拒：目录外 / stdio / 非 https / 缺必填参数", async () => {
    const { d } = deps();
    expect(await cloudConnect(d, UID, { catalogId: "nope", params: {} })).toMatchObject({ ok: false, status: 404 });
    expect(await cloudConnect(d, UID, { catalogId: "local", params: {} })).toMatchObject({ ok: false, status: 400 });
    expect(await cloudConnect(d, UID, { catalogId: "plain", params: {} })).toMatchObject({ ok: false, status: 400 });
    expect(await cloudConnect(d, UID, { catalogId: "github", params: {} })).toMatchObject({ ok: false, status: 400 });
  });
  it("免登录直接连；主场没建就先不带授权", async () => {
    const { d, m } = deps({ homeIdOf: async () => null });
    expect(await cloudConnect(d, UID, { catalogId: "context7", params: {} })).toMatchObject({ ok: true });
    expect(m.peekBox()!.services[0]!.grants).toEqual([]);
  });
  it("每分钟 10 次", async () => {
    const { d } = deps();
    for (let i = 0; i < 10; i += 1) await cloudConnect(d, UID, { catalogId: "context7", params: {} });
    expect(await cloudConnect(d, UID, { catalogId: "context7", params: {} })).toMatchObject({ ok: false, status: 429, message: CLOUD_TEXT.tooMany });
  });
});

describe("cloudConnect + cloudCallback：浏览器登录", () => {
  it("走完一整轮：pending 一次性，回调换 token 列工具再存", async () => {
    const { d, m } = deps();
    const r = await cloudConnect(d, UID, { catalogId: "notion", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回授权 URL");
    const u = new URL(r.reply.authorizeUrl);
    const state = u.searchParams.get("state")!;
    expect(u.searchParams.get("redirect_uri")).toBe("https://edge.example/px/v1/cloud/callback");
    expect(m.pending.get(state)).toMatchObject({ uid: UID, catalogId: "notion", tokenEndpoint: "https://auth.notion.com/t" });

    const done = await cloudCallback(d, UID, { state, code: "CODE", error: null });
    expect(done).toEqual({ ok: true, serverId: "cloud-notion" });
    expect(m.pending.size).toBe(0);
    expect(m.peekBox()!.services[0]!.oauth).toMatchObject({ tokens: { access_token: "AT" }, clientInformation: { client_id: "cid" }, tokenEndpoint: "https://auth.notion.com/t" });

    expect(await cloudCallback(d, UID, { state, code: "CODE", error: null })).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
  });
  it("过期 / 别人的 state / 厂商回 error", async () => {
    const { d, tick } = deps();
    const r = await cloudConnect(d, UID, { catalogId: "notion", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("x");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    expect(await cloudCallback(d, "99999999-9999-4999-8999-999999999999", { state, code: "C", error: null })).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
    tick(600_001);
    expect(await cloudCallback(d, UID, { state, code: "C", error: null })).toEqual({ ok: false, message: CLOUD_TEXT.stateExpired });
    const r2 = await cloudConnect(d, UID, { catalogId: "notion", params: {} });
    if (!r2.ok || r2.reply.kind !== "authorize") throw new Error("x");
    const s2 = new URL(r2.reply.authorizeUrl).searchParams.get("state")!;
    expect(await cloudCallback(d, UID, { state: s2, code: null, error: "access_denied" })).toEqual({ ok: false, message: "access_denied" });
  });
  it("不支持动态注册 → 明说去电脑上接", async () => {
    const { d, m } = deps();
    d.fetch = upstream(m.store, { noDcr: true }).f;
    expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: false, message: CLOUD_TEXT.noDcr });
  });
  it("pending 封顶 5：先清过期的，仍满就拒", async () => {
    const { d, tick } = deps();
    let n = 0;
    d.random = (len) => new Uint8Array(len).fill(++n % 250);
    for (let i = 0; i < 5; i += 1) expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: true });
    expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: false, status: 429 });
    tick(600_001);
    expect(await cloudConnect(d, UID, { catalogId: "notion", params: {} })).toMatchObject({ ok: true });
  });
});

describe("授权 / 断开 / 视图 / 续期", () => {
  async function connected() {
    const x = deps();
    await cloudConnect(x.d, UID, { catalogId: "context7", params: {} });
    return x;
  }
  it("借给团队要在籍；没这台 404", async () => {
    const x = await connected();
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: true })).toEqual({ ok: true });
    expect(x.m.peekBox()!.services[0]!.grants.map((g) => g.workspaceId)).toEqual([HOME, TEAM]);
    x.d.isMember = async () => false;
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: true })).toMatchObject({ ok: false, status: 403 });
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-nope", workspaceId: TEAM, on: false })).toMatchObject({ ok: false, status: 404 });
  });
  it("关掉不查在籍（被踢出去的人也要能收回）", async () => {
    const x = await connected();
    await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: true });
    x.d.isMember = async () => false;
    expect(await cloudGrant(x.d, UID, { serverId: "cloud-context7", workspaceId: TEAM, on: false })).toEqual({ ok: true });
  });
  it("断开：凭据消失", async () => {
    const x = await connected();
    expect(await cloudRemove(x.d, "cloud-context7")).toEqual({ ok: true });
    expect(x.m.peekBox()!.services).toEqual([]);
  });
  it("视图补上主场授权并落库；无凭据", async () => {
    const x = deps({ homeIdOf: async () => null });
    await cloudConnect(x.d, UID, { catalogId: "github", params: { github_token: "ghp_secret" } });
    x.d.homeIdOf = async () => HOME;
    const v = await cloudViewOf(x.d, UID);
    expect(v[0]!.grants).toEqual([HOME]);
    expect(x.m.peekBox()!.services[0]!.grants).toEqual([{ workspaceId: HOME, allow: [] }]);
    expect(JSON.stringify(v)).not.toContain("ghp_secret");
  });
  it("续期失败 → needs_login", async () => {
    const x = deps();
    const r = await cloudConnect(x.d, UID, { catalogId: "notion", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("x");
    await cloudCallback(x.d, UID, { state: new URL(r.reply.authorizeUrl).searchParams.get("state")!, code: "C", error: null });
    expect(await cloudRefresh(x.d, "cloud-notion")).toBeNull();
    expect(x.m.peekBox()!.services[0]!.status).toBe("needs_login");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/edge/pxCloudOps.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// services/edge/src/pxCloudOps.ts
// Escrow DO 里 `cloud_*` 那几个 op 的编排（#1430，spec §2–§7）。存储、网络、时钟、随机、查库全注入，
// DO 只把自己的 storage 与 fetch 递进来——所以整条流程（含 OAuth 回调与续期）进得了 vitest。
//
// 唯一一条要背下来的纪律（spec §2 / §14）：**外呼在前、读改写在后**。DO 在 `await fetch` 时会处理别的请求，
// 两个应用同时接入、或接入撞上续期，如果读改写跨过一次外呼，后写的整份箱会盖掉先写的。所以每个写 cloud 的
// 地方都是：先把换 token / tools/list 这些网络活干完，再进 `store.atomic` 读出最新的箱改一处写回；临界区里
// 没有 fetch（测试的假上游在临界区里被打到会直接抛）。

import { MCP_CATALOG, type CatalogEntry } from "../../../src/shared/mcpCatalog.js";
import { fillHttpEntry, missingParams } from "../../../src/shared/mcpCatalogFill.js";
import {
  CLOUD_TEXT, cloudServerId, cloudView, emptyCloudBox, ensureHomeGrant, markNeedsLogin, removeCloudService,
  setCloudGrant, upsertCloudService, withCloudOAuth,
  type CloudBox, type CloudOAuth, type CloudServiceInput, type CloudViewItem, type ConnectDone, type ConnectReply,
} from "../../../src/shared/remote/pxCloud.js";
import { WORKSPACE_ID_RE } from "../../../src/shared/remote/pxEscrow.js";
import { pxMcpListTools, type McpConn } from "./px.js";
import {
  authorizeUrl, discoverOAuth, exchangeCode, makeState, pkcePair, refreshCloudOAuth, registerClient, type Random,
} from "./pxOAuth.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const PENDING_TTL_MS = 600_000;
export const PENDING_CAP = 5;
export const CONNECT_PER_MIN = 10;

export interface PendingAuth {
  state: string;
  uid: string;
  catalogId: string;
  url: string;
  verifier: string;
  clientInformation: Record<string, unknown> & { client_id: string };
  tokenEndpoint: string;
  exp: number;
}

export interface CloudStore {
  getBox(): Promise<CloudBox | null>;
  putBox(b: CloudBox): Promise<void>;
  getPending(state: string): Promise<PendingAuth | null>;
  putPending(p: PendingAuth): Promise<void>;
  deletePending(state: string): Promise<void>;
  listPending(): Promise<PendingAuth[]>;
  getRate(): Promise<number[]>;
  putRate(ts: number[]): Promise<void>;
  /** 不含外呼的临界区（DO 里是 blockConcurrencyWhile） */
  atomic<T>(fn: () => Promise<T>): Promise<T>;
}

export interface CloudOpsDeps {
  store: CloudStore;
  fetch: FetchLike;
  now: () => number;
  random: Random;
  /** 缺省 MCP_CATALOG；测试注小表 */
  catalog?: readonly CatalogEntry[];
  callbackUrl: string;
  /** 主场 id：service key 现查（spec §3.4），不信手机报的 */
  homeIdOf(uid: string): Promise<string | null>;
  isMember(uid: string, workspaceId: string): Promise<boolean>;
  log?: (m: string) => void;
}

export type OpFail = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): OpFail => ({ ok: false, status, code, message });

/** 读出箱、改一处、写回——全在临界区里 */
async function mutate(d: CloudOpsDeps, uid: string, fn: (box: CloudBox) => CloudBox | null): Promise<CloudBox | null> {
  return d.store.atomic(async () => {
    const box = (await d.store.getBox()) ?? emptyCloudBox(uid, d.now());
    const next = fn(box);
    if (next && next !== box) await d.store.putBox(next);
    return next;
  });
}

/** 限速 + pending 封顶：一次临界区里判完并记账 */
async function admit(d: CloudOpsDeps): Promise<OpFail | null> {
  return d.store.atomic(async () => {
    const now = d.now();
    const rate = (await d.store.getRate()).filter((t) => t > now - 60_000);
    if (rate.length >= CONNECT_PER_MIN) return fail(429, "rate_limited", CLOUD_TEXT.tooMany);
    await d.store.putRate([...rate, now]);
    return null;
  });
}

function upstreamText(code: string, message: string): string {
  return code === "upstream_auth" ? CLOUD_TEXT.badToken : `没接上：${message}`;
}

export async function cloudConnect(
  d: CloudOpsDeps, uid: string, req: { catalogId: string; params: Record<string, string> }
): Promise<{ ok: true; reply: ConnectReply } | OpFail> {
  const entry = (d.catalog ?? MCP_CATALOG).find((e) => e.id === req.catalogId);
  if (!entry) return fail(404, "unknown_app", "目录里没有这个应用");
  if (entry.transport !== "http") return fail(400, "not_http", "这个应用要跑在电脑上，手机上接不了");
  const missing = missingParams(entry, req.params);
  if (missing.length > 0) return fail(400, "missing_params", `还缺：${missing.join("、")}`);
  const { url, headers } = fillHttpEntry(entry, req.params);
  if (!/^https:\/\//.test(url) || /\{\w+\}/.test(url)) return fail(400, "bad_url", "这个应用的地址不是 https，不能在云端接");
  const limited = await admit(d);
  if (limited) return limited;
  const serverId = cloudServerId(entry.id);

  if (entry.auth !== "oauth") {
    const conn: McpConn = { url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
    const listed = await pxMcpListTools(d.fetch, conn);
    if (!listed.ok) {
      d.log?.(`[px-cloud] connect ${serverId} ${listed.code}: ${listed.message}`);
      return fail(listed.code === "upstream_auth" ? 400 : 502, listed.code, upstreamText(listed.code, listed.message));
    }
    const homeId = await d.homeIdOf(uid);
    const svc: CloudServiceInput = { serverId, catalogId: entry.id, url, ...(conn.headers ? { headers: conn.headers } : {}), toolDefs: listed.toolDefs };
    await mutate(d, uid, (box) => upsertCloudService(box, svc, homeId, d.now()));
    return { ok: true, reply: { kind: "connected", serverId } };
  }

  // 浏览器登录：外呼（发现 + 注册）全部在前，最后才进临界区记 pending
  const disc = await discoverOAuth(d.fetch, url);
  if (!disc.ok) return fail(502, disc.code, `没接上：${disc.message}`);
  const reg = await registerClient(d.fetch, disc.meta, d.callbackUrl);
  if (!reg.ok) {
    d.log?.(`[px-cloud] register ${serverId} ${reg.code}: ${reg.message}`);
    return fail(reg.code === "no_dcr" ? 422 : 502, reg.code, reg.code === "no_dcr" ? CLOUD_TEXT.noDcr : `没接上：${reg.message}`);
  }
  const state = makeState(uid, d.random);
  const { verifier, challenge } = await pkcePair(d.random);
  const pending: PendingAuth = {
    state, uid, catalogId: entry.id, url, verifier,
    clientInformation: reg.client, tokenEndpoint: disc.meta.tokenEndpoint, exp: d.now() + PENDING_TTL_MS,
  };
  const full = await d.store.atomic(async () => {
    const now = d.now();
    const live: PendingAuth[] = [];
    for (const p of await d.store.listPending()) {
      if (p.exp <= now) await d.store.deletePending(p.state);
      else live.push(p);
    }
    if (live.length >= PENDING_CAP) return true;
    await d.store.putPending(pending);
    return false;
  });
  if (full) return fail(429, "too_many_pending", CLOUD_TEXT.tooMany);
  return {
    ok: true,
    reply: {
      kind: "authorize",
      authorizeUrl: authorizeUrl({ meta: disc.meta, clientId: reg.client.client_id, redirectUri: d.callbackUrl, challenge, state, resource: url }),
    },
  };
}

export async function cloudCallback(
  d: CloudOpsDeps, uid: string, q: { state: string; code: string | null; error: string | null }
): Promise<ConnectDone> {
  // 查到即删（一次性）：先在临界区里摘下来，之后换 token 失败也不许重放
  const pending = await d.store.atomic(async () => {
    const p = await d.store.getPending(q.state);
    if (p) await d.store.deletePending(q.state);
    return p;
  });
  if (!pending || pending.uid !== uid || pending.exp <= d.now()) return { ok: false, message: CLOUD_TEXT.stateExpired };
  if (q.error) return { ok: false, message: q.error };
  if (!q.code) return { ok: false, message: CLOUD_TEXT.unknown };

  const tok = await exchangeCode(d.fetch, {
    tokenEndpoint: pending.tokenEndpoint, code: q.code, verifier: pending.verifier,
    clientId: pending.clientInformation.client_id, redirectUri: d.callbackUrl, resource: pending.url,
  });
  if (!tok.ok) return { ok: false, message: `没接上：${tok.message}` };
  const listed = await pxMcpListTools(d.fetch, { url: pending.url, accessToken: tok.tokens.access_token });
  if (!listed.ok) return { ok: false, message: `登录成功，但读不到它的工具：${listed.message}` };
  const homeId = await d.homeIdOf(uid);
  const serverId = cloudServerId(pending.catalogId);
  const oauth: CloudOAuth = { tokens: tok.tokens, clientInformation: pending.clientInformation, tokenEndpoint: pending.tokenEndpoint };
  await mutate(d, uid, (box) => upsertCloudService(box, { serverId, catalogId: pending.catalogId, url: pending.url, oauth, toolDefs: listed.toolDefs }, homeId, d.now()));
  return { ok: true, serverId };
}

export async function cloudGrant(
  d: CloudOpsDeps, uid: string, req: { serverId: string; workspaceId: string; on: boolean }
): Promise<{ ok: true } | OpFail> {
  if (!WORKSPACE_ID_RE.test(req.workspaceId)) return fail(400, "bad_request", "团队 id 形状不对");
  // 打开要在籍；关掉不查（被踢出去的人也要收得回自己的授权）
  if (req.on && !(await d.isMember(uid, req.workspaceId))) return fail(403, "not_member", "你不在这个团队里");
  let found = true;
  await mutate(d, uid, (box) => {
    const next = setCloudGrant(box, req.serverId, req.workspaceId, req.on, d.now());
    if (!next) found = false;
    return next;
  });
  return found ? { ok: true } : fail(404, "not_found", "手机上没接这个应用");
}

export async function cloudRemove(d: CloudOpsDeps, serverId: string): Promise<{ ok: true } | OpFail> {
  let found = false;
  await d.store.atomic(async () => {
    const box = await d.store.getBox();
    if (!box || !box.services.some((s) => s.serverId === serverId)) return;
    found = true;
    await d.store.putBox(removeCloudService(box, serverId, d.now()));
  });
  return found ? { ok: true } : fail(404, "not_found", "手机上没接这个应用");
}

export async function cloudViewOf(d: CloudOpsDeps, uid: string): Promise<CloudViewItem[]> {
  const box = await d.store.getBox();
  if (!box || box.services.every((s) => s.grants.length > 0)) return cloudView(box);
  const homeId = await d.homeIdOf(uid);
  if (!homeId) return cloudView(box);
  const next = await mutate(d, uid, (b) => ensureHomeGrant(b, homeId, d.now()));
  return cloudView(next);
}

/** /call 遇上游 401 时调（spec §4）：续上就写回并回新凭据；续不上标 needs_login 回 null */
export async function cloudRefresh(d: CloudOpsDeps, serverId: string): Promise<CloudOAuth | null> {
  const box = await d.store.getBox();
  const svc = box?.services.find((s) => s.serverId === serverId);
  if (!box || !svc?.oauth) return null;
  const oauth = await refreshCloudOAuth(d.fetch, svc.oauth);
  await d.store.atomic(async () => {
    const cur = await d.store.getBox();
    if (!cur || !cur.services.some((s) => s.serverId === serverId)) return;
    await d.store.putBox(oauth ? withCloudOAuth(cur, serverId, oauth, d.now()) : markNeedsLogin(cur, serverId, d.now()));
  });
  return oauth;
}
```

注意 `CloudServiceInput` 里 `headers` 是可选键：`exactOptionalPropertyTypes` 下要用条件展开，不要写 `headers: undefined`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/edge/pxCloudOps.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/pxCloudOps.ts tests/edge/pxCloudOps.test.ts
git commit -m "feat(edge): 云端连接器的接入 / 回调 / 借给团队 / 断开 / 续期编排（#1430）

存储与网络全注入，DO 只剩接线。外呼在前、读改写在后，临界区里打 fetch 的话测试的假上游当场抛。
打开团队授权要在籍、关掉不查：被踢出去的人也要收得回自己的授权。"
```

---

### Task 6: edge 路由（`edge.ts`）

**Files:**
- Modify: `services/edge/src/edge.ts`（`px()` 里、`pxIdentify` 之前加回调分支；之后加其余四个）
- Test: `tests/edge/pxCloudRoutes.test.ts`

**Interfaces:**
- Consumes: `stateUid` (Task 4)、`connectDoneUrl` / `CLOUD_TEXT` (Task 1)
- Produces（DO 内部 op 名，Task 7 照这个接）：
  - `cloud_connect {uid, catalogId, params}` → `200 ConnectReply` 或错误
  - `cloud_callback {uid, state, code, error}` → `200 ConnectDone`
  - `cloud_view {uid}` → `200 {apps: CloudViewItem[]}`
  - `cloud_grant {uid, serverId, workspaceId, on}` → `200 {ok:true}` 或错误
  - `cloud_remove {serverId}` → `200 {ok:true}` 或错误

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/pxCloudRoutes.test.ts
import { describe, expect, it } from "vitest";
import { createEdge, type EdgeConfig, type RelayStub } from "../../services/edge/src/edge.js";
import { signTestJwt } from "./jwtTestUtil.js";

const SECRET = "test-secret-test-secret-test-secret!";
const config: EdgeConfig = { jwtSecret: SECRET, runtimeSecret: "rt-secret" };
const UID = "8f0c6a0e-1111-4222-8333-444455556666";
const STATE = `${UID}.${"A".repeat(43)}`;

function fakeEscrow(reply: unknown = { ok: true }) {
  const calls: { hostUid: string; op: string; body: any }[] = [];
  const stub = (hostUid: string): RelayStub => ({
    fetch: async (req: Request) => {
      calls.push({ hostUid, op: new URL(req.url).pathname.slice(1), body: await req.json() });
      return new Response(JSON.stringify(reply), { status: 200 });
    },
  });
  return { calls, stub };
}
const auth = async () => ({ authorization: `Bearer ${await signTestJwt(SECRET, { sub: UID, email: "x@y.z", exp: Math.floor(Date.now() / 1000) + 600 })}` });

describe("/px/v1/cloud 路由", () => {
  it("connect：带 uid 转发到自己的箱；参数只收字符串", async () => {
    const { calls, stub } = fakeEscrow({ kind: "connected", serverId: "cloud-context7" });
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    const ok = await h(new Request("https://e/px/v1/cloud/connect", { method: "POST", headers: await auth(), body: JSON.stringify({ catalogId: "context7", params: { a: "1" } }) }));
    expect(ok.status).toBe(200);
    expect(calls[0]).toEqual({ hostUid: UID, op: "cloud_connect", body: { uid: UID, catalogId: "context7", params: { a: "1" } } });
    const bad = await h(new Request("https://e/px/v1/cloud/connect", { method: "POST", headers: await auth(), body: JSON.stringify({ catalogId: "x", params: { a: 1 } }) }));
    expect(bad.status).toBe(400);
  });
  it("平台身份一律 403", async () => {
    const { stub } = fakeEscrow();
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    const r = await h(new Request("https://e/px/v1/cloud", { headers: { "x-runtime-secret": "rt-secret" } }));
    expect(r.status).toBe(403);
  });
  it("callback 不要 JWT；按 state 前半段找箱；302 到深链", async () => {
    const { calls, stub } = fakeEscrow({ ok: true, serverId: "cloud-notion" });
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    const r = await h(new Request(`https://e/px/v1/cloud/callback?code=C&state=${encodeURIComponent(STATE)}`));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("mrotto://connector-done?ok=1&serverId=cloud-notion");
    expect(calls[0]).toEqual({ hostUid: UID, op: "cloud_callback", body: { uid: UID, state: STATE, code: "C", error: null } });
  });
  it("callback 的 state 形状不对：不碰任何箱，302 带「超时」", async () => {
    const { calls, stub } = fakeEscrow();
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    const r = await h(new Request("https://e/px/v1/cloud/callback?code=C&state=junk"));
    expect(r.status).toBe(302);
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("ok=0");
    expect(calls).toEqual([]);
  });
  it("view / grant / remove", async () => {
    const { calls, stub } = fakeEscrow({ apps: [] });
    const h = createEdge({ config, escrow: stub, isFriend: async () => false });
    expect((await h(new Request("https://e/px/v1/cloud", { headers: await auth() }))).status).toBe(200);
    await h(new Request("https://e/px/v1/cloud/grant", { method: "POST", headers: await auth(), body: JSON.stringify({ serverId: "cloud-x", workspaceId: "22222222-2222-2222-2222-222222222222", on: true }) }));
    await h(new Request("https://e/px/v1/cloud/cloud-x", { method: "DELETE", headers: await auth() }));
    expect(calls.map((c) => c.op)).toEqual(["cloud_view", "cloud_grant", "cloud_remove"]);
    expect(calls[1]!.body).toEqual({ uid: UID, serverId: "cloud-x", workspaceId: "22222222-2222-2222-2222-222222222222", on: true });
    expect(calls[2]!.body).toEqual({ serverId: "cloud-x" });
    const badGrant = await h(new Request("https://e/px/v1/cloud/grant", { method: "POST", headers: await auth(), body: JSON.stringify({ serverId: "cloud-x", workspaceId: "w", on: "yes" }) }));
    expect(badGrant.status).toBe(400);
    const badDel = await h(new Request("https://e/px/v1/cloud/notion", { method: "DELETE", headers: await auth() }));
    expect(badDel.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/edge/pxCloudRoutes.test.ts`
Expected: FAIL（404 / 401）

- [ ] **Step 3: 实现**

`edge.ts` 头部 import 追加：

```ts
import { stateUid } from "./pxOAuth.js";
import { CLOUD_TEXT, connectDoneUrl, isCloudServerId, toConnectDone, type ConnectDone } from "../../../src/shared/remote/pxCloud.js";
```

`px()` 里，`const who = await pxIdentify(req);` **之前**插入：

```ts
    // 厂商登录完回跳这里（spec §3.1 第 4 步）：浏览器裸访问，**不带 JWT**。身份由 state 的前半段 + DO 里那条
    // 一次性 pending 共同给出——前半段只用来找到那只 DO，DO 查不到 / 过期 / 用过一律拒
    if (pathname === "/px/v1/cloud/callback" && req.method === "GET") {
      const q = new URL(req.url).searchParams;
      const state = q.get("state") ?? "";
      const uid = stateUid(state);
      let done: ConnectDone = { ok: false, message: CLOUD_TEXT.stateExpired };
      if (uid !== null) {
        const res = await deps.escrow!(uid).fetch(new Request("https://px/cloud_callback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uid, state, code: q.get("code"), error: q.get("error_description") ?? q.get("error") }),
        })).catch(() => null);
        done = toConnectDone(res ? await res.json().catch(() => null) : null);
      }
      return new Response(null, { status: 302, headers: { location: connectDoneUrl(done), "cache-control": "no-store" } });
    }
```

`/px/v1/audit` 分支之后、`404` 之前插入：

```ts
    if (pathname === "/px/v1/cloud" || pathname.startsWith("/px/v1/cloud/")) {
      // 云端连接器只归真人：平台身份替谁接应用都说不通
      if (who.userId === RUNTIME_SERVICE_UID) return apiError(403, "平台身份不能管理云端连接器", "forbidden");
      const uid = who.userId;
      if (pathname === "/px/v1/cloud" && req.method === "GET") return forward(uid, "cloud_view", { uid });
      if (pathname === "/px/v1/cloud/connect" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as { catalogId?: unknown; params?: unknown } | null;
        const params = b?.params ?? {};
        const okParams = typeof params === "object" && params !== null && !Array.isArray(params) &&
          Object.values(params).every((v) => typeof v === "string" && v.length <= 4096) && Object.keys(params).length <= 16;
        if (!b || typeof b.catalogId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(b.catalogId) || !okParams) {
          return apiError(400, "connect 要 catalogId 与字符串参数", "bad_request");
        }
        return forward(uid, "cloud_connect", { uid, catalogId: b.catalogId, params });
      }
      if (pathname === "/px/v1/cloud/grant" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as { serverId?: unknown; workspaceId?: unknown; on?: unknown } | null;
        if (!b || typeof b.serverId !== "string" || !isCloudServerId(b.serverId) || typeof b.workspaceId !== "string" || typeof b.on !== "boolean") {
          return apiError(400, "grant 要 serverId / workspaceId / on", "bad_request");
        }
        return forward(uid, "cloud_grant", { uid, serverId: b.serverId, workspaceId: b.workspaceId, on: b.on });
      }
      if (req.method === "DELETE") {
        const serverId = decodeURIComponent(pathname.slice("/px/v1/cloud/".length));
        if (!isCloudServerId(serverId)) return apiError(400, "只能断开手机上接的应用", "bad_request");
        return forward(uid, "cloud_remove", { serverId });
      }
      return apiError(404, `没有这个端点:${pathname}`, "not_found");
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/edge/pxCloudRoutes.test.ts tests/edge/pxRoutes.test.ts tests/edge/edge.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/edge.ts tests/edge/pxCloudRoutes.test.ts src/shared/remote/pxCloud.ts tests/shared/remote/pxCloud.test.ts
git commit -m "feat(edge): /px/v1/cloud* 路由；回调免 JWT、按 state 找箱、302 回 App（#1430）"
```

---

### Task 7: Escrow DO 接线（`worker.ts`）

**Files:**
- Modify: `services/edge/src/worker.ts`（`Escrow` 类）
- Test: `tests/edge/pxCloudWiring.test.ts`（读源码断言）

**Interfaces:**
- Consumes: Task 1 `mergeEscrow` / `cloudNeedsLogin` / `parseCloudBox` / `CLOUD_TEXT`；Task 3 `sealJson` / `openJson`；Task 5 全部 op；`edgeBaseUrl` from `src/shared/edgeConfig.ts`
- Produces: DO 的 `cloud_*` op；`grants` / `call` 走合并视图

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/pxCloudWiring.test.ts
// worker.ts 进不了 vitest（要 cloudflare:workers），这几条接线的失败全是静默的——
// 读源码钉住（同 ADR-0305 / 0308 的做法）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/edge/src/worker.ts", import.meta.url), "utf8");
const escrow = src.slice(src.indexOf("export class Escrow"), src.indexOf("function supa("));

describe("Escrow DO 接线", () => {
  it("grants 与 call 都过合并视图，不再只读 sealed", () => {
    const grants = escrow.slice(escrow.indexOf('op === "grants"'), escrow.indexOf('op === "audit"'));
    const call = escrow.slice(escrow.indexOf('op === "call"'));
    expect(grants).toMatch(/this\.merged\(\)/);
    expect(call).toMatch(/this\.merged\(\)/);
  });
  it("桌面的 put / delete 只碰 sealed，不碰 cloud", () => {
    const put = escrow.slice(escrow.indexOf('op === "put"'), escrow.indexOf('op === "grants"'));
    expect(put).not.toMatch(/"cloud"/);
    expect(put).toMatch(/storage\.delete\("sealed"\)/);
  });
  it("cloud 那台 401 走 cloudRefresh，不走猜 discovery 的 pxRefreshTokens", () => {
    const call = escrow.slice(escrow.indexOf('op === "call"'));
    expect(call).toMatch(/isCloudServerId\(serverId\)[\s\S]*cloudRefresh\(/);
  });
  it("atomic 用 blockConcurrencyWhile", () => {
    expect(escrow).toMatch(/atomic:\s*\(fn\)\s*=>\s*this\.ctx\.blockConcurrencyWhile\(fn\)/);
  });
  it("五个 cloud op 都接上了", () => {
    for (const op of ["cloud_connect", "cloud_callback", "cloud_view", "cloud_grant", "cloud_remove"]) {
      expect(escrow).toContain(`op === "${op}"`);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/edge/pxCloudWiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`worker.ts` import 追加：

```ts
import { openJson, sealJson } from "./px.js";
import { cloudCallback, cloudConnect, cloudGrant, cloudRefresh, cloudRemove, cloudViewOf, type CloudOpsDeps, type PendingAuth } from "./pxCloudOps.js";
import { CLOUD_TEXT, cloudNeedsLogin, isCloudServerId, mergeEscrow, parseCloudBox, type CloudBox } from "../../../src/shared/remote/pxCloud.js";
import { edgeBaseUrl } from "../../../src/shared/edgeConfig.js";
```

`Escrow` 类的头注 storage 那一行改成：``storage：`sealed`（桌面的 EscrowDoc）、`cloud`（手机上接的 CloudBox，#1430）、`pending:<state>`（未完成的授权）、`cloudRate`、`audit`。两个封存键各一个写者``。类里加：

```ts
  private async cloudBox(): Promise<CloudBox | null> {
    const s = await this.ctx.storage.get<string>("cloud");
    return s ? parseCloudBox(await openJson(this.env.ESCROW_KEY, s)) : null;
  }

  /** grants / call 看到的那一份：sealed + cloud 摊平（spec §5） */
  private async merged(): Promise<EscrowDoc | null> {
    return mergeEscrow(await this.doc(), await this.cloudBox());
  }

  private cloudDeps(): CloudOpsDeps {
    const st = this.ctx.storage;
    const key = this.env.ESCROW_KEY;
    const supaHeaders = { apikey: this.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${this.env.SUPABASE_SERVICE_KEY}` };
    const rest = `${this.env.SUPABASE_URL}/rest/v1`;
    return {
      store: {
        getBox: () => this.cloudBox(),
        putBox: async (b) => { await st.put("cloud", await sealJson(key, b)); },
        getPending: async (s) => {
          const v = await st.get<string>(`pending:${s}`);
          return v ? ((await openJson(key, v)) as PendingAuth | null) : null;
        },
        putPending: async (p) => { await st.put(`pending:${p.state}`, await sealJson(key, p)); },
        deletePending: async (s) => { await st.delete(`pending:${s}`); },
        listPending: async () => {
          const out: PendingAuth[] = [];
          for (const v of (await st.list<string>({ prefix: "pending:" })).values()) {
            const p = (await openJson(key, v)) as PendingAuth | null;
            if (p) out.push(p);
          }
          return out;
        },
        getRate: async () => (await st.get<number[]>("cloudRate")) ?? [],
        putRate: async (ts) => { await st.put("cloudRate", ts); },
        atomic: (fn) => this.ctx.blockConcurrencyWhile(fn),
      },
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      callbackUrl: `${edgeBaseUrl({} as never)}/px/v1/cloud/callback`,
      homeIdOf: async (uid) => {
        const res = await fetch(`${rest}/workspaces?select=id&owner_uid=eq.${encodeURIComponent(uid)}&kind=eq.home&limit=1`, { headers: supaHeaders });
        if (!res.ok) return null;
        const rows: unknown = await res.json();
        const id = Array.isArray(rows) ? (rows[0] as { id?: unknown } | undefined)?.id : undefined;
        return typeof id === "string" ? id : null;
      },
      isMember: async (uid, workspaceId) => {
        const res = await fetch(`${rest}/${membershipQuery([workspaceId], uid, uid)}`, { headers: supaHeaders });
        return res.ok && parseMembershipRows(await res.json(), uid, uid).has(workspaceId);
      },
      log: (m) => console.log(m),
    };
  }
```

`fetch()` 里：

- `grants` 分支：`const doc = await this.doc();` → `const doc = await this.merged();`
- `call` 分支：`const doc = await this.doc();` → `const doc = await this.merged();`；gate 失败时如果 `isCloudServerId(serverId) && cloudNeedsLogin(await this.cloudBox(), serverId)`，把回包换成 `json(409, { error: { message: CLOUD_TEXT.needsLogin, type: "otto_edge", code: "needs_login" } })`（审计照记，note 用 `CLOUD_TEXT.needsLogin`）；401 刷新那段改成：

```ts
      if (!r.ok && r.code === "upstream_auth") {
        if (isCloudServerId(serverId)) {
          // 手机上接的只有 edge 续（spec §4）：用记下的 tokenEndpoint；续不上 cloudRefresh 自己标 needs_login
          const oauth = await cloudRefresh(this.cloudDeps(), serverId);
          if (oauth) {
            r = await pxMcpCall(fetchLike, { ...gate.service, oauth: { ...(oauth.tokens ? { tokens: oauth.tokens } : {}), ...(oauth.clientInformation ? { clientInformation: oauth.clientInformation } : {}) } }, tool, b.args);
          } else {
            r = { ok: false, status: 409, code: "needs_login", message: CLOUD_TEXT.needsLogin };
          }
        } else {
          // 桌面那只箱：原来的兜底自刷，只写 sealed
          const sealedDoc = await this.doc();
          const oauth = await pxRefreshTokens(fetchLike, gate.service);
          if (oauth && sealedDoc) {
            const updated: EscrowDoc = {
              ...sealedDoc,
              services: sealedDoc.services.map((s) => (s.serverId === serverId ? { ...s, oauth } : s)),
              updatedTs: Date.now(),
            };
            await this.ctx.storage.put("sealed", await sealEscrow(this.env.ESCROW_KEY, updated));
            r = await pxMcpCall(fetchLike, { ...gate.service, oauth }, tool, b.args);
          }
        }
      }
```

（写回 sealed 必须从 `this.doc()` 读——`merged()` 里掺着 cloud 的服务，拿它写回 sealed 就是把手机的凭据抄进桌面那只箱。）

`openJson, sealJson` 追加进文件头已有的 `from "./px.js"` 那条 import，不另起一行。

- 错误回包那句 `r.code === "upstream_auth" ? "托管凭据已失效——让对方上线重新授权一次" : r.message` 保持不变（needs_login 已单独带着 message）。
- 在 `return json(404, …没有这个内部操作…)` 之前加五个 op：

```ts
    if (op.startsWith("cloud_")) {
      const d = this.cloudDeps();
      const uid = typeof b.uid === "string" ? b.uid : "";
      const toRes = (r: { ok: true } | { ok: false; status: number; code: string; message: string }, okBody: unknown) =>
        r.ok ? json(200, okBody) : json(r.status, { error: { message: r.message, type: "otto_edge", code: r.code } });
      if (op === "cloud_view") return json(200, { apps: await cloudViewOf(d, uid) });
      if (op === "cloud_connect") {
        const params = (b.params ?? {}) as Record<string, string>;
        const r = await cloudConnect(d, uid, { catalogId: String(b.catalogId ?? ""), params });
        return r.ok ? json(200, r.reply) : toRes(r, null);
      }
      if (op === "cloud_callback") {
        return json(200, await cloudCallback(d, uid, {
          state: String(b.state ?? ""),
          code: typeof b.code === "string" ? b.code : null,
          error: typeof b.error === "string" ? b.error : null,
        }));
      }
      if (op === "cloud_grant") {
        const r = await cloudGrant(d, uid, { serverId: String(b.serverId ?? ""), workspaceId: String(b.workspaceId ?? ""), on: b.on === true });
        return toRes(r, { ok: true });
      }
      if (op === "cloud_remove") return toRes(await cloudRemove(d, String(b.serverId ?? "")), { ok: true });
    }
```

- `put` / `delete` 两个分支**一个字不改**。
- `cloud_callback` 回包是 `ConnectDone`（`{ok:true, serverId}` / `{ok:false, message}`），Task 6 的回调分支按这个形状读。

- [ ] **Step 4: 跑测试与 worker 的 tsc**

Run: `npx vitest run tests/edge/pxCloudWiring.test.ts && npx tsc -p services/edge/tsconfig.json`
Expected: PASS，tsc 无错

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/worker.ts tests/edge/pxCloudWiring.test.ts
git commit -m "feat(edge): Escrow DO 接上云端连接器；grants/call 过 sealed+cloud 合并视图（#1430）

cloud 那台 401 只由 edge 用记下的 tokenEndpoint 续，续不上标 needs_login 回 409；桌面那只箱的兜底自刷
只从 sealed 读、只写 sealed——拿合并视图写回会把手机的凭据抄进桌面的箱。"
```

---

### Task 8: runtime 工具名封顶 64（`pxTools.ts`）

**Files:**
- Modify: `services/runtime/src/pxTools.ts:82-84,130`
- Test: `tests/runtime/pxTools.test.ts`（追加；文件不存在就新建）

**Interfaces:**
- Consumes: `fnv1a` from `src/shared/fnv1a.ts`
- Produces: `PX_TOOL_NAME_MAX = 64`、`pxToolName(hostUid: string, serverId: string, tool: string): string`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/runtime/pxTools.test.ts（追加）
import { describe, expect, it } from "vitest";
import { PX_TOOL_NAME_MAX, pxToolName } from "../../services/runtime/src/pxTools.js";

describe("pxToolName", () => {
  it("短的原样（safe 化）", () => {
    expect(pxToolName("abcdef12-xxxx", "cloud-notion", "search")).toBe("px_abcdef12_cloud-notion_search");
  });
  it("超长截到 64 并带哈希尾，不同原名不撞", () => {
    const a = pxToolName("abcdef12-xxxx", "cloud-google-analytics", "run_realtime_report_with_dimensions_and_metrics");
    const b = pxToolName("abcdef12-xxxx", "cloud-google-analytics", "run_realtime_report_with_dimensions_and_metricz");
    expect(a.length).toBeLessThanOrEqual(PX_TOOL_NAME_MAX);
    expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(pxToolName("abcdef12-xxxx", "cloud-google-analytics", "run_realtime_report_with_dimensions_and_metrics")).toBe(a);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/runtime/pxTools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
import { fnv1a } from "../../../src/shared/fnv1a.js";

/** 模型厂商的工具名上限（OpenAI 兼容口径 `^[a-zA-Z0-9_-]{1,64}$`）。超了不是少一把刀，是**整次请求**被拒、
    这一轮直接失败——手机上接的应用 serverId 多了 `cloud-` 六个字符，撞上的概率变大（#1430） */
export const PX_TOOL_NAME_MAX = 64;

/** 截断时尾巴挂原名的哈希：同一个原名永远同一个结果（审批记忆按完整工具名记），不同原名极难撞 */
export function pxToolName(hostUid: string, serverId: string, tool: string): string {
  const raw = safeName(`px_${hostUid.slice(0, 8)}_${serverId}_${tool}`);
  if (raw.length <= PX_TOOL_NAME_MAX) return raw;
  const tail = fnv1a(raw).toString(36);
  return `${raw.slice(0, PX_TOOL_NAME_MAX - tail.length - 1)}_${tail}`;
}
```

`buildPxTools` 里 `const name = safeName(\`px_${...}\`)` 换成 `const name = pxToolName(g.hostUid, g.serverId, t.name);`。截断时撞名自诊断那段原样生效（它比的是截断后的名字）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/runtime/pxTools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add services/runtime/src/pxTools.ts tests/runtime/pxTools.test.ts
git commit -m "fix(runtime): 代理工具名封顶 64，超长截断挂哈希尾（#1430）

超过 64 的工具名会让整次模型请求被拒；手机接的应用 serverId 多了 cloud- 前缀更容易撞上。要重新部署 runtime。"
```

---

### Task 9: 桌面认出 `cloud-` 行（撤回走 edge、标「手机上接的」）

**Files:**
- Modify: `src/shared/workspaceView.ts`（`ConnectorCloudState`、`ConnectorRowView`、`cloudStateOf`、`connectorRows`）
- Create: `src/main/pxCloudGrant.ts`
- Modify: `src/main/workspaceManager.ts`（deps 类型 + `withdrawConnector`）
- Modify: `src/main/index.ts:1655-1684`（接 `cloudGrant`）
- Modify: `src/renderer/src/components/WorkspaceConnectorsTab.tsx`
- Test: `tests/shared/workspaceView.test.ts`（追加）、`tests/main/pxCloudGrant.test.ts`、`tests/main/workspaceManager.test.ts`（追加）

**Interfaces:**
- Consumes: `isCloudServerId` (Task 1)、`parseCloudError` (Task 1)
- Produces:
  - `ConnectorCloudState = "ready" | "unknown" | "off" | "phone"`；`ConnectorRowView.origin: "desktop" | "phone"`
  - `createPxCloudGrant(deps: { baseUrl: () => string; accessToken: () => Promise<string | null>; fetchImpl?: typeof fetch }): (workspaceId: string, serverId: string, on: boolean) => Promise<void>`
  - `WorkspaceManagerDeps.cloudGrant(workspaceId: string, serverId: string, on: boolean): Promise<void>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/workspaceView.test.ts（追加）
it("cloud- 行：origin phone、状态 phone（不拿桌面箱清单判）", () => {
  const ws = { ...baseWs, connectors: [{ hostUid: "me", serverId: "cloud-notion", label: "Notion", tools: [] }] };
  const [row] = connectorRows(ws, "me", ["linear"]);
  expect(row).toMatchObject({ origin: "phone", cloudState: "phone", mine: true });
});
```

（`baseWs` 用该文件已有的快照工厂；没有就照 `WorkspaceSnapshot` 造一个最小对象。）

```ts
// tests/main/pxCloudGrant.test.ts
import { describe, expect, it } from "vitest";
import { createPxCloudGrant } from "../../src/main/pxCloudGrant.js";

describe("createPxCloudGrant", () => {
  it("带 JWT POST；非 2xx 抛 edge 的原话", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = createPxCloudGrant({
      baseUrl: () => "https://e", accessToken: async () => "jwt",
      fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); }) as typeof fetch,
    });
    await ok("ws", "cloud-x", false);
    expect(seen[0]!.url).toBe("https://e/px/v1/cloud/grant");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ serverId: "cloud-x", workspaceId: "ws", on: false });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer jwt");
    const bad = createPxCloudGrant({
      baseUrl: () => "https://e", accessToken: async () => "jwt",
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "你不在这个团队里", type: "otto_edge", code: "not_member" } }), { status: 403 })) as typeof fetch,
    });
    await expect(bad("ws", "cloud-x", true)).rejects.toThrow("你不在这个团队里");
    const noAuth = createPxCloudGrant({ baseUrl: () => "https://e", accessToken: async () => null });
    await expect(noAuth("ws", "cloud-x", false)).rejects.toThrow("还没登录");
  });
});
```

```ts
// tests/main/workspaceManager.test.ts（追加；用该文件已有的 makeDeps 工厂）
it("撤回 cloud- 行：先撤云端授权再删目录行，本机台账不动", async () => {
  const order: string[] = [];
  const deps = makeDeps({
    cloudGrant: async (ws, sid, on) => { order.push(`grant:${ws}:${sid}:${on}`); },
    deleteConnectorRow: async () => { order.push("row"); },
    saveStore: () => { order.push("store"); },
    resyncEscrow: () => { order.push("resync"); },
  });
  const mgr = createWorkspaceManager(deps);
  await mgr.withdrawConnector("ws1", "cloud-notion");
  expect(order).toEqual(["grant:ws1:cloud-notion:false", "row"]);
});
it("撤回 cloud- 行：云端授权撤不掉就不删目录行（不留暗门）", async () => {
  const order: string[] = [];
  const deps = makeDeps({
    cloudGrant: async () => { throw new Error("连不上"); },
    deleteConnectorRow: async () => { order.push("row"); },
  });
  const r = await createWorkspaceManager(deps).withdrawConnector("ws1", "cloud-notion");
  expect(r.ok).toBe(false);
  expect(order).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/workspaceView.test.ts tests/main/pxCloudGrant.test.ts tests/main/workspaceManager.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/shared/workspaceView.ts`：

```ts
import { isCloudServerId } from "./remote/pxCloud.js";

/** "phone" = 手机上接的那台（#1430）：它不在桌面那只箱里，桌面问不出它此刻连没连上——画「手机上接的」、不画点 */
export type ConnectorCloudState = "ready" | "unknown" | "off" | "phone";

function cloudStateOf(mine: boolean, serverId: string, hostedServerIds: readonly string[] | null): ConnectorCloudState {
  if (isCloudServerId(serverId)) return "phone";
  if (!mine) return "ready";
  if (hostedServerIds === null) return "unknown";
  return hostedServerIds.includes(serverId) ? "ready" : "off";
}
```

`ConnectorRowView` 加 `origin: "desktop" | "phone"`，`connectorRows` 里填 `origin: isCloudServerId(c.serverId) ? "phone" : "desktop"`。

`src/main/pxCloudGrant.ts`：

```ts
// 桌面撤回一台「手机上接的」连接器（#1430，spec §6.1）：它的授权在 edge 的 cloud 键里，本机台账里根本没有——
// 走本机 withdrawConnector 那条路只会删掉目录行，留下「目录没了、授权还在」的暗门。
import { parseCloudError } from "../shared/remote/pxCloud.js";

export function createPxCloudGrant(deps: {
  baseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): (workspaceId: string, serverId: string, on: boolean) => Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  return async (workspaceId, serverId, on) => {
    const token = await deps.accessToken();
    if (!token) throw new Error("还没登录");
    const res = await f(`${deps.baseUrl()}/px/v1/cloud/grant`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ serverId, workspaceId, on }),
    });
    if (res.ok) return;
    const payload: unknown = await res.json().catch(() => null);
    throw new Error(parseCloudError(res.status, payload) ?? `HTTP ${res.status}`);
  };
}
```

`src/main/workspaceManager.ts`：deps 接口加

```ts
  /** 手机上接的那几台（`cloud-` 前缀）在 edge 上开关团队授权（#1430）。撤回时替代本机台账那条路 */
  cloudGrant(workspaceId: string, serverId: string, on: boolean): Promise<void>;
```

`withdrawConnector` 开头加：

```ts
      if (isCloudServerId(serverId)) {
        // 授权先撤、目录行后删（spec §6.1）：云端撤不掉就整个失败，不删目录行——半路断在这儿留下的是
        // 「目录行在、授权也在」，界面上看得见、再点一次即清；反过来就是谁都看不见的暗门
        await deps.cloudGrant(id, serverId, false);
        await deps.deleteConnectorRow(client, id, uid, serverId);
        return null;
      }
```

（`import { isCloudServerId } from "../shared/remote/pxCloud.js";`）悬空授权对账（`danglingWorkspaceGrants`）不用改：它只看本机台账，`cloud-` 的授权从不进本机台账。

`src/main/index.ts`：`createWorkspaceManager({...})` 里加

```ts
    cloudGrant: createPxCloudGrant({
      baseUrl: () => edgeBaseUrl(),
      accessToken: () => accountManager?.getAccessToken() ?? Promise.resolve(null),
    }),
```

（`import { createPxCloudGrant } from "./pxCloudGrant.js";`）

`WorkspaceConnectorsTab.tsx`：`subtitle` 改为 ``row.origin === "phone" ? `${row.hostLabel} · 手机上接的 · ${row.toolsSummary}` : `${row.hostLabel} · ${row.toolsSummary}` ``；`CloudStateDot` 对 `"phone"` 回 `null`（在函数开头 `if (state === "phone") return null;`）；`InsetNote` 末尾补一句「标着『手机上接的』的，凭据在云端、由手机那边管。」

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/workspaceView.test.ts tests/main/pxCloudGrant.test.ts tests/main/workspaceManager.test.ts && npx tsc --noEmit`
Expected: PASS，tsc 无错

- [ ] **Step 5: 提交**

```bash
git add src/shared/workspaceView.ts src/main/pxCloudGrant.ts src/main/workspaceManager.ts src/main/index.ts src/renderer/src/components/WorkspaceConnectorsTab.tsx tests/shared/workspaceView.test.ts tests/main/pxCloudGrant.test.ts tests/main/workspaceManager.test.ts
git commit -m "feat(desktop): 团队连接器认出手机上接的那几台；撤回走 edge、先撤授权再删目录行（#1430）"
```

---

### Task 10: 手机界面判据（`mobileConnectors.ts`）

> 文案与分段以维护者点完 demo 后的定稿为准；demo 若改了某句话，改这里的常量与对应断言。

**Files:**
- Create: `src/shared/mobileConnectors.ts`
- Modify: `src/shared/mobileMachine.ts`（`appRows` 滤掉 `cloud-`；`APPS_FOOTER` 换新文案）
- Test: `tests/shared/mobileConnectors.test.ts`、`tests/shared/mobileMachine.test.ts`（改对应断言）

**Interfaces:**
- Consumes: `MCP_CATALOG` / `CATALOG_CATEGORIES` / `CuratedEntry`；`CloudViewItem` / `isCloudServerId`；`missingParams`；`WorkspaceSnapshot`
- Produces:
  - `MOBILE_OAUTH_BLOCKED: Readonly<Record<string, string>>`（Task 13 填）
  - `type ConnectKind = "browser" | "form" | "direct"`；`connectKind(entry: CuratedEntry): ConnectKind`
  - `interface CatalogItemView { id; name; description; category; kind: ConnectKind; connected: boolean; blocked: string | null }`
  - `connectCatalog(view: readonly CloudViewItem[] | null, query: string): { category: string; items: CatalogItemView[] }[]`
  - `connectIntro(entry: CuratedEntry): { lead: string; note: string; action: string }`
  - `paramFormError(entry: CuratedEntry, values: Readonly<Record<string, string>>): string | null`
  - `interface PhoneAppRow { serverId; title; detail; needsLogin: boolean; trailing: string | null }`
  - `phoneAppRows(view: readonly CloudViewItem[]): PhoneAppRow[]`
  - `interface AppDetailView { serverId; title; description; needsLogin: boolean; tools: string[]; connectedText: string }`
  - `appDetail(item: CloudViewItem, now: number): AppDetailView`
  - `interface LendRow { workspaceId: string; name: string; on: boolean }`
  - `lendRows(teams: readonly { id: string; name: string }[], item: CloudViewItem): LendRow[]`
  - 常量 `PHONE_APPS_FOOTER`、`DESKTOP_APPS_FOOTER`、`LEND_FOOTER`、`DISCONNECT_TITLE`、`disconnectLead(title: string): string`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/mobileConnectors.test.ts
import { describe, expect, it } from "vitest";
import { MCP_CATALOG } from "../../src/shared/mcpCatalog.js";
import {
  appDetail, connectCatalog, connectIntro, connectKind, lendRows, paramFormError, phoneAppRows,
} from "../../src/shared/mobileConnectors.js";
import type { CloudViewItem } from "../../src/shared/remote/pxCloud.js";

const byId = (id: string) => MCP_CATALOG.find((e) => e.id === id)!;
const item = (over: Partial<CloudViewItem> = {}): CloudViewItem => ({
  serverId: "cloud-notion", catalogId: "notion", status: "ok", tools: ["search", "create_page"], grants: ["home"], connectedTs: 0, ...over,
});

describe("目录", () => {
  it("只列 http；没有「本机工具」分组；已接的标出来", () => {
    const groups = connectCatalog([item()], "");
    const all = groups.flatMap((g) => g.items);
    expect(all.every((i) => byId(i.id).transport === "http")).toBe(true);
    expect(groups.some((g) => g.category === "本机工具")).toBe(false);
    expect(all.find((i) => i.id === "notion")!.connected).toBe(true);
  });
  it("搜索命中名字 / 描述；没命中的分组不出现", () => {
    const groups = connectCatalog(null, "notion");
    expect(groups.flatMap((g) => g.items).map((i) => i.id)).toContain("notion");
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });
  it("接入方式：oauth 无参数 = 浏览器；有参数 = 表单；none 无参数 = 直接", () => {
    expect(connectKind(byId("notion"))).toBe("browser");
    expect(connectKind(byId("github"))).toBe("form");
    const none = MCP_CATALOG.find((e) => e.transport === "http" && e.auth === "none" && e.params.length === 0);
    if (none) expect(connectKind(none)).toBe("direct");
  });
  it("接入前那段话点明以你的身份", () => {
    expect(connectIntro(byId("notion")).note).toContain("以你的身份");
    expect(connectIntro(byId("notion")).action).toBe("去登录");
    expect(connectIntro(byId("github")).action).toBe("连接");
  });
  it("参数表单：缺必填说出是哪一格（用 description 的第一句还是名字，照实现）", () => {
    expect(paramFormError(byId("github"), {})).not.toBeNull();
    expect(paramFormError(byId("github"), { github_token: "x" })).toBeNull();
  });
});

describe("应用列表与详情", () => {
  it("手机上接的：正常行尾不画东西；needs_login 写「点一下重新登录」", () => {
    const rows = phoneAppRows([item(), item({ serverId: "cloud-linear", catalogId: "linear", status: "needs_login" })]);
    expect(rows[0]).toMatchObject({ title: "Notion", trailing: null, needsLogin: false });
    expect(rows[1]).toMatchObject({ trailing: "点一下重新登录", needsLogin: true });
  });
  it("目录里已经没有的条目：名字退回 catalogId", () => {
    expect(phoneAppRows([item({ serverId: "cloud-gone", catalogId: "gone" })])[0]!.title).toBe("gone");
  });
  it("借给团队：只列团队，开关读授权", () => {
    const rows = lendRows([{ id: "t1", name: "奶茶店" }, { id: "t2", name: "工作室" }], item({ grants: ["home", "t2"] }));
    expect(rows).toEqual([{ workspaceId: "t1", name: "奶茶店", on: false }, { workspaceId: "t2", name: "工作室", on: true }]);
  });
  it("详情：工具清单与接入时间", () => {
    const d = appDetail(item({ connectedTs: 0 }), 86_400_000 * 3);
    expect(d.tools).toEqual(["search", "create_page"]);
    expect(d.connectedText).toMatch(/接入/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/mobileConnectors.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/shared/mobileConnectors.ts
// 手机上接应用的界面判据（#1430，spec §8）。手机端只画与接线，判断都在这儿（进 vitest）。
// 数据两份：edge 的无凭据视图（手机上接的，GET /px/v1/cloud）与主场快照的 connectors（电脑上接的，只读）。
import { CATALOG_CATEGORIES, MCP_CATALOG, type CuratedEntry } from "./mcpCatalog.js";
import { missingParams } from "./mcpCatalogFill.js";
import type { CloudViewItem } from "./remote/pxCloud.js";

/** 用 edge 的 https 回调实测过接不上的（Task 13 的探针产出）。值是给人看的那句原因 */
export const MOBILE_OAUTH_BLOCKED: Readonly<Record<string, string>> = {};

export type ConnectKind = "browser" | "form" | "direct";

export function connectKind(entry: CuratedEntry): ConnectKind {
  if (entry.params.length > 0) return "form";
  return entry.auth === "oauth" ? "browser" : "direct";
}

export interface CatalogItemView {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: ConnectKind;
  connected: boolean;
  blocked: string | null;
}

export function connectCatalog(view: readonly CloudViewItem[] | null, query: string): { category: string; items: CatalogItemView[] }[] {
  const connected = new Set((view ?? []).map((v) => v.catalogId));
  const q = query.trim().toLowerCase();
  const entries = MCP_CATALOG.filter((e) => e.transport === "http" && e.category !== "本机工具").filter((e) =>
    q === "" || [e.id, e.name, e.description].some((f) => f.toLowerCase().includes(q))
  );
  return CATALOG_CATEGORIES.filter((c) => c !== "本机工具")
    .map((category) => ({
      category,
      items: entries.filter((e) => e.category === category).map((e) => ({
        id: e.id, name: e.name, description: e.description, category,
        kind: connectKind(e), connected: connected.has(e.id),
        blocked: e.blocked ?? MOBILE_OAUTH_BLOCKED[e.id] ?? null,
      })),
    }))
    .filter((g) => g.items.length > 0);
}

export function connectIntro(entry: CuratedEntry): { lead: string; note: string; action: string } {
  return {
    lead: entry.description,
    note: "接好后，你的智能体会以你的身份操作它。",
    action: connectKind(entry) === "browser" ? "去登录" : "连接",
  };
}

export function paramFormError(entry: CuratedEntry, values: Readonly<Record<string, string>>): string | null {
  const miss = missingParams(entry, values);
  return miss.length === 0 ? null : `还缺：${miss.join("、")}`;
}

const titleOf = (catalogId: string): string => MCP_CATALOG.find((e) => e.id === catalogId)?.name ?? catalogId;

export interface PhoneAppRow { serverId: string; title: string; detail: string; needsLogin: boolean; trailing: string | null }

export function phoneAppRows(view: readonly CloudViewItem[]): PhoneAppRow[] {
  return view.map((v) => ({
    serverId: v.serverId,
    title: titleOf(v.catalogId),
    detail: v.tools.length === 0 ? "没有工具" : `${v.tools.length} 个工具`,
    needsLogin: v.status === "needs_login",
    trailing: v.status === "needs_login" ? "点一下重新登录" : null,
  }));
}

export interface AppDetailView { serverId: string; title: string; description: string; needsLogin: boolean; tools: string[]; connectedText: string }

export function appDetail(item: CloudViewItem, now: number): AppDetailView {
  const days = Math.floor((now - item.connectedTs) / 86_400_000);
  return {
    serverId: item.serverId,
    title: titleOf(item.catalogId),
    description: MCP_CATALOG.find((e) => e.id === item.catalogId)?.description ?? "",
    needsLogin: item.status === "needs_login",
    tools: item.tools,
    connectedText: days <= 0 ? "今天接入" : `${days} 天前接入`,
  };
}

export interface LendRow { workspaceId: string; name: string; on: boolean }

export function lendRows(teams: readonly { id: string; name: string }[], item: CloudViewItem): LendRow[] {
  return teams.map((t) => ({ workspaceId: t.id, name: t.name, on: item.grants.includes(t.id) }));
}

export const PHONE_APPS_FOOTER = "在手机上接的应用，凭据存在云端，你的智能体随时能用。";
export const DESKTOP_APPS_FOOTER = "在电脑上接的，要在电脑上管。";
export const LEND_FOOTER = "借给团队后，团队里的智能体会以你的身份用它。";
export const DISCONNECT_TITLE = "断开这个应用？";
export function disconnectLead(title: string): string {
  return `断开后，你的智能体和借到它的团队都用不了「${title}」，云端存的登录凭据会一起删掉。`;
}
```

`src/shared/mobileMachine.ts`：`appRows` 改为 `ws.connectors.filter((c) => !isCloudServerId(c.serverId)).map(...)`；`APPS_FOOTER` 换成 `DESKTOP_APPS_FOOTER` 的同一句（或直接 re-export），`tests/shared/mobileMachine.test.ts` 里对应断言照改。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/mobileConnectors.test.ts tests/shared/mobileMachine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/mobileConnectors.ts src/shared/mobileMachine.ts tests/shared/mobileConnectors.test.ts tests/shared/mobileMachine.test.ts
git commit -m "feat(mobile): 手机接应用的界面判据——可接目录、接入方式、两段列表、详情、借给团队（#1430）"
```

---

### Task 11: 手机端请求、store 与接入编排

**Files:**
- Create: `mobile/src/machine/connectorsApi.ts`、`mobile/src/machine/connectorsStore.ts`、`mobile/src/machine/connectApp.ts`
- Test: `tests/mobile/connectApp.test.ts`

**Interfaces:**
- Consumes: `EDGE_BASE` / `edgeToken`（`mobile/src/edge.ts`）；Task 1 `parseCloudView` / `parseConnectReply` / `parseConnectDone` / `parseCloudError` / `CONNECT_DONE_URL`；`upsertConnectorRow` / `deleteConnectorRow`（`src/shared/supabaseWorkspacesApi.ts`）
- Produces:
  - `connectorsApi`: `fetchCloudApps(): Promise<CloudViewItem[]>`、`startConnect(catalogId: string, params: Record<string, string>): Promise<ConnectReply>`、`setGrant(serverId: string, workspaceId: string, on: boolean): Promise<void>`、`removeApp(serverId: string): Promise<void>`
  - `connectorsStore`: `useConnectors(): { apps: CloudViewItem[] | null; loadError: string | null }`、`refreshConnectors(): Promise<void>`、`resetConnectors(): void`
  - `connectApp`: `runConnect(deps: ConnectDeps, catalogId: string, params: Record<string, string>): Promise<ConnectOutcome>`；`type ConnectOutcome = { kind: "connected"; serverId: string } | { kind: "cancelled" } | { kind: "error"; message: string }`；`interface ConnectDeps { startConnect: typeof startConnect; openAuth(url: string, redirect: string): Promise<{ type: "success"; url: string } | { type: string }> }`
  - `lendToTeam(o: { serverId; workspaceId; on; label; uid }): Promise<void>`（授权先于目录行 / 关时授权先删）、`disconnect(o: { serverId; uid; workspaceIds: string[] }): Promise<void>`

- [ ] **Step 1: 写失败的测试（编排纯逻辑，注入 openAuth）**

```ts
// tests/mobile/connectApp.test.ts
import { describe, expect, it } from "vitest";
import { runConnect } from "../../mobile/src/machine/connectApp.js";

describe("runConnect", () => {
  it("直接连上：不开浏览器", async () => {
    let opened = false;
    const r = await runConnect({ startConnect: async () => ({ kind: "connected", serverId: "cloud-x" }), openAuth: async () => { opened = true; return { type: "cancel" }; } }, "x", {});
    expect(r).toEqual({ kind: "connected", serverId: "cloud-x" });
    expect(opened).toBe(false);
  });
  it("浏览器：拦 mrotto://connector-done；人关了浏览器 = cancelled（什么都不说）", async () => {
    let redirect = "";
    const cancelled = await runConnect({ startConnect: async () => ({ kind: "authorize", authorizeUrl: "https://a" }), openAuth: async (_u, r) => { redirect = r; return { type: "cancel" }; } }, "notion", {});
    expect(redirect).toBe("mrotto://connector-done");
    expect(cancelled).toEqual({ kind: "cancelled" });
    const ok = await runConnect({ startConnect: async () => ({ kind: "authorize", authorizeUrl: "https://a" }), openAuth: async () => ({ type: "success", url: "mrotto://connector-done?ok=1&serverId=cloud-notion" }) }, "notion", {});
    expect(ok).toEqual({ kind: "connected", serverId: "cloud-notion" });
    const bad = await runConnect({ startConnect: async () => ({ kind: "authorize", authorizeUrl: "https://a" }), openAuth: async () => ({ type: "success", url: "mrotto://connector-done?ok=0&message=%E6%8E%88%E6%9D%83%E8%B6%85%E6%97%B6%E4%BA%86" }) }, "notion", {});
    expect(bad).toEqual({ kind: "error", message: "授权超时了" });
  });
  it("startConnect 抛错 → error 带原话", async () => {
    const r = await runConnect({ startConnect: async () => { throw new Error("这个 token 用不了"); }, openAuth: async () => ({ type: "cancel" }) }, "github", { github_token: "x" });
    expect(r).toEqual({ kind: "error", message: "这个 token 用不了" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mobile/connectApp.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// mobile/src/machine/connectorsApi.ts
// 手机打 edge 的 /px/v1/cloud*（#1430）。凭据不经过这台手机：token 类是人自己粘的、经 TLS 到 edge，手机不留存。
import {
  parseCloudError, parseCloudView, parseConnectReply, type CloudViewItem, type ConnectReply,
} from "../../../src/shared/remote/pxCloud.js";
import { EDGE_BASE, edgeToken } from "../edge.js";

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await edgeToken();
  if (token === null) throw new Error("还没登录。");
  const res = await fetch(`${EDGE_BASE}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(parseCloudError(res.status, payload) ?? `HTTP ${res.status}`);
  return payload;
}

export async function fetchCloudApps(): Promise<CloudViewItem[]> {
  const apps = parseCloudView(await call("/px/v1/cloud"));
  if (apps === null) throw new Error("应用清单的形状不对。");
  return apps;
}

export async function startConnect(catalogId: string, params: Record<string, string>): Promise<ConnectReply> {
  const r = parseConnectReply(await call("/px/v1/cloud/connect", { method: "POST", body: JSON.stringify({ catalogId, params }) }));
  if (r === null) throw new Error("服务端回的形状不对。");
  return r;
}

export async function setGrant(serverId: string, workspaceId: string, on: boolean): Promise<void> {
  await call("/px/v1/cloud/grant", { method: "POST", body: JSON.stringify({ serverId, workspaceId, on }) });
}

export async function removeApp(serverId: string): Promise<void> {
  await call(`/px/v1/cloud/${encodeURIComponent(serverId)}`, { method: "DELETE" });
}
```

```ts
// mobile/src/machine/connectorsStore.ts
// 手机上接的应用（edge 的无凭据视图）。纪律同 homeStore：读不到 ≠ 空（这次没拉下来，上一份照画）；
// 刷新时机由界面决定，不轮询；换号整份清掉。
import { useSyncExternalStore } from "react";
import type { CloudViewItem } from "../../../src/shared/remote/pxCloud.js";
import { createStore } from "../externalStore.js";
import { fetchCloudApps } from "./connectorsApi.js";

export interface ConnectorsState { apps: CloudViewItem[] | null; loadError: string | null }
const INITIAL: ConnectorsState = { apps: null, loadError: null };
const store = createStore<ConnectorsState>(INITIAL);

export function useConnectors(): ConnectorsState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let inflight: Promise<void> | null = null;
export function refreshConnectors(): Promise<void> {
  inflight ??= fetchCloudApps()
    .then((apps) => store.set({ apps, loadError: null }))
    .catch((e: unknown) => store.set({ ...store.get(), loadError: e instanceof Error ? e.message : String(e) }))
    .finally(() => { inflight = null; });
  return inflight;
}

export function resetConnectors(): void {
  store.set(INITIAL);
}
```

（`createStore` 的 `get` / `set` / `subscribe` 名字以 `mobile/src/externalStore.ts` 实际导出为准；实现前先读一眼。`resetConnectors` 接进换号清理的同一处——`homeStore` 的 reset 在哪里被调，就在同一处追加。）

```ts
// mobile/src/machine/connectApp.ts
// 接入编排（spec §3）：connect → （浏览器登录的）开授权会话拦 mrotto://connector-done → 解析结果。
// 借给团队 / 断开的两步顺序也在这儿：接入是「箱先于目录」，撤销是「授权先删、目录行后删」（计划开头第 1 条）。
import * as WebBrowser from "expo-web-browser";
import { CONNECT_DONE_URL, parseConnectDone } from "../../../src/shared/remote/pxCloud.js";
import { deleteConnectorRow, upsertConnectorRow } from "../../../src/shared/supabaseWorkspacesApi.js";
import { supabase } from "../supabase.js";
import { removeApp, setGrant, startConnect } from "./connectorsApi.js";

export type ConnectOutcome = { kind: "connected"; serverId: string } | { kind: "cancelled" } | { kind: "error"; message: string };

export interface ConnectDeps {
  startConnect: typeof startConnect;
  openAuth(url: string, redirect: string): Promise<{ type: string; url?: string }>;
}

export const realConnectDeps: ConnectDeps = {
  startConnect,
  openAuth: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
};

export async function runConnect(deps: ConnectDeps, catalogId: string, params: Record<string, string>): Promise<ConnectOutcome> {
  try {
    const reply = await deps.startConnect(catalogId, params);
    if (reply.kind === "connected") return reply;
    const res = await deps.openAuth(reply.authorizeUrl, CONNECT_DONE_URL);
    // cancel / dismiss = 人自己关了浏览器：什么都不说（spec §9 第一行）
    if (res.type !== "success" || typeof res.url !== "string") return { kind: "cancelled" };
    const done = parseConnectDone(res.url);
    return done.ok ? { kind: "connected", serverId: done.serverId } : { kind: "error", message: done.message };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function lendToTeam(o: { serverId: string; workspaceId: string; on: boolean; label: string; uid: string }): Promise<void> {
  if (o.on) {
    await setGrant(o.serverId, o.workspaceId, true);
    await upsertConnectorRow(supabase, { workspaceId: o.workspaceId, hostUid: o.uid, serverId: o.serverId, label: o.label, tools: [] });
  } else {
    await setGrant(o.serverId, o.workspaceId, false);
    await deleteConnectorRow(supabase, o.workspaceId, o.uid, o.serverId);
  }
}

/** 断开：先删云端（凭据与所有授权一起没），再删各团队的目录行 */
export async function disconnect(o: { serverId: string; uid: string; workspaceIds: readonly string[] }): Promise<void> {
  await removeApp(o.serverId);
  for (const ws of o.workspaceIds) await deleteConnectorRow(supabase, ws, o.uid, o.serverId);
}
```

测试文件里 `connectApp.ts` 顶层 import 了 `expo-web-browser` 与 `supabase`——vitest 里用 `vi.mock("expo-web-browser", () => ({}))`、`vi.mock("../../mobile/src/supabase.js", () => ({ supabase: {} }))`、`vi.mock("../../mobile/src/machine/connectorsApi.js", () => ({}))` 放在测试文件顶部（先看 `tests/mobile/` 里已有测试怎么处理这两个模块，照抄）。

- [ ] **Step 4: 跑测试与手机 tsc**

Run: `npx vitest run tests/mobile/connectApp.test.ts && npx --prefix mobile tsc --noEmit -p mobile`
Expected: PASS，tsc 无错

- [ ] **Step 5: 提交**

```bash
git add mobile/src/machine/connectorsApi.ts mobile/src/machine/connectorsStore.ts mobile/src/machine/connectApp.ts tests/mobile/connectApp.test.ts
git commit -m "feat(mobile): 云端连接器的请求、store 与接入编排（#1430）"
```

---

### Task 12: 手机界面（demo 定稿之后做）

> **前置：维护者点完 demo 并定稿。** 下面的结构照 spec §8；demo 里改了的布局 / 文案以 demo 为准，改完同步回 Task 10 的常量。

**Files:**
- Modify: `mobile/src/machine/AppsScreen.tsx`
- Create: `mobile/src/machine/ConnectAppScreen.tsx`、`mobile/src/machine/ConnectAppDialog.tsx`、`mobile/src/machine/AppDetailScreen.tsx`
- Modify: `mobile/src/nav/types.ts`（`ConnectApp: undefined; AppDetail: { serverId: string }`）、`mobile/src/nav/RootNavigator.tsx`（两条 `Root.Screen`：`ConnectApp` 标题「接入应用」、`AppDetail` 标题由页面 setOptions）

**Interfaces:**
- Consumes: Task 10 全部；Task 11 全部；`useHome` / `useTeams`；`ui.tsx` 的 `Group` / `Row` / `ListPage` / `Inset` / `Hint` / `Note` / `Field`；`dialog.tsx` 的 `Dialog` / `DialogTitle` / `DialogLead` / `DialogBody` / `DialogFooter`

- [ ] **Step 1: `AppsScreen`**

```tsx
// mobile/src/machine/AppsScreen.tsx
// 应用（#1430，spec §8）：上段「手机上接的」（edge 的云端连接器，能点进详情），下段「电脑上接的」（主场快照，只读）。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { DESKTOP_APPS_FOOTER, PHONE_APPS_FOOTER, phoneAppRows } from "../../../src/shared/mobileConnectors.js";
import { appRows } from "../../../src/shared/mobileMachine.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import type { RootStackParamList } from "../nav/types.js";
import { space, usePalette } from "../theme.js";
import { Group, Hint, Inset, ListPage, Note, Row } from "../ui.js";
import { refreshConnectors, useConnectors } from "./connectorsStore.js";

export function AppsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { c } = usePalette();
  const home = useHome();
  const cloud = useConnectors();
  useFocusEffect(useCallback(() => { void refreshHome(); void refreshConnectors(); }, []));
  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Pressable onPress={() => nav.navigate("ConnectApp")} hitSlop={8} accessibilityRole="button">
          <Text style={{ color: c.accent, fontSize: 17 }}>接入</Text>
        </Pressable>
      ),
    });
  }, [nav, c.accent]);

  const phone = phoneAppRows(cloud.apps ?? []);
  const desktop = home.home ? appRows(home.home) : [];
  return (
    <ListPage>
      <View style={{ gap: space.sm }}>
        {cloud.loadError !== null ? <Inset><Note tone="warn">{cloud.loadError}</Note></Inset> : null}
        {cloud.apps === null && cloud.loadError === null ? null : phone.length === 0 ? (
          <Inset><Hint>手机上还没接应用。点右上「接入」。</Hint></Inset>
        ) : (
          <Group header="手机上接的" footer={PHONE_APPS_FOOTER} inset={52}>
            {phone.map((r) => (
              <Row
                key={r.serverId}
                leading={<RowGlyph name="plug" />}
                label={r.title}
                detail={r.detail}
                {...(r.trailing ? { value: r.trailing } : {})}
                chevron
                onPress={() => nav.navigate("AppDetail", { serverId: r.serverId })}
              />
            ))}
          </Group>
        )}
        {desktop.length > 0 ? (
          <Group header="电脑上接的" footer={DESKTOP_APPS_FOOTER} inset={52}>
            {desktop.map((r) => <Row key={r.key} leading={<RowGlyph name="plug" />} label={r.title} detail={r.detail} />)}
          </Group>
        ) : null}
      </View>
    </ListPage>
  );
}
```

（`c.accent` / `usePalette` 的真实字段名以 `mobile/src/theme.ts` 为准；`Group` 的 `header` prop 已有。）

- [ ] **Step 2: `ConnectAppScreen` + `ConnectAppDialog`**

```tsx
// mobile/src/machine/ConnectAppScreen.tsx
// 接入新应用：搜索 + 分组（spec §8）。点一行弹居中弹窗（手机表单用居中弹窗）；已接的标「已接入」，点进详情。
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { MCP_CATALOG } from "../../../src/shared/mcpCatalog.js";
import { connectCatalog } from "../../../src/shared/mobileConnectors.js";
import { cloudServerId } from "../../../src/shared/remote/pxCloud.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import type { RootStackParamList } from "../nav/types.js";
import { space } from "../theme.js";
import { Field, Group, Hint, Inset, ListPage, Row } from "../ui.js";
import { ConnectAppDialog } from "./ConnectAppDialog.js";
import { useConnectors } from "./connectorsStore.js";

export function ConnectAppScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const cloud = useConnectors();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const groups = useMemo(() => connectCatalog(cloud.apps, q), [cloud.apps, q]);
  const entry = picked ? MCP_CATALOG.find((e) => e.id === picked) ?? null : null;
  return (
    <ListPage>
      <View style={{ gap: space.sm }}>
        <Inset><Field value={q} onChangeText={setQ} placeholder="搜应用" /></Inset>
        {groups.length === 0 ? <Inset><Hint>没找到。</Hint></Inset> : null}
        {groups.map((g) => (
          <Group key={g.category} header={g.category} inset={52}>
            {g.items.map((i) => (
              <Row
                key={i.id}
                leading={<RowGlyph name="plug" />}
                label={i.name}
                detail={i.blocked ?? i.description}
                {...(i.connected ? { value: "已接入" } : {})}
                disabled={i.blocked !== null && !i.connected}
                onPress={() => (i.connected ? nav.navigate("AppDetail", { serverId: cloudServerId(i.id) }) : setPicked(i.id))}
              />
            ))}
          </Group>
        ))}
      </View>
      {entry ? (
        <ConnectAppDialog
          entry={entry}
          onClose={() => setPicked(null)}
          onConnected={(serverId) => { setPicked(null); nav.replace("AppDetail", { serverId }); }}
        />
      ) : null}
    </ListPage>
  );
}
```

```tsx
// mobile/src/machine/ConnectAppDialog.tsx
// 接入前那一张居中弹窗：它是做什么的 + 以你的身份 + 要参数 / token 的当场问（spec §8）。按「连接 / 去登录」按 auth 分流。
import { useState } from "react";
import type { CuratedEntry } from "../../../src/shared/mcpCatalog.js";
import { connectIntro, paramFormError } from "../../../src/shared/mobileConnectors.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { Field, Labeled, Note } from "../ui.js";
import { realConnectDeps, runConnect } from "./connectApp.js";
import { refreshConnectors } from "./connectorsStore.js";

export function ConnectAppDialog({ entry, onClose, onConnected }: {
  entry: CuratedEntry;
  onClose: () => void;
  onConnected: (serverId: string) => void;
}) {
  const intro = connectIntro(entry);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);

  const go = async () => {
    const formErr = paramFormError(entry, values);
    if (formErr) { setError(formErr); return; }
    setBusy(true); setError(null);
    const r = await runConnect(realConnectDeps, entry.id, values);
    setBusy(false);
    if (r.kind === "cancelled") return;
    if (r.kind === "error") { setError(r.message); return; }
    await refreshConnectors();
    onConnected(r.serverId);
  };

  return (
    <Dialog visible={visible} onExited={onClose} dismissible={!busy} onDismiss={() => setVisible(false)}>
      <DialogTitle>{entry.name}</DialogTitle>
      <DialogLead>{intro.lead}</DialogLead>
      <DialogBody>
        {entry.params.map((p) => (
          <Labeled key={p.name} label={p.name} hint={p.description} error={null}>
            <Field
              value={values[p.name] ?? ""}
              onChangeText={(v) => setValues((s) => ({ ...s, [p.name]: v }))}
              secureTextEntry={entry.auth === "token"}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Labeled>
        ))}
        <Note tone="warn">{intro.note}</Note>
        {error ? <Note tone="error">{error}</Note> : null}
      </DialogBody>
      <DialogFooter
        left={{ label: "取消", onPress: () => setVisible(false), disabled: busy }}
        right={{ label: busy ? "连接中…" : intro.action, onPress: () => void go(), disabled: busy }}
      />
    </Dialog>
  );
}
```

（`Dialog` / `DialogFooter` / `Field` / `Labeled` 的真实 prop 名以 `mobile/src/dialog.tsx` 与 `ui.tsx` 为准——实现前读一眼这两处的签名，`DialogAction` 的字段名照它。`Note tone="warn"` 这一句若在 demo 里定成普通小字，换成 `Hint`。）

- [ ] **Step 3: `AppDetailScreen`**

```tsx
// mobile/src/machine/AppDetailScreen.tsx
// 接好之后：工具清单、「借给团队」开关、重新登录（只在 needs_login 时出现）、断开（spec §8）。
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useLayoutEffect, useState } from "react";
import { Switch, View } from "react-native";
import { MCP_CATALOG } from "../../../src/shared/mcpCatalog.js";
import { appDetail, disconnectLead, DISCONNECT_TITLE, LEND_FOOTER, lendRows } from "../../../src/shared/mobileConnectors.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { useTeams } from "../inbox/teamsStore.js";
import type { RootStackParamList } from "../nav/types.js";
import { supabase } from "../supabase.js";
import { space } from "../theme.js";
import { Group, Hint, Inset, ListPage, Note, Row, useNow } from "../ui.js";
import { ConnectAppDialog } from "./ConnectAppDialog.js";
import { disconnect, lendToTeam } from "./connectApp.js";
import { refreshConnectors, useConnectors } from "./connectorsStore.js";

export function AppDetailScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { serverId } = useRoute<RouteProp<RootStackParamList, "AppDetail">>().params;
  const cloud = useConnectors();
  const teams = useTeams();
  const now = useNow(60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [relogin, setRelogin] = useState(false);

  const item = cloud.apps?.find((a) => a.serverId === serverId) ?? null;
  const view = item ? appDetail(item, now) : null;
  useLayoutEffect(() => { nav.setOptions({ title: view?.title ?? "" }); }, [nav, view?.title]);
  if (!item || !view) return <ListPage><Inset><Hint>这个应用已经断开了。</Hint></Inset></ListPage>;

  const teamList = teams.teams.map((t) => ({ id: t.ws.id, name: t.ws.name }));
  const uid = async () => (await supabase.auth.getUser()).data.user?.id ?? "";
  const entry = MCP_CATALOG.find((e) => e.id === item.catalogId) ?? null;

  const toggle = async (workspaceId: string, on: boolean) => {
    setBusy(workspaceId); setError(null);
    try { await lendToTeam({ serverId, workspaceId, on, label: view.title, uid: await uid() }); await refreshConnectors(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <ListPage>
      <View style={{ gap: space.sm }}>
        {error ? <Inset><Note tone="error">{error}</Note></Inset> : null}
        {view.needsLogin ? (
          <Group footer="登录过期了，你的智能体暂时用不了它。">
            <Row label="重新登录" tone="accent" align="center" onPress={() => setRelogin(true)} />
          </Group>
        ) : null}
        <Group header={`工具 · ${view.tools.length}`} footer={view.connectedText}>
          {view.tools.map((t) => <Row key={t} label={t} />)}
        </Group>
        {teamList.length > 0 ? (
          <Group header="借给团队" footer={LEND_FOOTER}>
            {lendRows(teamList, item).map((r) => (
              <Row
                key={r.workspaceId}
                label={r.name}
                trailing={<Switch value={r.on} disabled={busy !== null} onValueChange={(v) => void toggle(r.workspaceId, v)} />}
              />
            ))}
          </Group>
        ) : null}
        <Group>
          <Row label="断开" tone="destructive" align="center" onPress={() => setConfirm(true)} />
        </Group>
      </View>
      {confirm ? (
        <Dialog visible onExited={() => setConfirm(false)} dismissible onDismiss={() => setConfirm(false)}>
          <DialogTitle>{DISCONNECT_TITLE}</DialogTitle>
          <DialogLead>{disconnectLead(view.title)}</DialogLead>
          <DialogFooter
            left={{ label: "取消", onPress: () => setConfirm(false) }}
            right={{
              label: "断开", tone: "destructive",
              onPress: () => void (async () => {
                setConfirm(false);
                try { await disconnect({ serverId, uid: await uid(), workspaceIds: item.grants.filter((g) => teamList.some((t) => t.id === g)) }); await refreshConnectors(); nav.goBack(); }
                catch (e) { setError(e instanceof Error ? e.message : String(e)); }
              })(),
            }}
          />
        </Dialog>
      ) : null}
      {relogin && entry ? (
        <ConnectAppDialog entry={entry} onClose={() => setRelogin(false)} onConnected={() => { setRelogin(false); void refreshConnectors(); }} />
      ) : null}
    </ListPage>
  );
}
```

（弹窗里「选中之后等 `onDismiss` 才做」那条 iOS 规矩：这里的确认弹窗在 `onPress` 里先关再做网络，不叠第二个 Modal，符合；`ConnectAppDialog` 从详情页开时它是唯一一层。）

- [ ] **Step 4: 路由 + 手机 tsc + 模拟器冒烟**

`types.ts` 加 `ConnectApp: undefined; AppDetail: { serverId: string };`，`RootNavigator.tsx` 在 `Apps` 之后加两条 `Root.Screen`。

Run: `npx --prefix mobile tsc --noEmit -p mobile && npm test`
Expected: 全绿

模拟器冒烟（照记忆里 `mobile-sim-smoke-expo-go` 的做法，用临时根组件 + 假数据）：应用列表两段、接入目录搜索、弹窗、详情的开关与断开确认，浅色 / 深色各截一张。

- [ ] **Step 5: 提交**

```bash
git add mobile/src/machine mobile/src/nav
git commit -m "feat(mobile): 我 → 那台电脑 → 应用：手机上接应用、借给团队、断开（#1430）"
```

---

### Task 13: 上线前的 OAuth 前半段探针

**Files:**
- Create: `scripts/probe-cloud-oauth.mjs`
- Modify: `src/shared/mobileConnectors.ts`（`MOBILE_OAUTH_BLOCKED` 按探针结果填）

- [ ] **Step 1: 写探针脚本**（不进门禁；用 tsx 直接 import 纯函数）

```js
// scripts/probe-cloud-oauth.mjs
// spec §14：目录里的 OAuth 应用当初是用本机回环回调实测的；换成 edge 的 https 回调后逐条再跑前半段
// （发现 → 动态注册 → 生成授权 URL），走到「浏览器该开了」才算过。
// 用法：npx tsx scripts/probe-cloud-oauth.mjs [--callback https://edge.mrotto.agency/px/v1/cloud/callback]
import { MCP_CATALOG } from "../src/shared/mcpCatalog.ts";
import { discoverOAuth, registerClient } from "../services/edge/src/pxOAuth.ts";

const i = process.argv.indexOf("--callback");
const callback = i > 0 ? process.argv[i + 1] : "https://edge.mrotto.agency/px/v1/cloud/callback";
const f = (url, init) => fetch(url, init);
const rows = [];
for (const e of MCP_CATALOG.filter((x) => x.transport === "http" && x.auth === "oauth")) {
  if (/\{\w+\}/.test(e.url ?? "")) { rows.push([e.id, "skip", "url 带参数，手测"]); continue; }
  const d = await discoverOAuth(f, e.url);
  if (!d.ok) { rows.push([e.id, "FAIL", d.message]); continue; }
  const r = await registerClient(f, d.meta, callback);
  rows.push([e.id, r.ok ? "ok" : "FAIL", r.ok ? "" : `${r.code}: ${r.message}`]);
}
for (const [id, s, why] of rows) console.log(`${s.padEnd(4)} ${id.padEnd(24)} ${why}`);
console.log(`\n${rows.filter((r) => r[1] === "ok").length}/${rows.length} ok`);
```

- [ ] **Step 2: 跑一遍，把 FAIL 的条目按原因填进 `MOBILE_OAUTH_BLOCKED`**

Run: `npx tsx scripts/probe-cloud-oauth.mjs`
Expected: 每条一行；FAIL 的填成 `{ "<id>": "这个应用暂时不能在手机上直接登录，去电脑上接" }`（`no_dcr`）或原因的人话版（`register` 拒 redirect_uri 的写「它不接受从云端回来的登录」）。

注意：注册会在厂商那边真的留下一个 client（无害但会累积）；只在上线前跑一次，结果与日期写进 #1430 评论。

- [ ] **Step 3: 跑相关测试并提交**

Run: `npx vitest run tests/shared/mobileConnectors.test.ts`
Expected: PASS

```bash
git add scripts/probe-cloud-oauth.mjs src/shared/mobileConnectors.ts
git commit -m "chore(mobile): OAuth 前半段探针换 https 回调逐条重跑，接不上的在手机上标出来（#1430）"
```

---

### Task 14: 文档（ADR / CONTEXT / AGENTS 索引 / spec 两处修正）

**Files:**
- Create: `docs/adr/NNNN-cloud-connectors-second-sealed-key.md`（号在合并前 re-fetch 后取 `max + 1`）
- Modify: `CONTEXT.md`（产品/技术术语段加「云端连接器」）
- Modify: `AGENTS.md`（Where to find things 加一条）
- Modify: `docs/superpowers/specs/2026-09-30-mobile-connectors-design.md`（§6「关」、§7 顺序；§5 / §12 runtime 那句）

- [ ] **Step 1: ADR** —— 记三条决策与推翻前提：① 同一只 Escrow DO 第二个封存键 `cloud`，一个键一个写者；② OAuth 回调走 edge 的 https，v1 不做手填 client；③ 撤销一律授权先删、目录行后删（理由见计划开头）。推翻前提照 spec §14 两条 + 「runtime 的工具名封顶已上线」。

- [ ] **Step 2: CONTEXT.md** —— 「云端连接器：手机上接的应用。凭据封存在 edge 那只 Escrow DO 的 `cloud` 键下、serverId 带 `cloud-` 前缀，由 edge 续期；与桌面贡献的托管服务（`sealed` 键）合成一份给智能体用（ADR-NNNN）。」

- [ ] **Step 3: AGENTS.md 索引** —— 一条：``- `src/shared/remote/pxCloud.ts` / `services/edge/src/pxCloudOps.ts` / `pxOAuth.ts` / `mobile/src/machine/connectApp.ts` — 手机上接应用（ADR-NNNN，#1430）：……``，写清两个封存键一个写者、外呼在前读改写在后、撤销顺序、`needs_login` 不进工具清单、部署顺序（edge → runtime → 桌面 → 手机）。

- [ ] **Step 4: spec 修正** —— §6「关」改为「先 `on:false` 删授权，再删目录那一行」；§7 改为「`DELETE /px/v1/cloud/:serverId` → 删各团队的目录行」；§5 末句与 §12 第 1 条改成「runtime 要重新部署一次（工具名封顶，Task 8）」。

- [ ] **Step 5: 门禁 + 提交**

Run: `npm test`
Expected: 全绿（含 `tests/docs/adrNumbers.test.ts`）

```bash
git add docs/adr CONTEXT.md AGENTS.md docs/superpowers/specs/2026-09-30-mobile-connectors-design.md
git commit -m "docs: 云端连接器的 ADR、术语与索引；spec 撤销顺序统一为授权先删（#1430）"
```

---

## 上线顺序（替代 spec §12）

1. 部署 edge（`npm run deploy:edge` 或 `npm run release` 里那一步；自检看 `/healthz` 的戳）。不跑 migration。
2. 部署 runtime（Task 8 的工具名封顶）。
3. 跑 Task 13 的探针，结果进 `MOBILE_OAUTH_BLOCKED`。
4. 桌面发版（`cloud-` 行撤回走 edge）。
5. 手机打包。真机验（spec §11 末条）：Notion（OAuth）、GitHub（token）、Context7（免登录）各接一次，智能体各调一次；借给团队后团队里的智能体调一次；断开后调用被拒；把一台的 refresh_token 手动作废后调一次，确认手机上出现「点一下重新登录」。

## 已知代价

- 团队被解散 / 我被踢出后，`cloud` 里那条团队授权不会自动清（团队闸要在籍，不越权；手机详情页里那个团队也不会再列出来，所以也关不掉）。等真出现再加「视图时按在籍对账」。
- 手机上接的应用在桌面团队设置页只标「手机上接的」，看不到连没连上（spec §13）。
- 探针会在各厂商那边留下注册过的 client。
