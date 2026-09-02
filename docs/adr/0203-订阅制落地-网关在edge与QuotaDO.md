# ADR-0203：订阅制落地——网关在 edge Worker，`Quota` DO 做双固定窗 hold/settle

- 状态：已接受（stanyan 会话指示，issue #696）
- 日期：2026-09-02
- 相关：ADR-0174（订阅计量：credit / 双固定窗 / 不滚存）、ADR-0175（按模型比价）、
  ADR-0176（托管优先于 BYOK、key 不过桥）、ADR-0202（模型 key 跟着工作区走）、
  ADR-0019 决定四（裸 fetch 零 SDK 的既有风格）、ADR-0074（ADR 编号顺延规矩）；
  spec `docs/superpowers/specs/2026-09-02-subscription-billing-design.md`

本 ADR 记的是 0174–0176 定形之后、**落地这一片**（Tasks 1–13）遇到的实现级判断，
不重复三篇已写的内容。0174–0176 答的是"要不要做、按什么单位、谁优先"；这篇答的是
"扣在哪台机器上、数据结构长什么样、并发和乱序怎么防"。

## 背景

三篇设计 ADR 定了形：credit 是成本锚定的整数、额度是双固定窗不是余额、托管优先于
自带 key 且 key 不过桥。落地时要选：网关跑在哪（VPS 还是 edge）、窗口计数器用什么
数据结构、Stripe 走 SDK 还是裸 REST、runtime 怎么代表发起人调网关、旧的 token 钱包
认不认、档位改没改。

## 决定

### 1. 网关落 edge Worker，不落 VPS

`services/edge` 已经有 JWT 验签、Durable Object、service key、自有域名
（`edge.mrotto.agency`）；VPS 版是单区域，且要重抄一遍鉴权和限流。DO 单线程天然
无竞态，正是 hold/settle 要的东西——两个并发请求同时进一个用户的窗口，不需要额外
加锁。

**会被推翻的前提**：Workers 对上游一方站（DeepSeek/智谱等境内服务）的出网被墙，
或者 SSE 透传出现不可接受的延迟。

### 2. 固定窗用累计数，不用 ADR-0174 第 7 条写的环形桶

ADR-0174 第 3 条定的是固定窗语义（开窗、5h/周后整窗清零），第 7 条却写"用环形桶
实现"——环形桶是滑动窗口的数据结构，与固定窗语义对不上，落地时才发现这个矛盾。
固定窗只需要一个数（`usedMicro` + `openAt`），比一圈格子便宜得多，也不会在窗口
边界产生"半个桶"的模糊态。

**会被推翻的前提**：产品决定改成滑动窗（那时环形桶是正确的实现，这条决定作废）。

### 3. settle 先在 roll 之前查 hold，钱永远有地方落

`settle(state, requestId, costMicro, now, plan)` 自己做 roll，但**先**在当前窗口里
找这次请求的 hold、把它转成已结算的用量，**再**处理其余窗口过期该不该清零。反过来
（先 roll 再找 hold）会出现"hold 落在刚被清零的旧窗口里，settle 找不到它"的空洞——
钱凭空消失。TTL 只负责释放没人回来 settle 的并发坑（客户端断线、进程崩溃），不负责
正常路径的记账时序。

### 4. 加购余额按 `grants[]` 列表存，不是单标量

`credit_grant` 每笔各自 12 个月有效期（ADR-0174 决定五）。单个 `addonMicro` 标量
表示不了"这个月买的还剩多少、上个月买的还剩多少"——两笔到期时间不同，混成一个数
之后无法正确过期。改成 `grants: { micro: number; expiresAt: number }[]`，消耗按
**最早到期先扣**（先花快过期的），过期的整笔丢弃而不是整体清零。

### 5. rebuild 重放固定窗语义，不是简单求和

DO 冷启动从 `usage_event` 重建时，必须按时间升序扫描，遇到 `e.at >= openAt + 5h`
就当场开一个新窗口（用量归零重新累加），扫到末尾再用 `now` 补一次"是否该关窗"的
判断。直接对全部历史事件求和会把好几个已经过期的窗口的用量错误地叠加在一起——
冷启动重建出来的账必须与从未睡过的热态给出同一个数字，这是 DO 作为"投影可从事实
重建"这条硬规则的直接体现。

### 6. addon 结算溢出记进窗口账，不 clamp 归零；hold/settle 入口做 sanitize

实际成本超过剩余 addon 余额时，先扣光 addon，**溢出部分记进窗口账**（若窗口当时
是关的就顺手开一个新窗口）——不能假装这笔钱没花。另外，hold/settle 的输入
（成本估算、`max_tokens`）一律在入口处把非有限数或负数清成 0，函数保持纯净，
不对上游传来的畸形值抛异常。

### 7. Stripe 裸 REST + 手写验签，不装 SDK

同 ADR-0019 决定四的理由：一个依赖换不来更少的代码，且与仓库既有风格一致
（模型 adapter 也是裸 fetch 零 SDK）。**订阅投影只认 `customer.subscription.*`
事件**（自带 `current_period_start/end`），`checkout.session.completed` 在订阅
模式下**不写库**——它只用来在手验时确认 Checkout 链路走通，真正的订阅状态由
Stripe 后续推来的 `subscription.*` 事件建立。

### 8. Stripe 事件乱序防护：`incomplete` 忽略 + `last_event_at` 比较

Stripe 不保证 webhook 到达顺序，且重投窗口长达 3 天。两手：
(a) 状态 `incomplete` 一律 ignore（还没真正付款，不写行——不存在的订阅行本来就
等价于"无订阅"）；`incomplete_expired` 仍按 canceled 处理。
(b) 每条订阅相关事件携带 `eventCreated`（来自 Stripe 的 `event.created`），
`subscription` 表新增 `last_event_at timestamptz`，写库前比较：`eventCreated`
早于已存的 `last_event_at` 就整条忽略。**加购单次上限 `MAX_GRANT_QUANTITY = 100`**，
防止一次异常调用把幂等环刷穿。

### 9. runtime 以平台身份代表发起人调网关

沿用既有的 `x-runtime-secret`（不是 Bearer，见"两处偏差"一节）+
**新增** `x-otto-on-behalf-of: <真用户 uid>` 表明"这次调用替谁花钱"。真人自己的
请求带 `x-otto-on-behalf-of` 一律 400（能代表别人的只有平台）。runtime 扣的是
**发起 turn 的那个人**，不是工作区 owner；runtime 自身仍不持有任何模型 key，
调用凭据只有 `RUNTIME_SECRET`——ADR-0202"runtime 不持有 key"的精神延续到订阅制。
`x-otto-workspace` / `x-otto-session` 两个可选头只进 `usage_event` 的行用于事后
对账，在身份出口截到 128 字节。

**会被推翻的前提**：产品决定群聊由 workspace owner 统一付费而不是各自的订阅
（那时 `on-behalf-of` 语义要从"谁发起"改成"owner 授权谁使用其额度"，是另一套
设计）。

### 10. 旧 token 钱包不认，新账本另起

`0002_token_wallets.sql` 那 68 行账本和 4 个非零余额用户留着不动，但订阅制的
`usage_event` / `credit_grant` 是全新的表，不复用旧结构、不做迁移。维护者拍板：
issue #520（删 token 钱包三张表）继续作废——ADR-0174 已经写过这条，这里重申
"另起"不是"迁移"。

### 11. DO 重建失败一律 throw，不落空态；冷启动包进 `blockConcurrencyWhile`

`state()` 重建失败时**throw**，不回退成一份空投影——空投影落盘等价于"这个人从
没花过钱"，一次 Supabase 抖动就把窗口用量和加购余额一起归零，且从此不会再重建
（storage 里已经有一份"合法"的空 state 了）。DO 把这个异常译成 503
`quota_unavailable`；网关把 hold/routes 抛出的异常包成 503/502 的 upstream 信封。
冷启动重建整段包进 `ctx.blockConcurrencyWhile`——DO 单线程只保证一次 `fetch`
内没人插队，`await` 之间照样会切出去，两个并发的首请求各自重建会导致后写的
那份抹掉前一份的 hold。

### 12. 幂等三处：usage_event / credit_grant / addonGranted

`usage_event` 插入按 `request_id` 做 `on_conflict`；`credit_grant` 按
`stripe_payment_intent_id` 做 `on_conflict`（PostgREST 默认只认主键，两处都要
显式指到唯一列，不然重投的第二次 INSERT 会报唯一键冲突而不是安静地被忽略）。
`addonGranted` 在 DO 里另按 `paymentIntentId` 做一层幂等（200 条环形去重），
但**即使 DB 那行已存在也照样通知 DO**——"行插进去了、通知那步炸了"这个半截
状态只有靠 Stripe 的自然重投才能治好，提前在 DB 层返回会让它永远治不好。
Supabase 项目未开聚合函数（`sum()` 这类），所以 `addonConsumed` 走"拉行 +
客户端求和"（分页上限先设 10000，留作后续优化）。

### 13. 网关流式 tap 用单发 finalizer + UTF-8 字节估算

拦截转发流的三个出口（正常 flush / 客户端取消 / `req.signal` abort）共用同一个
只会真正执行一次的 finalizer：中断路径统一走 `release`（不落 TTL 等它自然过期，
中断的 hold 不该占坑到超时）。预估成本按 `TextEncoder` 的 UTF-8 字节数算，不按
JS 字符串的 UTF-16 code unit——中文流量下两者能差 3 倍，直接影响 hold 预扣得
准不准。`max_tokens` 只认有限正数并 floor，上限钳到 128_000，不合法就退回路由
默认值。hold 成功之后任何异常（读 `remaining` 失败、非流响应的 `res.text()`
失败）一律先 `release` 再回 502，不让一次预扣悬在那里没人收尾。`waitUntil`
是流式 settle（发生在响应已经吐给客户端之后）活下去的缝。

### 14. adapter 的 `reroute` 是单独一类，不退避、只重试一次

网关返回 `429 quota_exhausted` 时，桌面 adapter 把它识别为一类专门的
`reroute`——不同于普通的限流退避，而是"立刻重新走一次端点解析（`routeModel`）"，
因为这次失败的根因是路由选错了（该走 direct 却选了 hosted，或反之），重试同一
端点没有意义。改道之后落一条 `route_changed` 事件，既 append 进日志也
`push.event` 给渲染层——这条改道本身要在会话里看得见。

### 15. 档位改三档

Lite \$19 / Pro \$59 / Max \$89，取代 ADR-0174 写的四档
（Lite/Pro/Max5/Max20），折算规则（毛利率、周额度 = 月预算 ÷ 4、5h = 20% 周额度）
不变，只是维护者拍板砍掉了原来的 Max20 档，把中间档改名 Max。

## 两处偏差（spec 与实现不一致，明确记录不是遗漏）

- **平台身份头**：spec 写的是"平台用 Bearer 携带一个服务 token"，实现沿用了
  仓库里 cs 协议已有的 `x-runtime-secret` 机制（同一把密钥、同一套校验代码），
  没有另开一条 Bearer 路径——两者安全强度等价，复用减少一套鉴权实现。
- **本次花费不回显**：spec 设想响应带一个头告诉客户端"这次调用花了多少 credit"，
  实现里这个头（`x-otto-cost-micro`）还没加，桌面端目前看不到单次调用的即时花费，
  只能看累计的窗口用量。留到下一片。

## 后果

- 网关是无状态的（每个请求独立进 Worker），状态全在 `Quota` DO 与 Supabase 里，
  边缘可以随意扩缩容不需要考虑亲和性。
- `usage_event` 是唯一事实源，`Quota` DO 是投影：这与本仓库"append-only 日志是
  唯一事实来源"的硬规则同构，只是这次的日志落在 Supabase 而不是本地 SQLite。
- 引入了第三条"key 的持有者是谁"的路径（自带 key / 过渡期维护者 key / 现在的
  订阅+官方 key），三者在 `routeModel` 里线性判断，代价是这个函数的分支数又多了
  一层，`modelRoute.ts` 的头注已经把"历史三条路"写清楚。

## 已知未做（下一片）

- `x-otto-cost-micro` 头未加，客户端本次调用的即时花费不显示（见"两处偏差"）。
- rebuild 的 `addonConsumed` 只对未过期的 grant 扣：一笔 addon 在过期之后仍有
  历史消费事件的话，冷启动重建会对它二次计入消耗（不影响余额正确性，只是
  账目上"这笔到底花了多少"在极端情况下会重复计一次）。
- rebuild 的 5h 窗口在跨周边界时会被截断（周窗归零那一刻，尚未关闭的 5h 窗口
  没有特殊处理）。
- webhook 的 content-length 检查可以被省略头绕过，1 MB 上限目前只靠平台
  （Cloudflare）自身的请求体上限兜底，没有应用层强制。
- 加购 webhook 存在一个理论竞态窗口：DB 写行成功、通知 DO 之前，如果同时有
  另一个并发请求触发了 DO 的冷启动重建，两者对同一笔 grant 的处理顺序未做
  单发保护（重投最终会收敛，但收敛前的中间态未验证过）。
- `timingSafeEqual` 在 `edge.ts` 与 `billing.ts` 里各实现了一份，未抽公共函数。
- `services/edge/src` 目前没有"这个目录不许 import `node:*`"的机械断言
  （对照 `services/edge/README.md` 已知取舍一节里"纯函数、不碰运行时"这条，
  目前只靠代码审查维持，没有测试守着）。
- `services/edge/README.md` 里存量的三个生产地址写法不一致（历史遗留，不在
  本片范围内统一）。
- 粘性/比价/failover（ADR-0175 第 3 节所写的完整路由策略）、多模态门禁：均未
  在本片实现，`modelRoute.ts` 目前只做"能不能调"的二元判断。

## 会被推翻的前提

- 决定 1（edge Worker）：见上，Workers 出网受限或 SSE 延迟不可接受。
- 决定 2（累计数不用环形桶）：产品改滑动窗。
- 决定 9（runtime 代表发起人）：产品改成 workspace owner 统一付费。
- 决定 15（三档）：维护者重新拍板档位数量或价格——ADR-0174 自己也写了
  "「一个 turn ≈ 30K token」是拍的，档位数字应在跑一次真实用量聚合之后重定"，
  这条前提对三档同样成立，不因为改了档数而失效。
