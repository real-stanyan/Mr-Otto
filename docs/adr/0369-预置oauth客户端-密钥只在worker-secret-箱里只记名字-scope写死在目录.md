# ADR-0369：预置 OAuth 客户端——密钥只在 Worker secret，箱里只记名字，scope 写死在目录

- 状态：已采纳（2026-10-05）
- Issue：#1619；相关：#1594（手填 client，前提已更正）、ADR-0336（手机接应用）、ADR-0309（桌面手填 client）；spec：`docs/superpowers/specs/2026-10-05-gmail-cloud-connector-design.md`

## 背景

手机上接 Gmail。官方 remote MCP（`https://gmailmcp.googleapis.com/mcp/v1`）的授权服务器是 `accounts.google.com`，它的元数据
**没有 `registration_endpoint`**：ADR-0336 决定 2 里 edge 只有动态注册一条路，走到 `registerClient` 就是 `no_dcr`，接不了。
Google 要的是预先在 Google Cloud 后台建好的「Web application」客户端，回调地址由我们自己填（没有厂商白名单这道关）。
另外资源元数据的 `scopes_supported` 是全集（含 `https://mail.google.com/` 整箱权限），照搬会向用户要远超 Gmail MCP 实际需要的权限；
Google 也只在 `access_type=offline` + `prompt=consent` 时才给 `refresh_token`。

## 决定

1. **没有动态注册的厂商由 edge 持有一套预置客户端，目录用 `presetClient` 只声明它的名字。** 目前只有 `"google"`；凭据
   `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` 只放 Worker secret，`worker.ts` 的 `cloudDeps().presetClient` 从 env 现取，
   任一缺 = `null`。条目带 `presetClient` 时 `cloudConnect` 不调 `registerClient`，其余发现、PKCE、回调照旧。
   否掉：每人自己建 client 再粘贴（Gmail 用户门槛不可接受，#1594 留给真需要它的场景）；等 Google 出动态注册（没有迹象）。
2. **pending 与 cloud 箱只记 `{ client_id, preset }`，secret 不进箱。** 换 token（`cloudCallback`）和续期（`cloudCall` 里那次
   `refreshCloudOAuth`）之前由 `resolveClient` 现取 secret 补进去再发，补出来的那份只给这一发外呼用，绝不写回。理由：secret 只存一处，
   轮换不用让所有人重登；箱子（DO 存储 / 备份 / 日志）泄露也不带出我们的客户端密钥。
3. **「这个客户端是不是我们的预置客户端」只看目录条目，不看存下来的 `preset` 字段。** 这是实现时才冒出来的口子，spec 里没有：
   普通动态注册应用的 `clientInformation` 是厂商注册回包**原样**落盘，厂商完全可以在回包里塞一个 `preset: "google"`；若
   `resolveClient` 只看存下来的 `preset`，我们就会把 Google 的 `client_secret` 发给这家厂商自己的 token 端点。所以
   `resolveClient(d, catalogId, ci)` 按 `catalogId` 去目录里找条目：`entry.presetClient` 没有 → 原样返回、永不补 secret；
   有 → 存的 `ci.preset` 必须等于 `entry.presetClient`，再补现取的 secret，对不上或此刻取不到 = `null`。同时 `cloudConnect` 在存厂商
   注册回包前把 `preset` 字段剥掉（belt-and-braces：`resolveClient` 本就不看它，剥掉是不让这个标记字段在箱里出现歧义）。
4. **scope 由目录写死，不用资源元数据的全集。** 条目的 `scopes`（Gmail：`gmail.readonly` + `gmail.compose`）优先于 `scopes_supported`；
   `authorizeParams`（Gmail：`access_type=offline`、`prompt=consent`）逐个 set 到授权 URL 上，但 `client_id` / `redirect_uri` /
   `state` / `code_challenge*` / `response_type` 是保留键，目录给了也忽略（目录测试也拦）。`resource` 参数照旧带（MCP 规范要求）。
   `refreshCloudOAuth` 不改：Google 续期回包不带新 `refresh_token`，既有合并 `{ ...oauth.tokens, ...tokens }` 保留旧的。
5. **没配凭据 = 503 `preset_unconfigured`「X 还没开放，稍后再试」，且在任何外呼之前就回。** 不先发现再失败，没配好的环境不对 Google 打一发。
   回调时 secret 被删了：换 token 前现取失败，回 `preset_unconfigured`，深链照常回手机，手机拉视图看到没接上。续期时取不到：按
   `transient` 处理（凭据没坏、是我们这边没配好，不许把用户标成 `needs_login` 要重登）。手机不提前置灰，点「去登录」弹出 edge 回的那句话。
6. **桌面这一版不接，`desktopBlocked(entry)` 回「这个应用在手机上接」。** Web application 客户端的回调地址要精确匹配，桌面是随机回环端口。
   桌面读 `entry.blocked` 的几处与 `mcp_configure` 装目录条目那条路都改用 `desktopBlocked`。

## 上线顺序

edge 先、手机后：手机目录来自手机包里打进去的 `MCP_CATALOG`，反过来新手机点 Gmail 会撞上不认识 `presetClient` 的旧 edge，回 `no_dcr`。
凭据（`wrangler secret put` 两个）可以晚于部署，没配之前点了只看到「Gmail 还没开放」。维护者清单见 spec §6。

## 代价与已知未做

- Testing 状态下 `refresh_token` 7 天过期（公开资料，未实测），Google 拒续期走既有 `dead` → `needs_login`，手机上点一下重新登录。
- 未验证应用最多 100 个测试用户，登录页带「未经验证」提示；`gmail.readonly` / `gmail.compose` 是受限 scope，对外开放要 Google 应用验证 + CASA 安全评估，
  钱和时间的事。
- Developer Preview Program 是否只收 Workspace 账号：**未验**（文档写的是必须加入）。
- `resource` 参数 Google 接不接受：**待真机**；不接受再给条目加开关。
- 桌面接 Gmail 两条路（spec §7）：另建 Desktop 类型客户端（要先验 Gmail MCP 认不认它的 token），或让桌面也走 edge 登录。
- 凭据只在 Worker secret：轮换要人手动 `wrangler secret put`，没有自动轮换；换来的是箱里没有可偷的东西。
