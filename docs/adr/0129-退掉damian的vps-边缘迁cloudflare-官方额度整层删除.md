# ADR-0129: 退掉 Damian 的 VPS —— 落地页与中继迁 Cloudflare，官方额度整层删除

日期：2026-08-26
状态：已接受（stanyan 会话指示）

> **原为 ADR-0128。** 本 PR 开着的时候，main 上先合入了 ADR-0128（一台桌面可以配对
> 多台手机），按项目 ADR-0074「编号在合并时认领」改到 0129。commit message 改不了，
> 所以留这行让旧引用还能解析回来。

## 决定

1. **落地页与中继迁到自管的 Cloudflare Workers**（免费版 `workers.dev` 子域）。
   一个 Worker 承两个职责：`/auth/landing` 走普通 Worker，`/rl/v1/connect` 走
   Durable Object，一户一 DO（`getByName(userId)`）。
2. **中继从 SSE 换成 WebSocket + Hibernation。** 桌面与手机两份传输实现合并为一份
   `src/shared/remote/wsTransport.ts`。
3. **休眠的官方额度通路整层删除**，含数据库的 `token_ledger` / `token_wallets` /
   `token_balances` 三张表与 `grant_tokens` / `spend_tokens` / `rebuild_balance` 三个函数。
4. **`services/gateway/` 更名 `services/edge/`**（删完之后它不再 gate 任何东西）。
5. 退掉对 `65.109.113.168` / `otto-auth.stan.damianslife.com` 的依赖。

完整设计见 `docs/superpowers/specs/2026-08-26-edge-migration-design.md`。

## 理由

**为什么必须换协议，而不是照搬 SSE 上 DO。** DO 免费版每天 13,000 GB-s，固定按 128 MB
计费，即约 28 对象小时/天。SSE 没有休眠 API，流开着 DO 就不能被驱逐——一个桌面挂 24 小时
就是 11,059 GB-s，**吃掉全天额度的 85%，一个在线用户撑满免费版**。WebSocket 用
`ctx.acceptWebSocket()` 之后连接由边缘代持，DO 闲时出内存不计时长，计费从「连着多久」
变成「执行 JS 的那几毫秒」。

**换协议不是推翻既有决定，是它的前提消失了。** `remoteTransport.ts` 头注写明当初不用
WebSocket 的原因：VPS 的 nginx 有 `proxy_set_header Connection '';`，upgrade 上不去。
那条配置是我们自己为 SSE 写的（`deploy/otto-gateway/nginx-gw-location.conf`），离开 VPS
就没有它。

**为什么 DO 而不是换一台自己的 VPS。** 真正的约束按硬度排是：所有权（在别人的机器上，
倾向绕开而不是改配置）> 单机（一个进程的内存 Map，且中继**必须唯一**——横向扩容反而会坏，
桌面连副本 A、手机连副本 B 就永远配不上对）> nginx 配置（最软）。换台自己的 VPS 只解掉
第一条。DO 同时解掉前两条：中继这个东西的形状本来就是「一个有身份的、唯一的、大部分时间
闲着的协调点」，之前是拿单机内存 Map 凑出来的近似。

**为什么删而不是继续用开关关着。** ADR-0085 当时的取舍是「用开关不用删除，翻回来 = 掰开关」。
现在的差别是：那两个端点仍然在公网上响应，属于没人用却仍暴露的攻击面；而且它们把
`services/gateway/` 钉在 Node 部署形态上（`server.ts` / `nodeAdapter.ts`），不删就得连着
一起搬。删掉之后网关只剩落地页 + 中继约 500 行，正好是一个 Worker 的体量。

## 取舍与代价

**删数据库表推翻了一条明确写下的不变量。** `0002_token_wallets.sql` 开篇写「账本只增不改
不删」；`0012_drop_poker.sql` 特意保留钱包并写明理由「账本是历史，余额由它累加而来，删了
余额就错了」。本 ADR 删的正是那个账本。**前提是「这条业务线整层下线，历史没有服务对象」**
——若这个前提不成立（例如将来要做用量审计或退款），这个决定应当被推翻。代价是若官方额度
将来翻回来，翻回来的是一个空账本，已发出的余额不可恢复。

执行前置条件：先数真库里的非零余额行数，**不是 0 就停下来重新决策**（SQL 见 spec）。

**旧安装在野外，退 VPS 必须有过渡期。** `DEFAULT_GATEWAY_BASE_URL` 是编译期常量，写死在每
个已发出的包里，而更新走 GitHub releases 不强制。已知至少有一个非维护者的安装在按 30 秒
心跳打那台机器。缓解：旧落地页是**唯一能触达旧客户端的通道**（服务端渲染的 HTML，改它不
需要客户端更新；中继做不到——密文管道没有展示层），过渡期把它改成仍正常转发深链但页面提示
「去下载新版」，并用 nginx access log 上该端点的命中数当「还有没有人在用」的尺子。

**两套中继并存期间，旧桌面 + 新手机永远配不上对**（一个在 VPS 内存 Map、一个在 DO 里），
表现是「两边都显示在线但什么都传不过去」。发布说明必须写明桌面和手机要一起更新。手机端是
Expo app，更新节奏与桌面不同步，这个风险没有干净解法。

**DB drop 不可回滚。** 所以排在发布顺序最后，与前面的迁移解耦：先把 VPS 退完跑稳，再清 DB。
客户端指向那层的回滚靠保留 `OTTO_EDGE_URL` 环境变量覆盖——出事时设个环境变量指回旧网关，
不用等新包过审。

**免费版是有上限的，不是无限。** 13,000 GB-s/天与 10 万请求/天是真实的天花板。用了
Hibernation 之后离天花板很远，但如果将来中继的消息频率数量级上升（例如做实时协作而不是
偶发投影），这个决定要重新算账。

## 被本 ADR 调整的既有决定

- **ADR-0085 第 1、2 条**：从「用开关不用删除」变成「删除」，其恢复清单作废。
- **ADR-0019 / 0021 / 0045**：ADR-0085 已让它们「不启用」，本次是机制不存在了。
- **ADR-0098**：`otto-auth.stan.damianslife.com` 当时「不随栈退役」的那半边（`/gw/`），
  本 ADR 之后也退役。
- **`0012_drop_poker.sql` 保留钱包的理由**：见上。
- **`remoteTransport.ts` 头注「不用 EventSource / WebSocket」**：前提随迁移消失。

## 实现时的补充（#518 落地，2026-08-26）

原文写这份决定时有三个未决问题，实现第一步全部验掉了，**都不用退路**：

- **token 走 `Sec-WebSocket-Protocol`**：`new WebSocket(url, [SUBPROTOCOL, jwt])` 实测把两个值
  拼进 header（741 字节的 Supabase JWT → 752 字节 header），服务端只 echo 回常量。
  query 参数那条路仍然否决：access token 不该出现在 URL 里。
- **Electron 主进程有全局 `WebSocket`**：Electron 43 内嵌 Node 24.18.1。不用 `ws` 包。
- **DO 的 tags 可用**：`acceptWebSocket(ws, tags?)` / `getWebSockets(tag?)` / `getTags(ws)`
  都在类型定义里，所以 role 存 tag，不用 `serializeAttachment`。

**一处原文没预料到的改动：`jwt.ts` 从 `node:crypto` 换成 WebCrypto。** Worker 运行时没有
`node:crypto`，要有得开 `nodejs_compat` —— 为一次 HMAC 拉进整个 Node 兼容层不划算。
换成 `crypto.subtle` 之后这个文件运行时无关，附带收益是 `subtle.verify` 自己就是定长比较，
手写的 `timingSafeEqual` 和它那个"先比长度（不等长会抛）"的补丁一起没了。
代价：验签变成异步，调用方要 `await`。三个经典坑（alg 白名单、定长比较、exp 必须存在）
一条没动，`tests/edge/jwt.test.ts` 逐条照旧。

**`server.ts` / `nodeAdapter.ts` 的删除从 #517 挪到了 #518**：过渡期里生产上跑的仍然是那个
Node 进程，main 上不留一份能构建的源码，就没法在旧服务上改东西。Worker 入口落地后才删。

**运行时那一层怎么验**：单测跑纯逻辑 + 一个照着 `worker.ts` 写的假 DO，覆盖不到
`acceptWebSocket` 的休眠语义、tag 存取、101 响应形状、子协议 echo —— 那几件事坏掉的样子是
"连上了但什么都不发生"，没有报错。所以 `services/edge/checks/relay.mjs` 打真 workerd
（`wrangler dev --local` 或生产地址）跑 17 条端到端断言，不进门禁，改中继的 PR 贴它的结果。

## 与 ADR-0130 的合并（#518 与 #530 并行落地）

本 ADR 的实现（#518，PR #539）和 ADR-0130（中继按连接寻址，#530）是两条并行的 lane，
在 PR 合并时撞上：0130 把中继从「一户一桌面一手机」改成「一户多连接、按 cid 寻址」，
而它做在 SSE 那版中继上；本 ADR 把中继整个换成 WebSocket + Durable Object。

合的方式：**桥层与契约全取 0130 的**（`remoteBridge` 的 `Map<cid, Peer>`、
`mobileBridge`、`RemoteTransport` 的 `send(payload, to)` / `onMessage(p, from)` /
`onPeer(cid)` / `onGone(cid)`），wire 那一半在 WebSocket 上重做。

**0130 里有两样没跟过来，因为它们是 SSE 的迁就：**

- **`event: <cid>` 行**：SSE 是按行的文本流，让收件人知道发件人是谁只能加一行。
  WebSocket 是离散消息，发件人直接编进帧头（`<cid> <payload>`，读到第一个空格就够）。
- **`v=2` 协商**：加那行会让只认单行 `data:` 的老解析器整条丢掉（「连上了却一帧都收不到」），
  所以必须客户端先声明认新格式。WebSocket 这边没有老客户端 —— 它们连的是旧 VPS 上那个
  SSE 中继，两套在过渡期并存（见发布顺序），各说各的话。

**一处 0130 的实现在 DO 上会坏，改掉了**：cid 用递增计数器（`c${++seq}`）。
DO 睡醒后构造函数重跑、内存清零，计数器归零，而那时还开着的连接仍持着老 cid ——
撞号的表现是两条连接抢同一根管子。改成随机（`crypto.randomUUID()` 截段），
不需要为它落盘，也就不破坏「中继一个 storage API 都不调」。
