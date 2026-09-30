# 手机 App 里接入应用（云端连接器）——设计

- 日期：2026-09-30
- Issue：#1430（相关：#1376 手机上应用连接状态没有数据源）
- 维护者拍板：手机上接的应用给**我的智能体**用，也能**借给团队**；方案 A（云端自己管一份，授权全在 edge 做）

## 0. 一句话

手机上点「接入应用」→ 浏览器里登录（或粘 token / 直接连）→ 回到 App，这个应用就进了 edge 上这个账号的**云端连接器**，
我的智能体马上能用；在应用详情里开关「借给团队」。凭据不经过手机（token 类除外：那是人自己粘的），过期由 edge 续。

## 1. 现状与约束

- 连接器只在桌面上配：`mcp.json` + `mcp-auth.json`（0600）在 `~/.mr-otto/accounts/<uid>/`；OAuth 走本机回环回调 +
  动态注册（`src/main/mcpOAuth.ts`、`mcpClient.ts`），手填 client 是 #697 那条兜底。
- 智能体经**托管箱**用它们：每账号一只 Escrow DO，存 `EscrowDoc {hostUid, services[], grants[]}`，封在 storage 键
  `sealed` 下（`services/edge/src/worker.ts` 的 `Escrow`）。**整箱覆盖写、桌面是唯一写者**（`pxEscrow.ts` 头注），
  零授权 = DELETE 整箱（ADR-0313）。
- runtime 每轮向 edge 问 `/px/v1/grants`（能用哪些），调用走 `/px/v1/call`；DO 里 `pxGate` 判身份 → 关系（好友 /
  同团队在籍）→ 白名单，逐次记审计（ADR-0151 / 0197 / 0198）。
- 个人主场（`workspaces.kind='home'`）的在籍只有所有者，用的是所有者自己的箱，前提是箱里有一条
  `{workspaceId: <主场 id>}` 授权。
- 手机「我 → 那台电脑 → 应用」只读列出 `workspace_connectors`（`mobile/src/machine/AppsScreen.tsx`、
  `src/shared/mobileMachine.ts` 的 `appRows`），没有任何按钮（#1376）。
- 手机上跑不了本地进程：**只有远程（http）条目**能在手机上接。按目录（`src/shared/mcpCatalog.ts`）数：
  OAuth 47 条、token 7 条、免登录 13 条；stdio 13 条手机上不列。

**为什么不能直接往现有那只箱里写**：整箱覆盖 + 桌面按本地台账重建。手机写进去的东西，桌面下一次同步就冲掉；
桌面零授权时还会整箱删掉。

## 2. 存储：同一只 DO，第二个封存键

- Escrow DO 加一个 storage 键 `cloud`，封存 `CloudBox`（同一把 `ESCROW_KEY`、同一套 AES-GCM）：

  ```ts
  interface CloudBox {
    v: 1;
    hostUid: string;
    services: CloudService[];
    updatedTs: number;
  }
  interface CloudService {
    serverId: string;              // "cloud-" + 目录 id，例 "cloud-notion"
    catalogId: string;             // 目录条目 id（界面查名字 / 图标 / 分组）
    url: string;                   // 已代入参数的最终地址，必须 https
    headers?: Record<string, string>; // token 类：按 headerTemplates 代入后的请求头
    oauth?: {
      tokens?: Record<string, unknown>;
      clientInformation?: Record<string, unknown>; // 动态注册拿到的 client
      tokenEndpoint: string;       // 接入时记下，续期直接用，不再猜 discovery
    };
    toolDefs: EscrowToolDef[];     // 接入时 tools/list 一次；形状同 EscrowService.toolDefs
    status: "ok" | "needs_login";
    grants: { workspaceId: string; allow: string[] }[]; // allow 同现有口径：[] = 整台放行
    connectedTs: number;
  }
  ```

- **一个键一个写者**：`sealed` 只归桌面的 PUT / DELETE；`cloud` 只归本 spec 新加的端点。桌面的「零授权删整箱」只删
  `sealed`，不碰 `cloud`。
- `serverId` 一律带 `cloud-` 前缀：同一个 Notion 桌面也接了的话是两台，互不覆盖。工具名走现有
  `px_<uid8>_<serverId>_<tool>` 的 safe 化，**要核一遍长度**（有的厂商工具名上限 64）——超长时按现有撞名自诊断的规矩
  截断并告警，不静默丢。
- 纯逻辑（形状校验 `parseCloudBox`、合并视图、授权增删）住 `src/shared/remote/pxCloud.ts`，进 vitest；DO 只做 IO。
- **写 `cloud` 一律是「网络在前、读改写在后」**：换 token、`tools/list` 这类外呼先做完，最后那段「读出 `cloud` → 改一台 →
  封存写回」包在一个不含外呼的临界区里（`storage.transaction` 或 `blockConcurrencyWhile`）。DO 在 `await` 外呼时会处理别的
  请求，两个应用同时接入、或接入撞上续期，不这样做就是后写的整份覆盖先写的。

## 3. 三种接入

目录条目决定走哪条（`auth` 字段）；手机先按 `transport === "http"` 筛，再按 `auth` 分流。参数（如 Supabase 的
`project_ref`）由手机收集后随请求上来，edge 按目录模板代入 `url` / `headerTemplates`——**模板以 edge 手上那份目录为准**，
不信手机传来的最终 URL（手机只报 `catalogId` + 参数值）。

### 3.1 浏览器登录（`auth: "oauth"`）

1. 手机 `POST /px/v1/cloud/connect`（带用户 JWT）：`{catalogId, params}`。
2. edge：代入模板得到 `url` → 发现授权服务器（先 RFC 9728 protected resource metadata，退回 RFC 8414
   `/.well-known/oauth-authorization-server`）→ 动态注册（`redirect_uris: ["https://edge.mrotto.agency/px/v1/cloud/callback"]`，
   `token_endpoint_auth_method: "none"`，`client_name: "Mr Otto"`）→ 生成 PKCE verifier + `state`。
   把 `{state, uid, catalogId, url, resource, verifier, clientInformation, tokenEndpoint, exp: now+10min}` 暂存进**该用户的 DO**
   （storage 键 `pending:<state>`），回 `{authorizeUrl}`。
3. 手机 `WebBrowser.openAuthSessionAsync(authorizeUrl, "mrotto://connector-done")`（与登录同一套，`mobile/src/oauth.ts`）。
4. 厂商回跳 `GET /px/v1/cloud/callback?code&state`（**不带 JWT**）。`state` = `<uid>.<32 字节随机 base64url>`：edge 按
   前半段找到那只 DO，DO 查 `pending:<state>`——不存在 / 过期 / 已用过一律拒；**查到即删**（一次性）。
5. DO 用 code + verifier 换 token → 以新 token 做一次 initialize + `tools/list` → 成功才写进 `cloud`（默认带一条主场授权）。
6. 302 到 `mrotto://connector-done?ok=1&serverId=cloud-notion`；失败带 `ok=0&message=<给人看的一句>`。

- 回调地址是 edge 自己的 https，所以不存在「自定义 scheme 被动态注册拒收」的问题（桌面当初绕开的那条，`mcpOAuth.ts` 头注）。
- 请求形状（终审 M7，见 ADR-0336 决定 2）：`resource` 取资源元数据声明的那个、没有才用 `url`；`scope` 只取资源元数据的
  `scopes_supported`，没给就不带；注册若回了 `client_secret`，换 token 与续期按 `client_secret_post` 带上。
- OAuth token 从头到尾不经过手机。

### 3.2 粘 token（`auth: "token"`）

`POST /px/v1/cloud/connect` 带 `{catalogId, params}`（token 就是其中一个参数，照目录的占位符名）。edge 代入后直接
initialize + `tools/list` 验一次，成功才存。token 经 TLS 到 edge，手机不留存。

### 3.3 免登录（`auth: "none"`）

同 3.2，没有凭据参数。

### 3.4 主场 id

接入时默认授权给主场。主场 id 由 edge 现查（`workspaces where owner_uid = uid and kind = 'home'`，service key），
不信手机报的；查不到（还没建主场）就先不带授权存下，由下一次 `GET /px/v1/cloud` 补上（那时主场多半已建好）。

## 4. 续期与状态

- `cloud` 里的 OAuth 只有 edge 续：`/call` 遇上游 401 → 用记下的 `tokenEndpoint` + `refresh_token` + 注册拿到的
  `client_id` 换新 → 写回 `cloud` → 重试一次。这就没有桌面那条「edge 刷了又被桌面下一次上传盖掉」的问题。
- 续不上：`status = "needs_login"`，这一次调用回一句「这个应用要在手机上重新登录」。`needs_login` 的应用**不进
  `/grants` 的工具清单**——智能体看不到一把必然失败的刀。
- 重新登录 = 对这一台再走一遍 3.1（复用 `serverId`，覆盖凭据与工具清单，授权保留）。
- 手机读状态：`GET /px/v1/cloud`（带 JWT）回自己 `cloud` 的**无凭据视图**：`{serverId, catalogId, status, tools: 名字列表,
  grants: workspaceId 列表, connectedTs}`。这正是 #1376 缺的那半数据源（只覆盖手机接的这部分；桌面接的仍无状态）。

## 5. 智能体怎么用（runtime 只改工具名封顶）

- DO 的 `grants` / `call` 两个 op 把 `sealed` 与 `cloud` **合成一份视图**再判：`grantedView` 与 `pxGate` 的入参从
  `EscrowDoc` 换成合并后的形状（`cloud` 里每台带自己的 grants，合并时摊平成 `EscrowGrant`）。
- 判据不变：主场授权要所有者本人；团队授权要调用方与所有者**同在这个团队**（`membershipQuery`）；每次调用记审计。
- runtime 的 `fetchGrantedTools` / 调用路径不改；只有 `pxTools.ts` 的工具名要封顶 64 字符（`px_<uid8>_cloud-<id>_<tool>` 比桌面那条多 6 个字符，
  超长会让整次请求被模型厂商拒掉，见 ADR-0336），所以 runtime 要重新部署一次（计划 Task 8）。

## 6. 借给团队

- 手机应用详情里「借给团队」列出我所在的团队（不含主场），每行一个开关。
- **开**：`POST /px/v1/cloud/grant {serverId, workspaceId, on:true}` → edge 先确认我在籍、加授权（`allow: []` 整台）→
  手机再 upsert `workspace_connectors`（`host_uid = me, server_id = cloud-…, label, tools`），与桌面同一个顺序：**箱先于目录**。
- **关**：先 `on:false` 删授权，再删目录那一行（授权先删：半路失败留下「目录行在、授权没了」，看得见且再点一次即清；
  反过来会留下没人看得见的暗门，见 ADR-0336）。
- 手机 v1 只做整台；团队设置页（桌面）按工具收窄的那份存在团队侧，照旧生效。

### 6.1 桌面要跟一处

桌面团队设置「连接器」那一页，`server_id` 以 `cloud-` 开头的行：
- 标「手机上接的」；
- 「撤回」改调 `POST /px/v1/cloud/grant {on:false}`（再删目录行），不走本机 `withdrawConnector`——后者只删本机台账，
  会留下「目录没了、授权还在」的暗门；
- 本机悬空授权对账（ADR-0313）跳过 `cloud-` 行。

旧桌面在这一改发版之前对 `cloud-` 行点撤回：目录行删了、云端授权留着。团队闸仍要在籍，不越权；手机上再关一次即清。

## 7. 断开

手机「断开」（居中确认、红色实底钮）：`DELETE /px/v1/cloud/:serverId`（DO 从 `cloud` 删掉，凭据与各团队授权一并消失；审计留着）→
删这台在各团队的 `workspace_connectors` 行。顺序同 §6「关」：授权先删、目录行后删。

退出登录时**不**清 `cloud`（与桌面 `purge` 不同）：凭据本来就只在云端，退出这台手机不等于不要这个应用了。

## 8. 手机界面（先出 demo，维护者点完再写 UI）

位置不变：「我 → 那台电脑 → 应用」。

- **应用列表**：上段「手机上接的」（行尾：正常不画东西，`needs_login` 写「点一下重新登录」）；下段「电脑上接的」
  （原样只读）。右上「接入」。
- **接入新应用**：搜索 + 分组（沿用 `CATALOG_CATEGORIES`，去掉「本机工具」），只列 http 条目；已接的标出来。
- **接入前**：一句它是做什么的 +「接好后你的智能体会以你的身份操作它」。要参数 / 要 token 的，居中弹窗问
  （手机表单用居中弹窗，既有规矩）；点「连接」按 `auth` 分流。
- **接好之后**：工具清单、「借给团队」开关、「重新登录」（只在 `needs_login` 时出现）、「断开」。

## 9. 出错时（每种各说各的话）

| 情形 | 说什么 |
|---|---|
| 人自己关了浏览器 | 什么都不说（`openAuthSessionAsync` 回 `cancel`） |
| state 过期 / 用过 / 查不到 | 「授权超时了，再点一次连接」 |
| 厂商不支持动态注册（如 HubSpot） | 「这个应用暂时不能在手机上直接登录，去电脑上接」（v1 不做手填 client） |
| 发现 / 注册 / 换 token 失败 | 带上厂商原话的一句，原文进日志 |
| 登录成功但 `tools/list` 失败 | 不存；带上厂商原话 |
| token 验不过（401） | 「这个 token 用不了，检查一下再粘一次」 |
| 续期失败 | `needs_login`，手机与智能体两边都说 |

## 10. 安全

- `state` 一次性、10 分钟、绑 uid，32 字节随机；回调查到即删。
- `redirect_uri` 固定 edge 的 https 地址；手机只报 `catalogId` + 参数值，最终 URL 由 edge 按自己手上的目录拼，且必须 https。
- 凭据只以密封形式落 DO storage；`GET /px/v1/cloud` 永远是无凭据视图。
- `/cloud/connect` 按 uid 限速（DO 内计数，每分钟 10 次）；pending 条目数量封顶（同一用户最多 5 条未完成授权，多了先清过期的、
  仍满就拒）。
- 手机不存任何应用凭据。
- **已知缺口：授权链接可以被转发（#1432）。** `authorizeUrl` 被发给别人、由别人登录，那人的厂商凭据会落进**转发者**的箱
  （`state` 绑的是发起者的 uid）；桌面走本机回环回调，不受影响。缓解方向：edge 跳去厂商之前先过一页「你正在把这个应用接到
  某某 的 Mr Otto」，和 / 或缩短 pending 的 10 分钟。

## 11. 测试

- `src/shared/remote/pxCloud.ts` 纯逻辑：`parseCloudBox` 形状校验（拒非 https、拒缺字段）、`sealed + cloud` 合并视图、
  授权开关、`needs_login` 不进工具清单、无凭据视图不漏 token。
- `src/shared/mobileConnectors.ts`：手机可接条目的筛选（只 http、stdio 不列、`blocked` 标出）、按 `auth` 分流、参数表单。
- edge：`state` 签发 / 校验 / 一次性；OAuth 发现解析（9728 → 8414 退回）；connect / callback / token / 断开 / 授权 /
  续期标 `needs_login`，全部用假 `fetch`（照现有 `tests/edge/px*.test.ts`）。`worker.ts` 进不了 vitest，DO 的接线用
  读源码断言钉（同 ADR-0305 / 0308 的做法）。
- 桌面：`cloud-` 行撤回走 edge、对账跳过。
- 真 OAuth 登录只能真机验：Notion（OAuth）、GitHub（token）、Context7（免登录）各接一次，智能体各调一次，借给团队后
  团队里的智能体调一次，断开后调用被拒。

## 12. 上线顺序

1. 部署 edge（新端点 + DO 合并视图）。不跑 migration。
2. 部署 runtime（工具名封顶）。
3. 跑 `scripts/probe-cloud-oauth.mjs`，结果进 `MOBILE_OAUTH_BLOCKED`。
4. 桌面发版（`cloud-` 行撤回走 edge）。
5. 手机打包。

## 13. 不做（v1）

- 手填 OAuth client（#697 那条路）：不支持动态注册的应用手机上接不了，明说。
- 按工具借给团队（桌面能收窄）。
- 手机上管理桌面接的应用、桌面接的应用的状态（#1376 剩下那半）。
- 桌面本机会话用手机接的应用。
- stdio 条目。

## 14. 推翻前提

- 目录里大部分 OAuth 应用支持动态注册且接受 https 回调——这是目录注释说的「实测过前半段」，但那是用本机回环地址测的；
  换成 edge 的 https 回调后，**上线前要逐条再跑一遍前半段**，不行的标 `blocked`（手机那侧）。
- `sealed` 与 `cloud` 两个键不撞写：各有唯一写入路径，且 `cloud` 的读改写在不含外呼的临界区里（§2）。DO 在外呼的 `await`
  处会交错处理别的请求——临界区里一旦混进外呼，这条前提就不成立。
