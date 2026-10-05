# 手机上接 Gmail：edge 用我们预置的 OAuth 客户端（#1619）

- 日期：2026-10-05
- Issue：#1619；相关：#1594（手填 client，前提已更正）、ADR-0336（手机接应用）、ADR-0309（桌面手填 client）
- 范围：手机 / 云端这一条。桌面这一版只把 Gmail 标成「在手机上接」，不做接入。

## 1. 背景与已验证的事实

维护者要「做 Gmail」。2026-10-05 实测与文档：

- 官方 remote MCP：`https://gmailmcp.googleapis.com/mcp/v1`（Streamable HTTP，开发者预览）。`initialize` 回 200；
  资源元数据 `/.well-known/oauth-protected-resource/mcp/v1` 写 `authorization_servers: ["https://accounts.google.com/"]`，
  `scopes_supported` 列了十几个（含 `https://mail.google.com/` 整箱权限）。
- `accounts.google.com` 的授权服务器元数据**没有 `registration_endpoint`**：edge 现在只有动态注册一条路（ADR-0336 决定 2），
  走到 `registerClient` 就是 `no_dcr` / 422，接不了。
- Google 文档（Gmail「Configure the MCP server」）：要启用 `gmail.googleapis.com` 与 `gmailmcp.googleapis.com` 两个 API；
  OAuth 客户端类型「Web application」；scope 是 `gmail.readonly` + `gmail.compose`；**必须加入 Google Workspace Developer
  Preview Program**；工具 9 个（`search_threads` / `get_thread` / `create_draft` / `list_drafts` / `list_labels` /
  `label_*` / `unlabel_*`），**不能直接发信**，只能起草。
- 与 Square 的区别：Web application 客户端的回调地址由我们自己在 Google Cloud 后台填，没有厂商白名单这道关。
  门槛换成了 Google 的应用验证：上面两个 scope 属于受限 scope，未验证的应用只给最多 100 个测试用户，登录页带「未经验证」提示；
  Testing 状态下 refresh_token 7 天过期（公开资料，未实测）。

## 2. 决定

**预置客户端**：Google 的 OAuth 客户端由我们建一套（维护者在 Google Cloud 后台建），client_id / client_secret 放 edge 的
Worker secret。目录条目声明「用哪一套预置客户端」，edge 看到它就跳过动态注册。用户点「去登录」即可，什么都不用填。

否掉的：
- **每人自己建 client 再粘贴**（#1594 原方案的形状）：对 Gmail 用户门槛不可接受；#1594 留给真需要它的场景。
- **等 Google 出动态注册**：没有任何迹象。

## 3. 改动

### 3.1 目录（`src/shared/mcpCatalog.ts`）

`CatalogEntry` 加三个可选字段（只对 `auth: "oauth"` 有意义）：

```ts
/** 用我们预置的哪一套 OAuth 客户端（不走动态注册）。值是 edge 上那套凭据的名字，不是凭据本身 */
presetClient?: "google";
/** 写死要的 scope；有它就不用资源元数据的 scopes_supported（Gmail 那份含整箱权限） */
scopes?: readonly string[];
/** 授权 URL 上额外带的参数（Google 要 access_type=offline + prompt=consent 才给 refresh_token） */
authorizeParams?: Readonly<Record<string, string>>;
```

新条目：

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
  authNote: "在手机上接：登录 Google 账号并同意读邮件、管草稿",
  presetClient: "google",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
  authorizeParams: { access_type: "offline", prompt: "consent" },
  icon: "gmail",
}
```

`icon: "gmail"` 要配图标资源（桌面 `src/renderer/src/assets/mcp/` 与手机 `appIcons.generated.ts`，按现有生成脚本走）。

### 3.2 edge

- `Env` 加 `GOOGLE_OAUTH_CLIENT_ID?` / `GOOGLE_OAUTH_CLIENT_SECRET?`，`wrangler.jsonc` 的 secret 注释清单补上这两行。
- `CloudOpsDeps` 加 `presetClient(name): { client_id: string; client_secret: string } | null`，`worker.ts` 的 `cloudDeps()`
  从 env 读；任一缺 = null。
- `cloudConnect` 的 OAuth 分支：条目带 `presetClient` 时
  - 预置凭据为 null → **503 / `preset_unconfigured` / 「Gmail 还没开放，稍后再试」**（文案按条目名拼），**在发现之前就返回**，不外呼；
  - 否则照常发现（拿 authorize / token 端点与 resource），**不调 `registerClient`**。
- **密钥不进箱**：pending 与落箱的 `clientInformation` 只记 `{ client_id, preset: "google" }`。换 token（`cloudCallback`）与
  续期（`cloudCall` 里那次 `refreshCloudOAuth`）之前，按 `preset` 从 deps 现取 secret 补进去再发；现取不到 → 换 token 时回
  `preset_unconfigured`，续期时按 `transient` 处理（凭据没坏，是我们这边没配好，不许把用户标成要重登）。
  理由：secret 只存一处，轮换 secret 不用让所有人重登；箱子泄露也不带出我们的客户端密钥。
- `authorizeUrl`：`scope` 优先用条目的 `scopes`；再把 `authorizeParams` 逐个 set 上去（不许覆盖 `client_id` / `redirect_uri` /
  `state` / `code_challenge*` / `response_type` 这几个，覆盖了就忽略，目录测试也拦）。
- `resource` 参数照旧带（MCP 规范要求；Claude 接同一台也带，预期 Google 接受——真机验收时确认，不接受再加条目开关）。
- `refreshCloudOAuth` 不改：Google 续期回包不带新 refresh_token，现有合并（`{ ...oauth.tokens, ...tokens }`）保留旧的。

### 3.3 手机

不改代码：Gmail 是 http + oauth + 无参数 → `connectKind` = browser，自动出现在「接入应用」目录里。没配预置凭据时，
点「去登录」弹窗里显示 edge 回的那句中文（不是提前置灰：提前置灰要么改发版、要么给云端视图加字段，不值）。
`MOBILE_OAUTH_BLOCKED` 不加 gmail。

### 3.4 桌面

`mcpCatalog.ts` 加 `desktopBlocked(entry)`：`entry.blocked ?? (entry.presetClient ? "这个应用在手机上接：Mr Otto 手机 App →「接入应用」" : undefined)`。
桌面读 `entry.blocked` 的几处（`McpConnectorPage`、`McpServerEditor` 的入参、`mcpDirectory.installSlot`、`mcpDetail`）改用它。
智能体的 `mcp_configure` 装目录条目时同样拦（找到它装目录条目的那条路，带 `presetClient` 的回这句话）。

### 3.5 ADR

新写一条：「预置 OAuth 客户端：凭据放 edge 的 Worker secret，箱子里只记名字，scope 写死在目录」。编号合并时取。

## 4. 错误处理一览

| 情形 | 结果 |
|---|---|
| 没配 `GOOGLE_OAUTH_*` | 503 `preset_unconfigured`，「Gmail 还没开放，稍后再试」，不外呼 |
| 发现失败 | 原样 502 `discovery` |
| 回调时 secret 被删了 | 换 token 前现取失败 → `preset_unconfigured`，深链照常回手机，手机拉视图看到没接上 |
| 续期时 secret 取不到 | `transient`，这次调用 502「暂时连不上」，不标 `needs_login` |
| Google 拒 refresh（7 天过期等） | 原样 `dead` → `needs_login`，手机上「点一下重新登录」 |
| 账号不在测试用户 / 预览计划里 | Google 登录页自己报错，回调带 `error`，按现有回调失败路径处理 |

## 5. 测试

- `tests/edge/pxCloudOps.test.ts`：预置条目不调注册端点（fetch 桩断言没打 registration）；授权 URL 的 scope = 条目 scopes、带
  `access_type` / `prompt`；保留键不被覆盖；没配凭据 503 且零外呼；pending 与落箱里没有 secret；换 token 与续期的 body 里有 secret；
  续期时 secret 缺 → transient。
- `tests/edge/pxOAuth.test.ts`：`authorizeUrl` 的 scope 覆盖与额外参数。
- 目录测试：`presetClient` 只出现在 oauth + http 条目上；`authorizeParams` 不含保留键；`scopes` 非空。
- 桌面：`desktopBlocked` 对 gmail 回那句话、对普通条目等于 `entry.blocked`。
- 手机：`connectCatalog` 里 gmail 是 browser 且 `blocked === null`。

## 6. 维护者清单（代码合并后）

1. 加入 Google Workspace Developer Preview Program（文档写的是必须）。
2. Google Cloud 建项目；启用 `gmail.googleapis.com` 与 `gmailmcp.googleapis.com`。
3. Google Auth Platform → Branding / Audience：外部用户、Testing 状态，把自己（和要内测的人）加进测试用户；Data Access 里加上
   `gmail.readonly` 与 `gmail.compose`。
4. Clients → Create Client → Web application，Authorized redirect URI 填 `https://edge.mrotto.agency/px/v1/cloud/callback`。
5. `cd services/edge && npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID`，再 `npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET`。
6. 部署 edge（`npm run deploy:edge`），再给手机发一版：手机目录来自手机包里打进去的 `MCP_CATALOG`，发版之后才出现 Gmail 这一行。
   顺序 edge 先、手机后（同 ADR-0336 上线顺序）：反过来，新手机点 Gmail 会撞上不认识 `presetClient` 的旧 edge，回 `no_dcr`。
   凭据（第 5 步）可以晚于部署：没配之前点了只看到「Gmail 还没开放」。
7. 真机验收：手机接 Gmail → 智能体搜一次邮件、起草一封 → 一小时后再调一次（验 refresh_token）。

## 7. 未做 / 后续

- 桌面接 Gmail：Web application 客户端要精确回调地址，桌面是随机回环端口。两条路：另建 Desktop 类型客户端（Gmail MCP 文档只写
  Web application，要先验 Desktop 客户端拿到的 token 它认不认），或让桌面也走 edge 登录。
- 对外开放：Google 应用验证 + 受限 scope 的安全评估（CASA），钱和时间的事。
- Calendar / Drive：同一套预置客户端，加条目即可（各自的官方 MCP 地址与 scope 另查）。
