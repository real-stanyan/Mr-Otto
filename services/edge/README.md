# otto-edge

Mr Otto 的边缘服务。两件事，互不相干：**OAuth 落地页**和**远程中继**。

```
浏览器（OAuth 回调）──> /auth/landing ──页内 JS──> mrotto://auth-callback

桌面 ──┐                              ┌── 手机
       └──> /rl/v1/connect (WS) <────┘     （盲管道，密文互转）
                    │
              Durable Object：一户一个实例，闲时休眠
```

> **它曾经是 otto-gateway**（`services/gateway/`）——拿官方 DeepSeek key 代理模型调用、
> 按 token 桶扣额度（ADR-0019 / 0021）。ADR-0085 关掉了那条产品线，ADR-0129 删掉了它的
> 实现，连同数据库里的钱包表。删完之后这个服务不再 gate 任何东西，所以改名 edge。
> 历史细节看那三份 ADR，不在这里复述。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活探针，不要令牌 |
| GET | `/auth/landing` | OAuth 落地页。不要令牌，浏览器裸访问，回 HTML |
| GET | `/rl/v1/connect?role=desktop\|mobile` | 中继。WebSocket upgrade，上下行同一条。`101` 接上，`400` role 不合法，`401` 凭据问题，`404` 未开中继，`426` 不是 upgrade 请求 |

**凭据走子协议**：客户端发 `Sec-WebSocket-Protocol: mrotto.v1, <Supabase JWT>`，服务端只
echo 回 `mrotto.v1`。标准 `WebSocket` 构造函数带不了自定义头，而放 query 参数等于把
access token 写进各层访问日志和 Referer。落地页不要凭据。

验签在**门口**（`edge.ts`）做完，转给 DO 的请求里没有 token —— DO 只需要知道 role。

## 落地页为什么要存在

OAuth 的 `redirect_to` 直接填 `mrotto://` 深链时，浏览器把深链丢给系统后**标签页原地
不动**——用户盯着 Google 的账号选择页以为卡住了，其实 app 已经登录成功。落地页给浏览器
一个明确的终点：显示结果 + JS 转发 code。

`code` 只在 URL query 里过一手，页面不存不发；换 token 发生在 app 内（PKCE，code 单独
没有 verifier 换不出任何东西）。深链前缀与 `src/main/account.ts` 的 `parseAuthCallback`
必须一致。

## 中继的三条不变量

`/rl/v1/*` 是**盲管道**。负载是端到端加密的密文，它只按 `user_id` 把桌面那一端和手机
那一端的字节互转：

1. **不解析负载** —— 密文对它就该是不透明字节
2. **不落盘** —— 会话内容一个字节都不进库
3. **不打印负载** —— `tests/edge/relay.test.ts` 有一条测试专门钉这个，因为
   「调试时顺手 console.log 一下」是这类系统最常见的泄漏方式

一户一桌面一手机，同角色重连顶掉旧的。**信任多台、同时连一台**的取舍见 ADR-0128；
要真正同时在线见 issue #530。

控制信道（`:peer` 在场信号、`:ping`/`:pong` 心跳）靠 `:` 前缀与载荷分开：载荷是 base64url，
字母表 `A-Za-z0-9-_` 里没有冒号，所以一个字节的前缀就够，中继依旧不碰内容。约定在
`src/shared/remote/wire.ts`，**三方共用一份**。

心跳由 `setWebSocketAutoResponse` 在**边缘**直接应答，**不唤醒 DO** —— 既探得出半开连接
（iOS 切后台掐 socket 而 WebSocket 未必立刻 onclose），又不产生计费时长。

## 部署

```bash
npm --prefix services/edge run deploy       # wrangler deploy
npx wrangler secret put SUPABASE_JWT_SECRET # 只做一次，值不进 git
```

`wrangler.jsonc` 里 `compatibility_date` 定住运行时行为，**别顺手往上抬** —— 抬它等于换一批默认值。

`SUPABASE_JWT_SECRET` 是 Dashboard → Settings → API → JWT Settings 里的 legacy JWT secret
（`src/jwt.ts` 只认 HS256，所以项目的签名 key 必须停在 legacy HS256 那把）。

本地开发：`npm --prefix services/edge install` 一次（装 wrangler），然后
`npm --prefix services/edge run dev` 起 `wrangler dev`（真 workerd + 真 DO），
假 secret 放 `services/edge/.dev.vars`（已 gitignore）。

> **`@cloudflare/workers-types` 装在根**，不在这个目录：`npm test` 里那条
> `tsc -p services/edge` 属于门禁，而门禁必须是「clone 完 `npm ci` + `npm test`」
> 一条路走完。装在这里的话 CI 只在根 `npm ci` 就找不到它（实测 TS2688）。
> wrangler 留在这里是因为它只在部署和本地 dev 用，不进门禁。

### 运行时那一层怎么验

单测跑的是纯逻辑 + 一个照着 `worker.ts` 写的假 DO，**覆盖不到** `acceptWebSocket` 的休眠
语义、tag 存取、101 响应形状、子协议 echo。那几件事坏掉的样子是"连上了但什么都不发生"，
没有报错。所以：

```bash
npm --prefix services/edge run check:relay                     # 打生产
npm --prefix services/edge run check:relay http://127.0.0.1:8799  # 打本地 dev
```

17 条端到端断言（配对、互转、顶替、心跳、隔离、帧上限）。**不进门禁**（它要网络和 secret），
改中继的 PR 贴它的结果。

## 已知取舍

- **`edge.ts` 与 `relay.ts` 不碰任何运行时**，纯 `Request` → `Response` / 纯函数。所以它们
  跟着根门禁跑，安全不变量的测试不需要起 workerd —— 那种测试必须便宜到每次提交都跑。
  运行时那一层只剩 `worker.ts`，薄到几乎没有分支。
- **`jwt.ts` 用 WebCrypto 而不是 `node:crypto`**：Worker 里要有 `node:crypto` 得开
  `nodejs_compat`，为一次 HMAC 拉进整个 Node 兼容层不划算。代价是验签变成异步的。
- **中继一个 storage API 都不调**。「不落盘」因此是字面意义的，不是靠纪律；顺带也没有
  SQLite 存储计费。
