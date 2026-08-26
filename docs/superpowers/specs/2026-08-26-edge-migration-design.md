# 退掉 Damian 的 VPS：落地页与中继迁 Cloudflare，官方额度通路删除

日期：2026-08-26
状态：设计已定，待实施

## 背景

`otto-auth.stan.damianslife.com`（Hetzner VPS `65.109.113.168`）上跑着 `otto-gateway`，
是本项目对第三方机器的唯一剩余依赖。它今天承担四件事：

| 端点 | 状态 |
|---|---|
| `/gw/auth/landing` | **活**。OAuth 授权完成后的落地页，桌面与手机登录都必经 |
| `/gw/rl/v1/stream` + `/send` | **活**。手机端远程投影/审批的唯一通路 |
| `/gw/v1/chat/completions` | **休眠**。ADR-0085 关掉 `OFFICIAL_GRANT_ENABLED` 后无客户端调用 |
| `/gw/v1/wallet` | **休眠**。同上 |

数据库早已不在那台机器上（ADR-0098 迁 Supabase Cloud）；那台机上的 `otto` compose
栈是退役旧栈。剩下的就是这个网关进程 + 一段 nginx location。

## 目标

1. 落地页与中继迁到自管的 Cloudflare Workers（免费版 `workers.dev` 子域）
2. 休眠的官方额度通路整层删除，含数据库表
3. `services/gateway/` 更名 `services/edge/`（删完之后它不再 gate 任何东西）
4. 退掉 VPS 依赖

## 不做什么

- 不买域名。先用 `workers.dev` 免费子域；将来要换自有域名是纯 DNS 工作，不影响本设计。
- 不改端到端加密、握手、帧协议。`sealedStream.ts` / `handshake.ts` / `frames.ts`
  住在传输之上，本次一行不动。
- 不动 Supabase Cloud 的认证本身。只改 `redirect_to` 指向。

## 关键约束：DO 的计费算术决定了传输协议

Durable Objects 免费版每天 13,000 GB-s，DO 固定按 128 MB 计：

    13,000 ÷ 0.128 ≈ 101,562 对象秒/天 ≈ 28 小时/天

中继现在是 SSE。桌面登录后那条流是长命的，挂 24 小时 = 86,400 × 0.128 = 11,059 GB-s，
**吃掉全天免费额度的 85%**。SSE 没有休眠 API，流开着 DO 就不能被驱逐。

**一个在线用户就撑满免费版。** 所以「照搬 SSE 上 DO」不可行，必须换 WebSocket +
Hibernation：`ctx.acceptWebSocket()` 之后连接由边缘代持，DO 闲时出内存、不计时长，
消息到达才唤醒。计费从「连着多久」变成「执行 JS 的那几毫秒」。

### 换协议不是推翻决定，是前提消失

`src/main/remoteTransport.ts` 头注写明当初为什么不用 WebSocket：VPS 上的 nginx 有
`proxy_set_header Connection '';`，upgrade 上不去。那条配置是我们自己写的
（`deploy/otto-gateway/nginx-gw-location.conf`），为 SSE 配的。离开 VPS 就没有它。

真正的约束按硬度排：所有权（别人的机器，倾向绕开而不是改）> 单机（一个进程的内存
Map，且中继必须唯一、横向扩容反而会坏）> nginx 配置（最软，能改）。DO 恰好同时解掉
前两条——「全局唯一的协调点 + 闲时不烧钱」正是中继这个东西的形状。

## 架构

### 1. 部署单元

一个 Worker，两个职责，共用一个 `handle()`：

    <name>.<subdomain>.workers.dev
      ├─ GET  /auth/landing      静态 HTML，无鉴权无状态  → 普通 Worker
      └─ GET  /rl/v1/connect     WebSocket upgrade        → DO(userId)

`/gw/` 前缀消失（那是 nginx `location /gw/` 尾斜杠剥前缀的产物）。原来的
`/rl/v1/stream` + `/rl/v1/send` 合并成一个 `/rl/v1/connect`。

**纯逻辑与运行时分离**：DO class 是薄壳，配对逻辑保持纯函数。`tests/edge/relay.test.ts`
那条钉「不打印负载」的安全测试继续在普通 vitest 里跑，不引 `@cloudflare/vitest-pool-workers`
起 workerd——安全不变量的测试必须便宜到每次提交都跑。薄壳那层由 e2e 兜。

**tsconfig 单开一份**：根 tsconfig 是 `"types": ["node"]` 且覆盖 `services/`。把
`@cloudflare/workers-types` 加进根会让 Electron 主进程的 `fetch`/`Request`/`WebSocket`
全局声明打架。worker 目录带自己的 tsconfig，根这边 exclude，`npm test` 加一条独立 tsc。

### 2. DO 中继

一户一 DO。身份在**父 Worker** 里验（`jwt.ts` 照搬），拿到 `userId` 再 `getByName(userId)`。
DO 自己永远看不到 token。

```js
export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 心跳在边缘直接应答，不唤醒 DO
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const role = new URL(req.url).searchParams.get("role"); // desktop | mobile
    const [client, server] = Object.values(new WebSocketPair());
    for (const old of this.peers(role)) old.close(1000, "superseded"); // 同角色重连顶掉旧的
    this.ctx.acceptWebSocket(server);       // ← 不是 server.accept()，这一句就是休眠
    server.serializeAttachment({ role });   // 睡醒后靠它认出谁是谁
    const peer = this.peers(other(role))[0];
    if (peer) { server.send(":peer"); peer.send(":peer"); }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    const { role } = ws.deserializeAttachment();
    if (msg.length > MAX_FRAME) return ws.close(1009, "frame too large");
    this.peers(other(role))[0]?.send(msg);  // 对端不在就丢，不排队
  }
}
```

要点：

- **状态不能放实例字段。** DO 睡醒后构造函数重跑、内存清零。role 挂在连接自己身上。
  CF 的 tags 参数（`acceptWebSocket(ws, ["desktop"])` + `getWebSockets("desktop")`）可能更
  干净，但文档里只翻到无参形式的例子，签名未确认。实现时先试 tags，不行退回 attachment。
- **`:peer` 用前缀区分。** 密文是 base64url（字母表 `A-Za-z0-9-_`），永远不含冒号。
  `:` 开头 = 控制消息。加一条测试钉住「控制前缀不可能出现在密文里」。
- **不排队更自然了。** 今天上行是 POST，对端不在线要回 409，`transport.ts` 为此专门写了
  一段「409 不是连接断了」的注释。WS 下 send 是 fire-and-forget，409 这个概念消失。
- **零存储。** DO 一个 storage API 都不调。「会话内容一个字节都不进库」这条安全不变量
  在新平台上**字面成立**（不是靠纪律，是根本没接那个 API），顺带没有 SQLite 存储计费。
- 256 KiB 单帧上限保留——挡的是内存，不是协议（CF 的 WS 上限是 32 MiB）。

### 3. 传输层合并

两份实现（`src/main/remoteTransport.ts` 232 行 + `mobile/src/transport.ts` 215 行）大部分
逐字重复：退避阶梯、`STABLE_MS`、`attempt` 归零、上行队列、「已被更新的连接接替就不算数」
的判断、五个方法的实现。手机那份注释里写着「理由和手机侧那份一字不差」。

**WS 之后直接消失的四样：**

1. **上行队列。** 存在的理由是「密封流按严格递增计数器收帧，并发 POST 的到达顺序由 HTTP 栈
   说了算」。WS 是一条连接、有序交付——根因消失，不是被绕过。
2. **上行重试。** 手机重试 3 次、桌面不重试，这个不对称今天就在。WS 下「HTTP 请求失败」
   不存在，重试没有落点。
3. **`RECYCLE_BYTES` 4MB 主动回收。** XHR `responseText` 只增不减的后遗症。
4. **`:ok` 开场白。** 它只是因为 `node:http` 不写第一个字节就不冲刷响应头。101 就是信号。

**447 行 → 200 出头，一份**，放 `src/shared/remote/wsTransport.ts`。

**平台差异收成一个方法。** 两边各有一个「立刻重连，别等退避」的触发器：桌面 `retryNow()`
（登录那一刻叫醒，issue #484）、手机 `reconnectNow("回到前台")`（iOS 切后台掐 socket 但
XHR 不知道）。统一成 `reconnectNow(why: string)`，两端各自接线。于是
`SseTransport = RemoteTransport & { retryNow() }` 这个「桌面特有」的类型特例取消。

**顺手修一个不对称。** 桌面有 `guard()`（回调抛异常不算网络故障，吞掉 + 记日志），来历是
Electron 的 BoringSSL 没有 `chacha20-poly1305` 这个 EVP 名字，握手一抛异常日志显示成一连串
断线，「把排查带偏了一整轮」。手机侧 `onMsg(payload)` 是裸调的，没有这层保护。合并后两端都有。

**契约改三处**，方法签名基本不动，所以 `remoteBridge.ts` / `mobileBridge.ts` 一行不改：

1. 加 `reconnectNow(why)`
2. 删掉 409 那段注释
3. `:peer` 从「SSE 注释行」改述为「控制消息」

**落点：**

| 动作 | 文件 |
|---|---|
| 新建 | `src/shared/remote/wsTransport.ts` |
| 删除 | `src/main/remoteTransport.ts`、`mobile/src/transport.ts`、`src/shared/remote/sse.ts` |
| 移动 | `tests/main/remoteTransport.test.ts` → `tests/shared/remote/wsTransport.test.ts` |
| 删除 | `tests/shared/remote/sse.test.ts` |

`mobile/src/transport.ts` 那 215 行今天在门禁之外（tsconfig 排除 `mobile/`，issue #422）。
搬进 `src/shared/remote/` 之后第一次被 tsc 和 vitest 覆盖——这是净收益，不是新增未检查代码。

### 4. 删除清单

**客户端**

| 文件 | 动作 |
|---|---|
| `src/main/walletApi.ts` + 其测试 | 整个删 |
| `src/main/modelRoute.ts` | 删 `officialGrant` 参数与网关分支 |
| `src/main/agent.ts:91,431` | 去掉 `gatewayBaseUrl` 注入 |
| `src/shared/features.ts` | `OFFICIAL_GRANT_ENABLED` 是最后一个常量 → 整个文件删 |
| `src/renderer/src/App.tsx:1467` | `QuotaCard` 渲染点 + 组件本体（内联在同文件） |
| `src/renderer/src/store.ts:831` | `refreshWallet` 及其 state |
| `src/renderer/src/components/ModelPicker.tsx:126,139` | `grantOn`、deepseek 特判 |
| `src/shared/shellBridge.ts` + `src/preload/index.ts:119` | `WalletBalance`/`WalletBucket` 类型、`walletBalance` IPC |
| `src/model/openaiCompatible.ts:8` | `parseGatewayError`——只解 402「额度用尽」，没有对象了 |

**服务端**：依赖链干净，`gateway.ts` → `buckets`/`usage`/`wallet` → `supabaseRpc`，除
`gateway.ts` 外没有第二个 import 方。整串删，含 `server.ts` / `nodeAdapter.ts`（Node 部署
胶水）与四份测试。留 `jwt.ts`（中继验身份）、`authLanding.ts`、`ottoMark.ts`、`relay.ts`。

**`deploy/otto-gateway/` 整目录删。**

**数据库**（新增 `0014_drop_token_wallets.sql`，形状照 0012 先例）：

- 表：`token_ledger`、`token_wallets`、`token_balances`
- 函数：`grant_tokens`、`spend_tokens`、`rebuild_balance`

（`token_wallets` 从 0003 起已是死表，函数当时就 drop 了，表留到今天。）

**这里推翻了一条明确写下的不变量。** `0012_drop_poker.sql` 特意写了不动钱包的理由：
「账本是历史，余额由它累加而来，删了余额就错了」；`0002` 开篇也写「账本只增不改不删」。
我们现在删的正是那个账本。前提是「这条业务线整层下线，历史没有服务对象了」。代价：
若将来官方额度翻回来，翻回来的是一个**空账本**，已发出的余额不可恢复。

**改名连带面**：`services/gateway/` → `services/edge/`；`src/shared/gatewayConfig.ts` →
`edgeConfig.ts`；`gatewayBaseUrl` → `edgeBaseUrl`；`DEFAULT_GATEWAY_BASE_URL` →
`DEFAULT_EDGE_BASE_URL`；环境变量 `OTTO_GATEWAY_URL` → `OTTO_EDGE_URL`；`tests/gateway/` →
`tests/edge/`。`GatewayErrorBody`/`parseGatewayError` 跟 402 一起删了，不用改名。
删除面比改名面大，两件事同一个 PR 做更省——改名要碰的文件有一半正在被删。

### 5. 迁移与回滚

**最重要的约束：旧安装在野外。** `DEFAULT_GATEWAY_BASE_URL` 是编译期常量，写死在每个已发出
的包里；更新走 GitHub releases，不强制。已知至少有一个非维护者的安装在按 30 秒心跳打那台
机器。直接停 = 把那个人打断线。

**旧落地页是唯一能触达旧客户端的通道。** 它是服务端渲染的 HTML，改它不需要客户端更新；
中继做不到（密文管道，没有展示层）。过渡期把旧 `/gw/auth/landing` 改成仍然正常转发深链
（功能不破）但页面多一句「你的 Mr Otto 是旧版，去下载新版」。nginx access log 上这个端点
的命中数，就是「还有没有人在用旧地址」的尺子——我们没有 metrics，这是最便宜的一把。

**两套中继并存的真实故障模式**：同一个用户的旧桌面 + 新手机会永远配不上对（一个在 VPS 的
内存 Map，一个在 DO 里），表现是「两边都显示在线但什么都传不过去」。必须写进发布说明：
桌面和手机要一起更新。手机端是 Expo app，更新节奏与桌面的 GitHub releases 不同步，这是
真风险；缓解是新桌面连不上对端超时后给明确提示而不是干等（是否做，待定）。

**回滚**

| 层 | 手段 | 速度 |
|---|---|---|
| Cloudflare Worker | `wrangler rollback` / 重发上一版 | 秒级 |
| 客户端指向 | 编译期常量 → 得发新包 | 慢 |
| DB drop | **无** | —— |

客户端那层的缓解是现成的：`edgeBaseUrl()` 读 `OTTO_EDGE_URL` 环境变量。**这个覆盖机制别删**
——出事时可以让用户设环境变量指回旧网关，不用等新包。

**发布顺序**（每步独立可回滚）

1. **PR 1 瘦身**：删休眠通路（客户端 + 网关代码，不含 DB）+ 改名。不碰部署，风险最低。
2. **PR 2 立起 Cloudflare**：Worker（落地页 + DO 中继）+ 传输层换 WS，部署到 workers.dev，
   客户端还不切。靠 e2e 和手工验，不影响在线用户。
3. **PR 3 切指向 + 发版**：改常量，发桌面版 + 手机版。发版**之前**维护者要先加 Supabase 白名单。
4. **观察期**：旧落地页变墓碑，盯 access log。
5. **PR 4 清 DB**：等余额数字确认。
6. **最后**：停 VPS 上的 `otto-gateway` 并通知 Damian。对别人机器的操作，由维护者执行。

## 待维护者处理

1. **Supabase 重定向白名单**（PR 3 发版之前）：Dashboard → Authentication → URL
   Configuration → Redirect URLs，**加**新的 workers.dev 落地页地址。两条纪律：
   **别删旧的**（旧客户端还在用）；**别用通配符**（`https://*.workers.dev/**` 意味着任何人的
   worker 都能当我们的 OAuth 回调 = 开放重定向漏洞），精确到我们那一个子域。
2. **余额行数**（PR 4 之前）。本机无 `OTTO_DB_URL`，取不到。在 Supabase SQL Editor 跑：

   ```sql
   select 'ledger 总行数' k, count(*)::text v from public.token_ledger
   union all select 'ledger 涉及用户数', count(distinct user_id)::text from public.token_ledger
   union all select 'balances 非零余额行数', count(*)::text from public.token_balances where balance_tokens > 0
   union all select 'balances 非零余额用户数', count(distinct user_id)::text from public.token_balances where balance_tokens > 0
   union all select 'balances token 总量', coalesce(sum(balance_tokens),0)::text from public.token_balances where balance_tokens > 0;
   ```

   **非零余额用户数不是 0 就停下来重新决策**——那意味着有真人手里还攥着没花完的额度。

## 未决问题（实现时解决，不阻塞设计）

1. **token 怎么带进 WebSocket。** 标准 `WebSocket` 构造函数只吃 url 和 protocols，不能带
   header。三条路：**(a) 塞 `Sec-WebSocket-Protocol`**——`new WebSocket(url, ["mrotto.v1", token])`，
   服务端只 echo 回 `"mrotto.v1"`；标准 API 两端都支持，token 不进访问日志。需验证 CF 允许在
   101 响应里选定 subprotocol，且 Supabase JWT（约 800 字节）不超 header 限制。
   **(b) query param——否决**，access token 不该出现在 URL 里。
   **(c) 连上后第一帧发 token**——最保险，但父 Worker 在路由前不知道 userId，没法 `getByName`。
   取 a，退路 c。
2. **Electron 主进程有没有全局 `WebSocket`。** Electron 43 内嵌 Node 22，Node 22 有，但
   Electron 的全局对象是它自己组装的，未实证。实现第一步打印 `typeof WebSocket`。没有的话
   主进程用 `ws` 包，共享实现靠注入 `wsImpl` 吸收差异，形状不变。
3. **DO 的 tags 签名**（见 2. DO 中继）。
4. **桌面「连不上对端」提示**要不要做（见 5. 迁移与回滚）。

## 被推翻的既有决定

- **ADR-0085 第 1、2 条**：从「用开关不用删除，翻回来 = 掰开关 + 恢复网关默认赠额」变成
  「删除」。恢复清单作废。
- **ADR-0019**（官方 key 藏在网关后）/ **ADR-0021**（token 计价桶）/ **ADR-0045**（赠额是明路）：
  ADR-0085 已让它们「不启用」，本次是「机制不存在了」。
- **`0012_drop_poker.sql` 保留钱包的理由**：见上。
- **`remoteTransport.ts` 头注「不用 WebSocket」**：其前提（VPS nginx 的 `Connection ''`）随
  迁移消失。
