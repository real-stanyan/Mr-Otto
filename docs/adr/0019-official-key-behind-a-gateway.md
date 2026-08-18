# ADR-0019：官方 key 走网关，额度记在服务端账本

- 状态：已接受
- 日期：2026-08-18
- 相关：issue #45；ADR-0008（ExecutionWorld / HTTP seam）
- 后续依赖：token 德州（筹码是真 token，须服务端权威）

## 背景

产品决定（维护者 stanyan，2026-08-18 会话）：Mr Otto 官方用 DeepSeek 统一 key，
每个新用户送 20 USD 额度，用户也可继续自带 key；之后要做用 token 对赌的德州。

## 决定一：官方 key 不进客户端，走网关

`src/model/openaiCompatible.ts:163` 是**客户端直连**上游。Mr Otto 是 Electron 桌面应用，
asar 是打包不是加密——官方 key 无论放 `keyVault`、`.env` 还是编译进包，都躺在用户自己的
磁盘上。

这不是「有被看到的风险」，是两条硬结论：

1. 全部预算可被单个用户跑光，且分不清是谁。
2. **20 USD 额度在客户端无法执行**：余额存在用户机器上，用户改得动。

所以形态只能是：

    客户端 ──Supabase JWT──> otto-gateway ──官方 key──> DeepSeek

网关（`services/gateway/`）验 Supabase 的 HS256 JWT 取 `sub`，查余额，转发，
按上游返回的 `usage` 记账。客户端 adapter 形状不用改：网关说的是同一套 OpenAI 方言，
`DEEPSEEK_BASE_URL` 这个 env 覆盖口子早就留好了。

自带 key 那条路不动——`keyVault.ts` 已经在跑，直连上游，不经过网关。

**什么情况下该推翻**：如果哪天客户端不再是用户可控的执行环境（例如全部功能收进
托管的 Web 版），这一层的存在理由就没了。

## 决定二：账本 append-only，余额是投影

`token_ledger` 只增不改不删，一行 = 一次余额变动；`token_wallets.balance_micro_usd`
是它的求和缓存，`rebuild_wallet()` 随时可从账本重算。

这是把仓库的硬规则（"append-only 事件日志是唯一事实来源，投影必须可从日志推导"）
原样用在钱上。钱比会话更需要这条：任何一笔扣费都得能问出"凭什么"。

金额单位 micro-USD（bigint），不碰浮点。

写入只走三个 `security definer` 函数，且对 `anon`/`authenticated` **收回执行权**——
否则登录用户可以自己 rpc 一句 `charge_tokens` 给自己发钱。RLS 只给读自己的行。

## 决定三：允许小额透支，不做预扣

用量只有模型答完才知道，最后一次调用的超支事前拦不住。两条路：

1. **预扣**：调用前冻结一笔估算额度，事后按实际用量退差额。准，但要实现退款，
   退款是另一套账（退给谁、退多少、退失败怎么办），复杂度翻倍。
2. **事后记账 + 事前门槛**：余额 `<= 0` 就 402，超支部分由赠额吸收。

选 2。20 USD 的赠额远大于单次调用的成本，透支上限是「一次调用」，可接受。

**什么情况下该推翻**：如果引入按次充值的付费档（用户余额可能恰好卡在几分钱），
或者单次调用成本可能逼近赠额（超长上下文），透支上限就不再可忽略，得改预扣。

## 决定四：JWT 验签手写，不装 jose

自建 Supabase 走对称 HS256（`deploy/otto-auth/README.md`：新版非对称体系留空，
auth/rest/realtime 都读 `JWT_SECRET`）。验一个 HS256 = 一次 HMAC + 一次定长比较，
一个依赖换不来更少的代码，且与仓库既有风格一致（adapter 也是裸 fetch 零 SDK）。

代价是必须自己堵住 JWT 的三个经典坑，`tests/gateway/jwt.test.ts` 逐条钉住：
`alg` 白名单硬匹配（挡 `alg: none` 和算法混淆）、`timingSafeEqual` 前先比长度、
`exp` 必须存在（缺就放行等于发了张永久令牌）。

**什么情况下该推翻**：Supabase 切到非对称密钥体系（ES256 + JWKS）那天——
那时要处理密钥轮转和 JWKS 缓存，手写不再划算。

## 决定五：测试放 `tests/gateway/`

AGENTS.md 说测试镜像 `src/`，而网关源码在 `services/gateway/src/`（它是独立部署物，
不属于 Electron 应用的 `src/`）。ADR-0016 把 vitest 的 include 钉死在 `tests/**`，
所以镜像关系取 `tests/gateway/` ↔ `services/gateway/src/`。同一条门禁，不新增命令。

`server.ts` 没有单测：它只做 node:http ⇄ Web Request 的协议转换和读 env，
逻辑全在 `gateway.ts`——`createGateway` 收注入的 fetch 和钱包，
测试直接造 `Request` 打它，不起端口不发真请求。
