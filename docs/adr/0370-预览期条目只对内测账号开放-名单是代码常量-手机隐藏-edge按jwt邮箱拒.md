# ADR-0370：预览期条目只对内测账号开放——名单是代码常量，手机目录隐藏，edge 按 JWT 邮箱拒

- 状态：已采纳（2026-10-05）
- Issue：#1636；前置：#1619 / ADR-0369（Gmail 走 edge 预置 OAuth 客户端）

## 背景

Gmail 的官方 MCP（`gmailmcp.googleapis.com`）还在开发者预览。用它必须加入 Google Workspace Developer Preview Program，
2026-10-05 用 `stan@mrotto.agency` 为 Google Cloud 项目 Mr Otto（编号 613203612973）提交了申请，申请即同意 Program Terms，
其中两条直接管我们怎么发：GA 之前不得把预览功能放进面向公众的应用；未经 Google 授权不得让外部用户使用预览应用。

而手机的「接入应用」目录是打在包里的 `MCP_CATALOG`：下一版手机包一发，**所有**用户都会看到 Gmail 这一行。
非测试用户点了会在 Google 登录页被拒（OAuth 应用处于 Testing），但这一行本身就是对公众的展示。

## 决定

1. **目录条目加 `preview: true`**（Gmail 是第一条）。GA 之后删掉这一格即拆闸，不留开关。
2. **内测名单是 `src/shared/mcpCatalog.ts` 里的代码常量 `PREVIEW_TESTERS`**，判据 `isPreviewTester(email)`：
   不分大小写、去空白，空串 / 未登录永远不命中。名单要与 Google Cloud 项目 OAuth「测试用户」是同一批人，加人两边都加。
   否掉 DB 标记的理由同 `onboardingTestAccount.ts`（#332）：手机目录在包里、edge 也要认，常量是唯一一份两边都读得到的东西。
3. **两道闸，各管一件事**：
   - 手机 `connectCatalog(view, query, viewerEmail)` 对不在名单里的账号不列 preview 条目——这是「不对公众展示」；
     已经接上的照常列（真接上了以现实为准）。邮箱取自 Supabase 会话。
   - edge `cloudConnect` 对 preview 条目核邮箱，不在名单里回 **403 `preview_only`**「Gmail 还在内测，暂时只对内测账号开放」，
     在任何外呼与限速记账之前——这是「不让外部用户用上」，旧版手机包、直接调接口都绕不过去。
     邮箱取自 edge 验过签的 JWT claim（`pxIdentify` 带出来，`cloud_connect` 转发时附上），**请求体里自报的不算**。
4. 桌面不变：预置客户端的条目本来就标「在手机上接」（ADR-0369）。

## 代价

- 加一个内测账号 = 改常量 + 部署 edge + 手机发一版，外加 Google 后台加测试用户（上限 100）。预览期人少，接受。
- 名单里的邮箱进了公开仓库。这两个都是维护者自己的账号；外部内测者要进名单前先想清楚这一点。
- 回调与续期不再核名单：pending 只会由通过了闸的 connect 产生，被移出名单的人已接上的那台仍能用到 refresh_token 失效为止。
