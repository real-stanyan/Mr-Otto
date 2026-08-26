# otto-edge

Mr Otto 的边缘服务。两件事，互不相干：**OAuth 落地页**和**远程中继**。

```
浏览器（OAuth 回调）──> /auth/landing ──页内 JS──> mrotto://auth-callback

桌面 ──┐                                    ┌── 手机
       └──> /rl/v1/stream + /rl/v1/send <──┘     （盲管道，密文互转）
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
| GET | `/rl/v1/stream?role=desktop\|mobile` | 中继下行（SSE 长连接）。`200` 挂上，`400` role 不合法，`404` 未开中继，`405` 非 GET |
| POST | `/rl/v1/send?role=desktop\|mobile` | 中继上行（一帧一个 POST）。`204` 已转给对端，`409` 对端不在线（丢弃，不排队），`413` 单帧超 256 KiB |

中继要 `Authorization: Bearer <Supabase JWT>`；落地页不要。

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

一户一桌面一手机，同角色重连顶掉旧的。**信任多台、同时连一台**的取舍见 ADR-0128。

下行每 25s 发一条 SSE 注释行 `:\n\n` 保活 —— nginx 的 `proxy_read_timeout` 是 600s。

## 部署

**这个目录正在搬去 Cloudflare Workers**（ADR-0129，#518）。下面写的是**当前**仍在跑的
VPS 形态；Worker 入口落地后 `server.ts` / `nodeAdapter.ts` 一并删除。

公网入口：`https://otto-auth.stan.damianslife.com/gw/`

```bash
ssh -p 2222 stan@65.109.113.168 'mkdir -p ~/otto-gateway/src'
scp -P 2222 services/edge/src/*.ts stan@65.109.113.168:~/otto-gateway/src/
ssh -p 2222 stan@65.109.113.168 'sudo systemctl restart otto-gateway'
```

服务器上的目录名与 systemd 单元名仍叫 `otto-gateway`——**不要**顺手改：改名要停服务、
改 unit、改 nginx，而这台机器整个要退役（#521），为一个即将消失的东西冒一次停机风险
不划算。

nginx 反代**必须** `proxy_buffering off`，否则 SSE 会被攒成一坨等到最后才吐。
（服务器侧的 nginx location 与 systemd unit 曾经在 `deploy/otto-gateway/`，随 ADR-0129
一起删了——它们描述的是一台正在退役的机器。真值以服务器上的为准。）

用 `tsx` 而不是 `node src/server.ts`：Node 24 自带类型擦除，但不会把 `./x.js`
说明符解析到 `./x.ts`，而仓库的 import 都带 `.js` 扩展。

## 已知取舍

- **`server.ts` / `nodeAdapter.ts` 是过渡件**。它们只做 node:http ⇄ Web Request 的协议
  转换和读 env，逻辑全在 `edge.ts`，那一侧测得很细（`tests/edge/`）。留着是因为过渡期里
  生产上跑的仍然是这个进程——main 上没有一份能构建的源码，想在旧服务上改点什么就会
  发现无从下手。
- **`edge.ts` 不碰 node:http**，纯 `Request` → `Response`。这既是为了能测（直接造
  `Request` 打它，不起端口），也是为什么搬 Worker 的成本这么低。
