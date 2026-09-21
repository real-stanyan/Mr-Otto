# ADR-0309：手填的 OAuth 客户端凭据自成一格，不借用 DCR 那一格

- 状态：已采纳
- 日期：2026-09-21
- 关联：#697、ADR-0121（凭据落点与 0600）、ADR-0171（精选层的门槛）、ADR-0050（SDK 单点 import）

## 背景

`mcpAuthStore` 的 `clientInformation` **只由** MCP SDK 的动态客户端注册（DCR）回调写入。
授权服务器不提供 `registration_endpoint` 的那些（Slack / Asana / Figma / HubSpot / Vercel /
Google Drive）因此永远走不通 OAuth —— 用户得先去服务商后台注册一个应用、拿到一对
`client_id` / `client_secret` 再填进客户端，而全仓没有这个入口。ADR-0171 当时把这几家
挡在精选层外面，并把能力缺口记成 #697。

## 决定

### 1. 手填的那对存在**另一格** `manualClient`，不复用 `clientInformation`

`clientInformation` 的语义是「DCR 那一次的产物」，仓里有两处逻辑**按这个语义行事**：

- `needsFreshRegistration`（#471）会在 loopback 端口变了时把它丢掉重注册；
- SDK 的 `saveClientInformation` 回调会覆盖它。

两处对 DCR 产物都是对的（那是可再生的缓存，丢了重跑一次注册就有），对手打的东西都是错的
（丢了要用户回服务商后台重抄一遍）。**混在一格里，这两处会把用户手打的东西当成缓存。**

所以 `needsFreshRegistration` 对有 `manualClient` 的记录一律回 false：它不是注册的产物，
服务商后台里的 redirect_uri 由用户自己填，我们既不知道也改不了，"重注册"这条出路对它
不存在。

### 2. 取值顺序：**手填在前**

`clientInformation()` 回 `manualClient ?? clientInformation`。这一格就是「要不要跑 DCR」的
开关（SDK 只在它返回 undefined 时才去注册）。用户会走到手填这条路，前提正是那台服务器的
DCR 走不通或注册出来的客户端权限不对；他填完之后还去用盘上那份旧注册，等于把他刚做的事
当没看见。

`setMcpManualClient` 存的时候还会**丢掉旧的 `clientInformation` 与 `codeVerifier`**（第二道）：
一次半途而废的授权留下的 verifier 会在后面某一步冒出来，而那时的症状是一句 `invalid_client`，
没人会想到是这里。**`tokens` 不动** —— 换客户端凭据不该把一份还能 refresh 的授权也作废。

### 3. 值只进不出：过桥的是**一个布尔**

`client_id` / `client_secret` 落在 `mcp-auth.json`（0600，ADR-0121），不进 `mcp.json`
（那份用户手编、要与 Claude Code 的格式兼容）、不进事件日志、不回流渲染层。
`McpServerStatus` 因此只多一格 `oauthClient: boolean`，在 `index.ts` 的 `mcpSnapshot` 里
按 `manualClient !== undefined` 算出来 —— 这一步有一条读源码的断言钉着
（`tests/main/mcpAuthNoLeak.test.ts`），因为把整条记录展开进快照是个不会变红的改法。

代价：输入框永远是空的（值回不来），所以「已配置」这件事必须在界面上**说出口**，
否则用户会以为上次没填成。

### 4. 这一格挂在 `index.ts` 的 snapshot 上，不挂在 `mcpHub` 上

hub 刻意不认识凭据这一层（它手上只有 `clearAuth` 一个口子）。为了一个布尔让它开始读
凭据文件，是拿一条清楚的边界换一行方便。

### 5. 保存不自动授权

填凭据与「现在就去授权」是两件事（用户可能先把几台都填好再挨个点），而授权会开系统浏览器 ——
一个会开浏览器的副作用不该搭在保存按钮上。

## 后果

- Slack / Asana / Figma / HubSpot / Vercel / Google Drive 这条路**技术上通了**。
- **但目录（`mcpCatalog.ts`）一条都没加**：ADR-0171 定的精选层门槛是「人工核过、装上能用」，
  而核它要真去服务商后台注册应用、真跑一次授权。那是维护者的动作，#697 的第 4 步仍然欠着。
- `client_secret` 是本仓第二种落在 `mcp-auth.json` 里的凭据，`mcpAuthNoLeak` 那条不变量
  现在同时守着它。
- 公开客户端仍然走 PKCE：`clientMetadata.token_endpoint_auth_method` 保持 `"none"`，
  那一格只在 DCR 注册时发出去，而有手填凭据时我们根本不注册。带不带 secret 由 SDK 按
  `clientInformation.client_secret` 在不在、以及授权服务器自报支持哪些方法来选
  （`client_secret_basic` / `client_secret_post` / `none`），我们一行都不重写。
