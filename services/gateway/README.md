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
   `token_wallets.balance_micro_usd` 是它的求和缓存，`rebuild_wallet()` 随时可重算。
   两者对不上时账本是对的。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 方言，流式/非流式都收。客户端 adapter 不用改形状 |
| GET | `/v1/wallet` | 查余额（余额为 0 也照查） |
| GET | `/healthz` | 存活探针，不要令牌 |

请求头：`Authorization: Bearer <Supabase JWT>`；
可选 `X-Otto-Request-Id: <uuid>` 作幂等键（重试同一次调用不会扣两遍）。

错误码：`401` 令牌问题 · `402` 额度用尽 · `502` 上游不可达 · `503` 钱包服务不可用。

## 部署

前置：`supabase/migrations/0002_token_wallets.sql` 已在 Supabase SQL editor 执行过一次。

```bash
# 服务器（deploy/otto-auth/README.md 里那台）
scp -P 2222 -r services/gateway stan@65.109.113.168:~/otto-gateway
ssh -p 2222 stan@65.109.113.168
cd ~/otto-gateway && npm install
cp .env.example .env && chmod 600 .env   # 填真值，尤其 OTTO_UPSTREAM_API_KEY
npm start
```

nginx 反代到 `:8787` 时**必须关掉响应缓冲**，否则 SSE 会被攒成一坨等到最后才吐：

```nginx
location /gw/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
```

## 计价

`src/pricing.ts` 里的单价是**占位值，上线前必须对着 DeepSeek 官方价目页核过**。
表外型号按表内最贵的算（未知型号免费 = 客户端随便报个名就能白嫖）。
临时改价可用 env：`OTTO_PRICE_DEEPSEEK_V4_FLASH=0.28/0.42`（USD per 1M，入价/出价）。

## 已知取舍

- **允许小额透支**：用量只有模型答完才知道，最后一次调用拦不住。事前门槛是
  「余额 <= 0 就 402」，超支部分由赠额吸收。不做预扣——预扣要退款，退款是另一套账。
- **上游没给 usage 就不扣钱**：宁可漏一笔，也不按猜的数扣。
- **记账失败只记日志**：响应已经发给用户了，回滚不了。靠 `rebuild_wallet()` 对账兜底。
- **`server.ts` 没有单测**：它只做 node:http ⇄ Web Request 的协议转换和读 env，
  逻辑全在 `gateway.ts`，那一侧测得很细（`tests/gateway/`）。
