# otto-gateway

Mr Otto 的官方 key 网关。客户端拿 Supabase JWT 找它，它拿真 DeepSeek key 找上游，
按用量扣每个用户的 token 额度。

```
Electron 客户端 ──Supabase JWT──> otto-gateway ──官方 key──> DeepSeek
                                       │
                                       └── Supabase Postgres（账本 + 余额）
```

## 为什么必须有这一层

`src/model/openaiCompatible.ts` 是**客户端直连**上游。Electron 打包（asar）不是加密，
官方 key 塞进客户端 = 每个用户都能提取；余额存客户端 = 每个用户都能改。
「统一官方 key + 每人 20 USD 额度」在纯客户端形态下不成立，不是难做，是做不成。

网关把两件事收回服务端：**key 只在服务器**，**余额只在数据库**。

## 三条不变量

1. **官方 key 只活在服务器进程的 env 里**。不进 git、不下发客户端、不进日志。
2. **`service_role` key 同上**。它绕过 RLS，泄漏等于所有人的钱包失守。
3. **账本是唯一事实来源，余额是投影**。`token_ledger` 只增不改不删；
   `token_balances.balance_tokens` 是它按桶的求和缓存，`rebuild_balance()` 随时可重算。
   两者对不上时账本是对的。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 方言，流式/非流式都收。客户端 adapter 不用改形状 |
| GET | `/v1/wallet` | 逐桶查余额（余额为 0 也照查） |
| GET | `/healthz` | 存活探针，不要令牌 |

请求头：`Authorization: Bearer <Supabase JWT>`；
可选 `X-Otto-Request-Id: <uuid>` 作幂等键（重试同一次调用不会扣两遍）。

错误码：`400` 型号不在桶里 · `401` 令牌问题 · `402` 该桶额度用尽 · `502` 上游不可达 · `503` 钱包服务不可用。

## 部署

已部署（2026-08-18）。服务器侧配置的副本、以及**填官方 key 的最后一步**见
`deploy/otto-gateway/README.md`。

公网入口：`https://otto-auth.stan.damianslife.com/gw/`
→ 客户端的 baseUrl 用 `https://otto-auth.stan.damianslife.com/gw/v1`

重新部署代码：

```bash
ssh -p 2222 stan@65.109.113.168 'mkdir -p ~/otto-gateway/src'
scp -P 2222 services/gateway/src/*.ts stan@65.109.113.168:~/otto-gateway/src/
ssh -p 2222 stan@65.109.113.168 'sudo systemctl restart otto-gateway'
```

nginx 反代**必须** `proxy_buffering off`，否则 SSE 会被攒成一坨等到最后才吐
（`deploy/otto-gateway/nginx-gw-location.conf` 里已经关了）。

用 `tsx` 而不是 `node src/server.ts`：Node 24 自带类型擦除，但不会把 `./x.js`
说明符解析到 `./x.ts`，而仓库的 import 都带 `.js` 扩展。

## 计费单位：token，按桶（ADR-0021）

余额记的是 **token 数**，不是钱——额度要能直接当德州筹码，美元每押一注都得换算一次。

`flash` 和 `pro` **各有各的余额，互不流通**。分桶不是为了好看：同样 1 个 token，
flash 输入 0.28 USD/1M、pro 输出 2.19 USD/1M，差 7.8 倍。一个统一的 token 余额
等于开着套利口子（全切 pro，扣同样多，平台付 7.8 倍）。分桶之后每个桶的最坏成本
= 桶容量 × 该型号最贵那一档，封死。

桶内输入/输出按 1:1 计，不再加权：桶容量已经把最坏成本封住，再套权重只是把
「整数好算」这个唯一的好处又还回去。

型号 → 桶的映射在 `src/buckets.ts`。**表外型号直接 400 拒收**，不是悄悄扣最贵那桶——
官方额度只覆盖列出来的型号，顺带堵住拿官方 key 代理任意模型。

赠额可用 env 调：`OTTO_GRANT_FLASH_TOKENS` / `OTTO_GRANT_PRO_TOKENS`。

## 已知取舍

- **允许小额透支**：用量只有模型答完才知道，最后一次调用拦不住。事前门槛是
  「该桶余额 <= 0 就 402」，超支部分由赠额吸收。不做预扣——预扣要退款，退款是另一套账。
  另一个桶不受影响：一档用尽还能换另一档。
- **上游没给 usage 就不扣 token**：宁可漏一笔，也不按猜的数扣。
- **记账失败只记日志**：响应已经发给用户了，回滚不了。靠 `rebuild_wallet()` 对账兜底。
- **`server.ts` 没有单测**：它只做 node:http ⇄ Web Request 的协议转换和读 env，
  逻辑全在 `gateway.ts`，那一侧测得很细（`tests/gateway/`）。
