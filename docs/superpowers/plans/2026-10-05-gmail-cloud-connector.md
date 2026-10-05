# 手机上接 Gmail（预置 OAuth 客户端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机「接入应用」里出现 Gmail，点「去登录」走 edge 持有的预置 Google OAuth 客户端（不走动态注册）；桌面把它标成「在手机上接」。

**Architecture:** 目录条目加 `presetClient` / `scopes` / `authorizeParams` 三个字段；edge 的 `cloudConnect` 遇到 `presetClient` 跳过 `registerClient`，
用 `CloudOpsDeps.presetClient(name)` 从 Worker secret 取 client_id；pending 与落箱只记 `{ client_id, preset }`，换 token 与续期前现取 secret 补上。
桌面读 `entry.blocked` 的地方改读 `desktopBlocked(entry)`。

**Tech Stack:** TypeScript strict（含 `exactOptionalPropertyTypes`）、vitest、Cloudflare Worker（Durable Object）、React（桌面渲染层）。

**Spec:** `docs/superpowers/specs/2026-10-05-gmail-cloud-connector-design.md`（#1619）

## Global Constraints

- Gmail 端点逐字：`https://gmailmcp.googleapis.com/mcp/v1`
- scope 逐字两项：`https://www.googleapis.com/auth/gmail.readonly`、`https://www.googleapis.com/auth/gmail.compose`
- 授权额外参数逐字：`access_type=offline`、`prompt=consent`
- Worker secret 名逐字：`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`
- 预置客户端名只有 `"google"` 一个值
- **client_secret 永远不写进 pending、不写进 cloud 箱**；只在外呼那一刻补进请求
- 没配凭据：`cloudConnect` 回 503 / `preset_unconfigured` / `「Gmail 还没开放，稍后再试」`（`${entry.name} 还没开放，稍后再试`），**不外呼**
- 续期时 secret 取不到 = transient（不标 needs_login）
- 授权 URL 的保留键不许被 `authorizeParams` 覆盖：`response_type`、`client_id`、`redirect_uri`、`code_challenge`、`code_challenge_method`、`state`、`resource`、`scope`
- 桌面文案逐字：`这个应用在手机上接：Mr Otto 手机 App →「接入应用」`；目录卡片上的标签 `在手机上接`
- `exactOptionalPropertyTypes` 开着：可选属性不能传 `undefined`，用 `...(x ? { k: x } : {})` 展开
- 测试放 `tests/`，镜像 `src/` 结构；改完跑 `npm test`（先 `npm --prefix mobile ci` 一次）
- 代码里不写 NUL 字符；注释用中文、照周围代码的密度
- 提交信息写「为什么」，结尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

---

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/shared/mcpCatalog.ts` | 改 | 三个新字段、`PresetClientName`、`AUTHORIZE_RESERVED`、`desktopBlocked`、Gmail 条目 |
| `src/renderer/src/assets/mcp/gmail.svg` | 建 | 图标（simple-icons，品牌色 `#EA4335`） |
| `mobile/src/machine/appIcons.generated.ts` | 重新生成 | 手机图标表（`node scripts/gen-mobile-app-icons.mjs`） |
| `services/edge/src/pxOAuth.ts` | 改 | `authorizeUrl` 接 `scopes` / `extra` |
| `src/shared/remote/pxCloud.ts` | 改 | `presetUnconfiguredText(name)` |
| `services/edge/src/pxCloudOps.ts` | 改 | 预置分支：connect / callback / refresh |
| `services/edge/src/worker.ts` | 改 | `Env` 两格 + `cloudDeps().presetClient` |
| `services/edge/wrangler.jsonc` | 改 | secret 注释清单补两行 |
| `src/renderer/src/lib/mcpDirectory.ts` | 改 | `installSlot` 读 `desktopBlocked` |
| `src/renderer/src/lib/mcpDetail.ts` | 改 | `connectorFacts` 读 `desktopBlocked` |
| `src/renderer/src/components/McpConnectorPage.tsx` | 改 | 横幅与编辑器入参读 `desktopBlocked` |
| `src/tools/mcpCatalog.ts` | 改 | `render` 读 `desktopBlocked` |
| `docs/adr/0369-…md` | 建 | 决定记录（编号合并前再核） |
| `docs/where-to-find-things.md` | 改 | 一条指针 |

---

### Task 1: 目录字段 + Gmail 条目 + 图标

**Files:**
- Modify: `src/shared/mcpCatalog.ts`（`CatalogEntry` 在 50-98 行；Dropbox 条目在 574 行附近，Gmail 加在同一「协作与项目」分组里、Dropbox 之后）
- Create: `src/renderer/src/assets/mcp/gmail.svg`
- Regenerate: `mobile/src/machine/appIcons.generated.ts`
- Test: `tests/shared/mcpCatalog.test.ts`、`tests/shared/mobileConnectors.test.ts`

**Interfaces:**
- Produces（后面的 task 用）：
  - `export type PresetClientName = "google";`
  - `export const AUTHORIZE_RESERVED: readonly string[]`
  - `CatalogEntry.presetClient?: PresetClientName`、`CatalogEntry.scopes?: readonly string[]`、`CatalogEntry.authorizeParams?: Readonly<Record<string, string>>`
  - `export const PRESET_ON_PHONE: string`（桌面文案）
  - `export function desktopBlocked(entry: CatalogEntry): string | undefined`

- [ ] **Step 1: 写失败的测试**

在 `tests/shared/mcpCatalog.test.ts` 末尾加（import 行补上 `AUTHORIZE_RESERVED, PRESET_ON_PHONE, desktopBlocked`，`MCP_CATALOG` 已有就复用）：

```ts
describe("预置 OAuth 客户端（#1619）", () => {
  const gmail = MCP_CATALOG.find((e) => e.id === "gmail")!;
  it("Gmail：官方端点、预置 google 客户端、只要两个 scope、带 offline + consent", () => {
    expect(gmail).toMatchObject({
      transport: "http", url: "https://gmailmcp.googleapis.com/mcp/v1", auth: "oauth", params: [], presetClient: "google",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
      authorizeParams: { access_type: "offline", prompt: "consent" },
    });
  });
  it("presetClient / scopes / authorizeParams 只出现在 http + oauth 条目上；scopes 非空；authorizeParams 不碰保留键", () => {
    for (const e of MCP_CATALOG) {
      if (e.presetClient === undefined && e.scopes === undefined && e.authorizeParams === undefined) continue;
      expect([e.id, e.transport, e.auth]).toEqual([e.id, "http", "oauth"]);
      if (e.scopes !== undefined) expect(e.scopes.length).toBeGreaterThan(0);
      for (const k of Object.keys(e.authorizeParams ?? {})) expect(AUTHORIZE_RESERVED).not.toContain(k);
    }
  });
  it("desktopBlocked：预置客户端的条目指去手机；其余等于 blocked", () => {
    expect(desktopBlocked(gmail)).toBe(PRESET_ON_PHONE);
    expect(PRESET_ON_PHONE).toBe("这个应用在手机上接：Mr Otto 手机 App →「接入应用」");
    const notion = MCP_CATALOG.find((e) => e.id === "notion")!;
    expect(desktopBlocked(notion)).toBe(notion.blocked);
    expect(desktopBlocked({ ...notion, blocked: "坏了" })).toBe("坏了");
  });
});
```

在 `tests/shared/mobileConnectors.test.ts` 的 `describe("目录", …)` 里加：

```ts
  it("Gmail 在手机目录里：去浏览器登录，不置灰（预置客户端，#1619）", () => {
    const g = connectCatalog(null, "gmail").flatMap((x) => x.items).find((i) => i.id === "gmail")!;
    expect(g).toMatchObject({ kind: "browser", blocked: null, category: "协作与项目" });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/mcpCatalog.test.ts tests/shared/mobileConnectors.test.ts`
Expected: FAIL（`AUTHORIZE_RESERVED` / `desktopBlocked` 未导出，找不到 gmail 条目）

- [ ] **Step 3: 实现字段与 helper**

`src/shared/mcpCatalog.ts`，在 `CatalogEntry` 接口里 `blocked?: string;` 之后加：

```ts
  /** 可选：用我们预置的哪一套 OAuth 客户端，不走动态注册（#1619）。值是 edge 上那套凭据的**名字**，
      凭据本身只在 edge 的 Worker secret 里。只对 http + oauth 有意义；桌面这一版接不了这类条目（desktopBlocked） */
  presetClient?: PresetClientName;
  /** 可选：写死要的 scope。有它就不用资源元数据的 scopes_supported——Gmail 那份含 `https://mail.google.com/` 整箱权限 */
  scopes?: readonly string[];
  /** 可选：授权 URL 上额外带的参数。Google 要 access_type=offline + prompt=consent 才回 refresh_token；
      不许碰 AUTHORIZE_RESERVED 里那几个（目录测试拦着，authorizeUrl 也忽略） */
  authorizeParams?: Readonly<Record<string, string>>;
```

在 `CatalogEntry` 接口**之前**加：

```ts
/** edge 上预置的 OAuth 客户端名（#1619）。加一家就是这里加一个值 + edge 的 cloudDeps().presetClient 认它 */
export type PresetClientName = "google";

/** 授权 URL 上由 edge 自己定的参数，目录的 authorizeParams 不许覆盖 */
export const AUTHORIZE_RESERVED: readonly string[] = [
  "response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope",
];
```

在 `CuratedEntry` 定义之后加：

```ts
/** 桌面上这台接得了吗：预置客户端的条目只在手机上接（Web application 客户端要精确回调地址，桌面是随机回环端口，#1619） */
export const PRESET_ON_PHONE = "这个应用在手机上接：Mr Otto 手机 App →「接入应用」";

/** 桌面读「接不上的原因」一律走这里，不直接读 entry.blocked */
export function desktopBlocked(entry: CatalogEntry): string | undefined {
  return entry.blocked ?? (entry.presetClient !== undefined ? PRESET_ON_PHONE : undefined);
}
```

- [ ] **Step 4: 加 Gmail 条目**

紧跟 `id: "dropbox"` 那个对象之后：

```ts
  {
    id: "gmail",
    name: "Gmail",
    description: "搜邮件、读来往、起草回信（不直接发信）",
    category: "协作与项目",
    transport: "http",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    params: [],
    auth: "oauth",
    authNote: "在手机上接：登录 Google 账号，同意读邮件、管草稿",
    // Google 的授权服务器没有动态注册：用 edge 预置的客户端（#1619，ADR-0369）
    presetClient: "google",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
    authorizeParams: { access_type: "offline", prompt: "consent" },
    icon: "gmail",
  },
```

- [ ] **Step 5: 图标**

建 `src/renderer/src/assets/mcp/gmail.svg`（形状取自 simple-icons 的 gmail，`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/gmail.svg`；头注照 `dropbox.svg` 的格式）：

```svg
<!-- gmail —— 取自 simple-icons（图标本体 CC0-1.0；商标归各自所有者，此处仅作服务识别）。
     单色路径 + 品牌色填充。底是透明的，标直接坐在卡片上，所以这个颜色要在浅色和深色两种卡片底色上都过得去。 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#EA4335">
<path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
</svg>
```

然后：`node scripts/gen-mobile-app-icons.mjs`（重写 `mobile/src/machine/appIcons.generated.ts`），再 `node scripts/gen-mobile-app-icons.mjs --check` 退出码 0。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/shared tests/scripts tests/renderer/mcpIcons.test.ts`
Expected: PASS（目录的「填了 icon 资源必须在」、mobileAppIcons 的「产物不过期」都绿）

- [ ] **Step 7: 提交**

```bash
git add src/shared/mcpCatalog.ts src/renderer/src/assets/mcp/gmail.svg mobile/src/machine/appIcons.generated.ts tests/shared/mcpCatalog.test.ts tests/shared/mobileConnectors.test.ts
git commit -m "feat(catalog): Gmail 条目 + 预置 OAuth 客户端三个字段（#1619）" -m "Google 没有动态注册，所以条目要能说「用 edge 预置的哪套客户端」；scope 写死两项，因为资源元数据那份含整箱权限；access_type/prompt 不带就拿不到 refresh_token。桌面读接不上原因改走 desktopBlocked，预置条目指去手机。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `authorizeUrl` 接 scope 覆盖与额外参数

**Files:**
- Modify: `services/edge/src/pxOAuth.ts:149-160`
- Test: `tests/edge/pxOAuth.test.ts`（`describe("authorizeUrl / exchangeCode / refresh")` 在 122 行）

**Interfaces:**
- Consumes: `AUTHORIZE_RESERVED`（Task 1，`src/shared/mcpCatalog.ts`）
- Produces: `authorizeUrl(o: { meta: OAuthMeta; clientId: string; redirectUri: string; challenge: string; state: string; resource: string; scopes?: readonly string[]; extra?: Readonly<Record<string, string>> }): string`

- [ ] **Step 1: 写失败的测试**

在 122 行那个 describe 里加（`meta` 用该 describe 里已有的那个；看一眼它的 `scopes` 值，下面断言里的「原 scope」按它写）：

```ts
  it("scopes 覆盖资源元数据那份；extra 逐个带上，保留键不许被覆盖（#1619）", () => {
    const u = new URL(authorizeUrl({
      meta, clientId: "cid", redirectUri: "https://e/cb", challenge: "ch", state: "st", resource: "https://m/mcp",
      scopes: ["s.read", "s.compose"],
      extra: { access_type: "offline", prompt: "consent", client_id: "evil", redirect_uri: "https://evil/cb", scope: "all" },
    }));
    expect(u.searchParams.get("scope")).toBe("s.read s.compose");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://e/cb");
    expect(u.searchParams.getAll("client_id")).toHaveLength(1);
  });
  it("scopes 给了空数组 = 不带 scope（不退回资源元数据那份）", () => {
    const u = new URL(authorizeUrl({ meta: { ...meta, scopes: ["x"] }, clientId: "cid", redirectUri: "https://e/cb", challenge: "ch", state: "st", resource: "https://m/mcp", scopes: [] }));
    expect(u.searchParams.has("scope")).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/edge/pxOAuth.test.ts`
Expected: FAIL（`scope` 仍是元数据那份、`access_type` 为 null）

- [ ] **Step 3: 实现**

`services/edge/src/pxOAuth.ts` 顶部 import 区加：

```ts
import { AUTHORIZE_RESERVED } from "../../../src/shared/mcpCatalog.js";
```

把 `authorizeUrl` 换成：

```ts
/** scopes：目录写死的那份（#1619），给了就不用资源元数据的；extra：目录的 authorizeParams，保留键一律忽略 */
export function authorizeUrl(o: {
  meta: OAuthMeta; clientId: string; redirectUri: string; challenge: string; state: string; resource: string;
  scopes?: readonly string[]; extra?: Readonly<Record<string, string>>;
}): string {
  const u = new URL(o.meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", o.state);
  u.searchParams.set("resource", o.resource);
  const scopes = o.scopes ?? o.meta.scopes;
  if (scopes.length > 0) u.searchParams.set("scope", scopes.join(" "));
  for (const [k, v] of Object.entries(o.extra ?? {})) {
    if (!AUTHORIZE_RESERVED.includes(k)) u.searchParams.set(k, v);
  }
  return u.toString();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/edge/pxOAuth.test.ts`
Expected: PASS（含原有的 authorizeUrl 用例）

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/pxOAuth.ts tests/edge/pxOAuth.test.ts
git commit -m "feat(edge): authorizeUrl 接目录写死的 scope 与额外参数（#1619）" -m "Gmail 资源元数据列了整箱权限，照搬会向用户要 mail.google.com；Google 不带 access_type=offline 不回 refresh_token。保留键忽略，免得目录一条笔误把 client_id / redirect_uri 换掉。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: edge 预置分支（connect / callback / refresh）+ Worker 接线

**Files:**
- Modify: `src/shared/remote/pxCloud.ts`（`CLOUD_TEXT` 在 251 行附近）
- Modify: `services/edge/src/pxCloudOps.ts`（`CloudOpsDeps` 55-67；`cloudConnect` 98-168；`cloudCallback` 170-202；`cloudRefresh` 251-）
- Modify: `services/edge/src/worker.ts`（`Env` 57-97；`cloudDeps()` 247-）
- Modify: `services/edge/wrangler.jsonc`（secret 注释清单 44-57）
- Test: `tests/edge/pxCloudOps.test.ts`

**Interfaces:**
- Consumes: `PresetClientName`、`CatalogEntry.presetClient/scopes/authorizeParams`（Task 1）；`authorizeUrl` 的 `scopes` / `extra`（Task 2）
- Produces:
  - `export function presetUnconfiguredText(name: string): string`（`pxCloud.ts`）→ `${name} 还没开放，稍后再试`
  - `CloudOpsDeps.presetClient?: (name: PresetClientName) => { client_id: string; client_secret: string } | null`
  - pending / 箱里的预置 `clientInformation` 形状：`{ client_id: string; preset: PresetClientName }`（**没有 client_secret**）

- [ ] **Step 1: 写失败的测试**

`tests/edge/pxCloudOps.test.ts`：import 行加 `presetUnconfiguredText`（从 `../../src/shared/remote/pxCloud.js`）。在 `CATALOG` 数组里加一条：

```ts
  {
    id: "gmail", name: "Gmail", description: "", transport: "http", url: "https://gmail.example/mcp/v1", params: [], auth: "oauth", authNote: "",
    presetClient: "google", scopes: ["g.read", "g.compose"], authorizeParams: { access_type: "offline", prompt: "consent" },
  },
```

在 `upstream()` 的 `f` 里、`if (url.startsWith("https://"))` 那个兜底分支**之前**加 Google 形状的假上游（AS 带尾斜杠，与真 Google 一致；refresh 回包不带 refresh_token，与真 Google 一致）：

```ts
    if (url === "https://gmail.example/.well-known/oauth-protected-resource/mcp/v1") {
      return J(200, { resource: "https://gmail.example/mcp/v1", authorization_servers: ["https://accounts.example/"], scopes_supported: ["https://mail.example/", "g.read", "g.compose"] });
    }
    if (url === "https://accounts.example/.well-known/oauth-authorization-server") {
      return J(200, { authorization_endpoint: "https://accounts.example/auth", token_endpoint: "https://oauth2.example/token" });
    }
    if (url === "https://oauth2.example/token") {
      const b = new URLSearchParams(String(init.body));
      if (b.get("client_secret") !== "GSECRET") return J(401, { error: "invalid_client" });
      return b.get("grant_type") === "refresh_token" ? J(200, { access_token: "AT2" }) : J(200, { access_token: "AT", refresh_token: "RT" });
    }
```

再加一个 describe（放在文件末尾）：

```ts
describe("预置 OAuth 客户端（#1619）", () => {
  const PRESET = { client_id: "gcid.apps.example", client_secret: "GSECRET" };
  const withPreset = (p: typeof PRESET | null = PRESET) => deps({ presetClient: () => p });

  it("不调注册；授权 URL 用预置 client_id、目录的 scope 与额外参数", async () => {
    const { d, up } = withPreset();
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    expect(r.ok).toBe(true);
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const u = new URL(r.reply.authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.example/auth");
    expect(u.searchParams.get("client_id")).toBe("gcid.apps.example");
    expect(u.searchParams.get("scope")).toBe("g.read g.compose");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(up.calls.some((c) => c.includes("register"))).toBe(false);
  });

  it("没配凭据：503 preset_unconfigured，一发外呼都没有", async () => {
    const { d, up } = withPreset(null);
    expect(await cloudConnect(d, UID, { catalogId: "gmail", params: {} }))
      .toEqual({ ok: false, status: 503, code: "preset_unconfigured", message: presetUnconfiguredText("Gmail") });
    expect(presetUnconfiguredText("Gmail")).toBe("Gmail 还没开放，稍后再试");
    expect(up.calls).toEqual([]);
    const none = deps(); // deps 里根本没有 presetClient
    expect(await cloudConnect(none.d, UID, { catalogId: "gmail", params: {} })).toMatchObject({ status: 503 });
  });

  it("pending 与落箱里都没有 client_secret；换 token 时带上了（假上游不带 secret 就 401）", async () => {
    const { d, m } = withPreset();
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    const p = m.pending.get(state)!;
    expect(p.clientInformation).toEqual({ client_id: "gcid.apps.example", preset: "google" });
    expect(await cloudCallback(d, UID, { state, code: "C", error: null })).toEqual({ ok: true, serverId: "cloud-gmail" });
    const svc = m.peekBox()!.services[0]!;
    expect(svc.oauth!.clientInformation).toEqual({ client_id: "gcid.apps.example", preset: "google" });
    expect(JSON.stringify(m.peekBox())).not.toContain("GSECRET");
  });

  it("回调时凭据被撤了：不换 token，说还没开放", async () => {
    let p: typeof PRESET | null = PRESET;
    const { d, up } = deps({ presetClient: () => p });
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    p = null;
    expect(await cloudCallback(d, UID, { state, code: "C", error: null })).toEqual({ ok: false, message: presetUnconfiguredText("Gmail") });
    expect(up.calls.some((c) => c === "https://oauth2.example/token")).toBe(false);
  });

  it("续期：带上现取的 secret；写回的箱里仍没有 secret，旧 refresh_token 保留", async () => {
    const { d, m } = withPreset();
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    await cloudCallback(d, UID, { state, code: "C", error: null });
    const oauth = await cloudRefresh(d, "cloud-gmail");
    expect(oauth?.tokens).toMatchObject({ access_token: "AT2", refresh_token: "RT" });
    expect(oauth?.clientInformation).toEqual({ client_id: "gcid.apps.example", preset: "google" });
    expect(JSON.stringify(m.peekBox())).not.toContain("GSECRET");
    expect(m.peekBox()!.services[0]!.status).toBe("ok");
  });

  it("续期时凭据取不到 = transient：不外呼、不标 needs_login", async () => {
    let p: typeof PRESET | null = PRESET;
    const { d, m, up } = deps({ presetClient: () => p });
    const r = await cloudConnect(d, UID, { catalogId: "gmail", params: {} });
    if (!r.ok || r.reply.kind !== "authorize") throw new Error("应当回 authorize");
    const state = new URL(r.reply.authorizeUrl).searchParams.get("state")!;
    await cloudCallback(d, UID, { state, code: "C", error: null });
    p = null;
    const before = up.calls.length;
    expect(await cloudRefresh(d, "cloud-gmail")).toBeNull();
    expect(up.calls.length).toBe(before);
    expect(m.peekBox()!.services[0]!.status).toBe("ok");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/edge/pxCloudOps.test.ts`
Expected: FAIL（`presetUnconfiguredText` 未导出；gmail 走到 registerClient 回 `no_dcr`）

- [ ] **Step 3: 文案**

`src/shared/remote/pxCloud.ts`，紧跟 `CLOUD_TEXT` 对象之后：

```ts
/** 预置客户端的条目、edge 上还没配那套凭据（#1619）：不是用户的错，也不是「去电脑上接」 */
export function presetUnconfiguredText(name: string): string {
  return `${name} 还没开放，稍后再试`;
}
```

- [ ] **Step 4: `pxCloudOps.ts` 预置分支**

import：`MCP_CATALOG, type CatalogEntry` 那行改成 `MCP_CATALOG, type CatalogEntry, type PresetClientName`；`pxCloud.js` 那组 import 里加 `presetUnconfiguredText`。

`CloudOpsDeps` 里 `callbackUrl: string;` 之后加：

```ts
  /** 预置 OAuth 客户端（#1619）：worker 从 Worker secret 现取，没配 = null。缺省（测试不注）也当没配 */
  presetClient?: (name: PresetClientName) => { client_id: string; client_secret: string } | null;
```

`upstreamText` 之后加：

```ts
/** 记下的 clientInformation 若是预置客户端（只记了名字），补上现取的 secret 再外呼；不是预置的原样返回；
    预置但此刻取不到 = null。**补出来的这份只给外呼用，绝不写回箱 / pending**（密钥只存 Worker secret 一处） */
function resolveClient(d: CloudOpsDeps, ci: Record<string, unknown>): Record<string, unknown> | null {
  if (ci.preset !== "google") return ci;
  const p = d.presetClient?.(ci.preset) ?? null;
  return p ? { ...ci, client_secret: p.client_secret } : null;
}
```

`cloudConnect` 的 OAuth 分支：在注释「浏览器登录：外呼（发现 + 注册）全部在前……」那行**之前**加：

```ts
  // 预置客户端没配：在任何外呼之前就回（#1619）
  const preset = entry.presetClient !== undefined ? (d.presetClient?.(entry.presetClient) ?? null) : undefined;
  if (preset === null) return fail(503, "preset_unconfigured", presetUnconfiguredText(entry.name));
```

把

```ts
  const reg = await registerClient(d.fetch, disc.meta, d.callbackUrl);
  if (!reg.ok) {
    d.log?.(`[px-cloud] register ${serverId} ${reg.code}: ${reg.message}`);
    return fail(reg.code === "no_dcr" ? 422 : 502, reg.code, reg.code === "no_dcr" ? CLOUD_TEXT.noDcr : `没接上：${reg.message}`);
  }
```

换成

```ts
  // 预置客户端只记 client_id + 名字，secret 等换 token / 续期时再现取（resolveClient）
  let client: Record<string, unknown> & { client_id: string };
  if (preset && entry.presetClient !== undefined) {
    client = { client_id: preset.client_id, preset: entry.presetClient };
  } else {
    const reg = await registerClient(d.fetch, disc.meta, d.callbackUrl);
    if (!reg.ok) {
      d.log?.(`[px-cloud] register ${serverId} ${reg.code}: ${reg.message}`);
      return fail(reg.code === "no_dcr" ? 422 : 502, reg.code, reg.code === "no_dcr" ? CLOUD_TEXT.noDcr : `没接上：${reg.message}`);
    }
    client = reg.client;
  }
```

同函数里 `clientInformation: reg.client` 改成 `clientInformation: client`；最后的 `authorizeUrl({...})` 改成：

```ts
      authorizeUrl: authorizeUrl({
        meta: disc.meta, clientId: client.client_id, redirectUri: d.callbackUrl, challenge, state, resource,
        ...(entry.scopes ? { scopes: entry.scopes } : {}),
        ...(entry.authorizeParams ? { extra: entry.authorizeParams } : {}),
      }),
```

`cloudCallback`：在 `const tok = await exchangeCode(...)` **之前**加：

```ts
  const client = resolveClient(d, pending.clientInformation);
  if (!client) {
    const name = (d.catalog ?? MCP_CATALOG).find((e) => e.id === pending.catalogId)?.name ?? pending.catalogId;
    d.log?.(`[px-cloud] callback ${pending.catalogId} preset_unconfigured`);
    return { ok: false, message: presetUnconfiguredText(name) };
  }
```

并把 `exchangeCode` 那段的 `client_secret` 来源从 `pending.clientInformation` 换成 `client`：

```ts
    ...(typeof client.client_secret === "string" ? { clientSecret: client.client_secret } : {}),
```

（`oauth` 落箱那行仍用 `pending.clientInformation`，不动。）

`cloudRefresh`：把

```ts
  const snapshotRefresh = refreshTokenOf(svc.oauth);
  const result = await refreshCloudOAuth(d.fetch, svc.oauth);
```

换成

```ts
  const snapshotRefresh = refreshTokenOf(svc.oauth);
  const stored = svc.oauth.clientInformation;
  const client = stored ? resolveClient(d, stored) : undefined;
  if (client === null) {
    // 预置客户端此刻取不到 secret：是我们没配好，不是用户登录坏了——按抖动处理，不标 needs_login（#1619）
    d.log?.(`[px-cloud] refresh ${serverId} preset_unconfigured`);
    return null;
  }
  const raw = await refreshCloudOAuth(d.fetch, client ? { ...svc.oauth, clientInformation: client } : svc.oauth);
  // 写回 / 交回的那份换回箱里记的 clientInformation：补进去的 secret 不落盘
  const result = raw.kind === "ok" && stored ? { ...raw, oauth: { ...raw.oauth, clientInformation: stored } } : raw;
```

（下面原有的 `result.kind` 判断与写回逻辑不动。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/edge`
Expected: PASS（新 describe 六条 + 原有全部）

- [ ] **Step 6: Worker 接线**

`services/edge/src/worker.ts` 的 `Env` 里 `STRIPE_WEBHOOK_SECRET?: string;` 之后加：

```ts
  /** 手机接 Gmail 用的预置 Google OAuth 客户端（#1619，Web application 类型，回调填 edge 的 /px/v1/cloud/callback）。
      `wrangler secret put GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`。任一没配 = 「Gmail 还没开放」 */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
```

`cloudDeps()` 返回对象里 `callbackUrl: …,` 那行之后加：

```ts
      presetClient: (name) => {
        if (name !== "google") return null;
        const id = this.env.GOOGLE_OAUTH_CLIENT_ID;
        const secret = this.env.GOOGLE_OAUTH_CLIENT_SECRET;
        return id && secret ? { client_id: id, client_secret: secret } : null;
      },
```

`services/edge/wrangler.jsonc` 的 secret 注释清单里，`STRIPE_WEBHOOK_SECRET` 那行之后加两行（照现有缩进与 `//` 格式）：

```jsonc
  //   npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID      # 手机接 Gmail 的预置客户端（#1619）
  //   npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
```

- [ ] **Step 7: 类型检查 + edge 测试**

Run: `npx tsc --noEmit && npx vitest run tests/edge`
Expected: tsc 无输出；测试 PASS

- [ ] **Step 8: 提交**

```bash
git add src/shared/remote/pxCloud.ts services/edge/src/pxCloudOps.ts services/edge/src/worker.ts services/edge/wrangler.jsonc tests/edge/pxCloudOps.test.ts
git commit -m "feat(edge): 预置 OAuth 客户端——Gmail 在云端接不走动态注册（#1619）" -m "Google 的授权服务器没有 registration_endpoint，所以条目带 presetClient 时用 edge 持有的那套客户端。secret 只在 Worker secret：pending 与箱里只记 client_id + 名字，换 token / 续期那一刻现取补上，写回前换回去——轮换 secret 不用全员重登，箱子泄露也带不出我们的客户端密钥。没配凭据在任何外呼之前回 503；续期时取不到按抖动处理，不让用户重登。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 桌面——预置条目标成「在手机上接」

**Files:**
- Modify: `src/renderer/src/lib/mcpDirectory.ts:241-249`（`installSlot`）
- Modify: `src/renderer/src/lib/mcpDetail.ts:41-50`（`connectorFacts`）
- Modify: `src/renderer/src/components/McpConnectorPage.tsx:85,96,165`
- Modify: `src/tools/mcpCatalog.ts:33-35`（`render`）
- Test: `tests/renderer/mcpDirectoryLogic.test.ts`、`tests/renderer/mcpDetail.test.ts`、`tests/tools/mcpCatalog.test.ts`

**Interfaces:**
- Consumes: `desktopBlocked`、`PRESET_ON_PHONE`（Task 1）

- [ ] **Step 1: 写失败的测试**

先读这三个测试文件头部，照它们已有的造 item / entry 的方式写。要钉的断言：

`tests/renderer/mcpDirectoryLogic.test.ts`（造一个 `installed: null`、`entry` = 目录里的 gmail 的 `DirectoryItem`）：

```ts
  it("预置客户端的条目（Gmail）：不发「添加」，说在手机上接（#1619）", () => {
    const gmail = MCP_CATALOG.find((e) => e.id === "gmail")!;
    expect(installSlot(itemOf(gmail, null), false)).toEqual({ kind: "note", label: "在手机上接", title: PRESET_ON_PHONE });
  });
```

（`itemOf` 换成该文件里已有的造 item 的写法；没有就内联 `{ entry: gmail, installed: null, …该类型其余必填字段 }`。）

`tests/renderer/mcpDetail.test.ts`：

```ts
  it("预置客户端的条目不出「授权」这一行（横幅已经说了在手机上接）", () => {
    const gmail = MCP_CATALOG.find((e) => e.id === "gmail")!;
    expect(connectorFacts(gmail).some((f) => f.label === "授权")).toBe(false);
  });
```

`tests/tools/mcpCatalog.test.ts`：

```ts
  it("预置客户端的条目：告诉水獭别装，去手机上接（#1619）", () => {
    const gmail = MCP_CATALOG.find((e) => e.id === "gmail")!;
    expect(render(gmail)).toContain(`现在接不上：${PRESET_ON_PHONE}`);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/mcpDirectoryLogic.test.ts tests/renderer/mcpDetail.test.ts tests/tools/mcpCatalog.test.ts`
Expected: FAIL（gmail 拿到的是 `{ kind: "add" }`、有「授权」行、render 没那句话）

- [ ] **Step 3: 实现**

`src/renderer/src/lib/mcpDirectory.ts`：import 加 `desktopBlocked`（从 `@shared/mcpCatalog` 或该文件已有的 mcpCatalog import 路径）。`installSlot` 里

```ts
  if (item.installed !== "connected" && item.entry.blocked !== undefined) {
    return { kind: "note", label: "暂时连不上", title: item.entry.blocked };
  }
```

换成

```ts
  // 预置客户端的条目（Gmail，#1619）同走这条：桌面这一版接不了，说去手机上接，不叫「暂时连不上」
  const blocked = desktopBlocked(item.entry);
  if (item.installed !== "connected" && blocked !== undefined) {
    return { kind: "note", label: item.entry.blocked === undefined ? "在手机上接" : "暂时连不上", title: blocked };
  }
```

`src/renderer/src/lib/mcpDetail.ts`：import `desktopBlocked`；`if (entry.blocked === undefined && entry.authNote.trim() !== "")` 改成 `if (desktopBlocked(entry) === undefined && entry.authNote.trim() !== "")`。

`src/renderer/src/components/McpConnectorPage.tsx`：import `desktopBlocked`；组件里取一次 `const blocked = desktopBlocked(entry);`，把 85 行的 `entry.blocked !== undefined` 换成 `blocked !== undefined`、96 行的 `{entry.blocked}` 换成 `{blocked}`、165 行的 `blocked={entry.blocked}` 换成 `blocked={blocked}`。

`src/tools/mcpCatalog.ts`：import 行加 `desktopBlocked`；

```ts
  if (e.blocked !== undefined) {
    lines.push(`现在接不上：${e.blocked}。别装这台，把这句原因直接告诉用户。`);
  }
```

换成

```ts
  const blocked = desktopBlocked(e);
  if (blocked !== undefined) {
    lines.push(`现在接不上：${blocked}。别装这台，把这句原因直接告诉用户。`);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer tests/tools`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/lib/mcpDirectory.ts src/renderer/src/lib/mcpDetail.ts src/renderer/src/components/McpConnectorPage.tsx src/tools/mcpCatalog.ts tests/renderer/mcpDirectoryLogic.test.ts tests/renderer/mcpDetail.test.ts tests/tools/mcpCatalog.test.ts
git commit -m "feat(desktop): 预置客户端的条目标成「在手机上接」（#1619）" -m "Gmail 要的 Web application 客户端回调写死，桌面是随机回环端口，这一版接不了。不标的话桌面会发「添加」→ 动态注册 → 必失败；水獭的 mcp_catalog 也要知道别装。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: ADR + 代码地图 + 门禁 + PR

**Files:**
- Create: `docs/adr/0369-预置oauth客户端-密钥只在worker-secret-箱里只记名字-scope写死在目录.md`（先 `git fetch origin` 再 `git ls-tree origin/main docs/adr/` 看最大编号，取 max+1；不是 0369 就用实际的号，并把 Task 1 那行注释 `ADR-0369` 改成实际号）
- Modify: `docs/where-to-find-things.md`

- [ ] **Step 1: 写 ADR**

照 `docs/adr/0336-*.md` 的格式（状态 / Issue / 背景 / 决定 / 代价）。内容要点，逐条写进「决定」：
1. 没有动态注册的厂商（Google）由 edge 持有预置客户端，目录 `presetClient` 声明名字；凭据只放 Worker secret（`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`）。
2. pending 与 cloud 箱只记 `{ client_id, preset }`；换 token / 续期时现取 secret，写回前换回。理由：单点存放、可轮换、箱泄露不带出客户端密钥。
3. scope 由目录写死（`scopes`），不用资源元数据的全集；`authorizeParams` 带 `access_type=offline` + `prompt=consent`；保留键不许覆盖。
4. 没配凭据 = 503「还没开放」，在任何外呼之前；续期取不到 = transient。
5. 桌面这一版不接（`desktopBlocked`），理由：Web application 客户端回调要精确，桌面随机回环端口。
「代价与已知未做」：Testing 状态 refresh_token 7 天过期 / 100 测试用户上限 / 受限 scope 要 Google 验证 + CASA；Developer Preview Program 是否只收 Workspace 账号未验；`resource` 参数 Google 接受与否待真机；桌面接入的两条路（spec §7）。

- [ ] **Step 2: 代码地图**

`docs/where-to-find-things.md` 里找连接器 / edge cloud 那一节（grep `pxCloudOps`），加一行：

```md
- 预置 OAuth 客户端（Gmail，#1619，ADR-0369）：目录字段 `presetClient` / `scopes` / `authorizeParams` 在 `src/shared/mcpCatalog.ts`；edge 侧 `resolveClient` 在 `services/edge/src/pxCloudOps.ts`，secret 从 `worker.ts` 的 `cloudDeps().presetClient` 现取——**箱子里没有 secret**，别在箱里找
```

- [ ] **Step 3: 门禁**

Run: `npm test`（输出重定向到日志，看日志末尾与退出码，**不接 `| tail`**）
Expected: 退出码 0；tsc（根 + mobile）无错；vitest 全绿

- [ ] **Step 4: 提交 + 推 + PR**

```bash
git add docs/adr docs/where-to-find-things.md
git commit -m "docs(adr): 预置 OAuth 客户端的取舍（#1619）" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin HEAD
```

PR：标题 `feat(edge, mobile): 手机上接 Gmail——edge 用预置 OAuth 客户端`，正文 `Closes #1619`、spec 与 plan 路径、上线顺序（edge 先、手机后；凭据可晚于部署）、维护者清单指向 spec §6、末尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。CI 绿后 merge commit 合并；合并后再 fetch 核一次 ADR 号没撞（`git -c core.quotePath=false ls-tree --name-only origin/main docs/adr/` 看前四位唯一）。

- [ ] **Step 5: issue 里贴维护者清单**

`gh issue comment 1619 --body-file <文件>`：把 spec §6 的七步原样贴进去，开头一句「代码已合（PR #…），以下是你要做的」。
