# otto-gateway 的服务器侧配置

服务器：`ssh -p 2222 stan@65.109.113.168`。这台曾经还跑着自托管 Supabase 的 docker 栈，
那套 2026-08-25 迁去 Supabase Cloud 后退役了（见 `src/main/authConfig.ts` 头注）——
**网关本身没跟着退**，它还在这台上服务 `/gw/`。

本目录是**服务器上已生效配置的副本**，改这边记得同步过去，反之亦然。

| 文件 | 服务器路径 |
|---|---|
| `otto-gateway.service` | `/etc/systemd/system/otto-gateway.service` |
| `nginx-gw-location.conf` | 插在 `/etc/nginx/sites-available/otto-auth` 的 server 块里 |

vhost 文件名和域名里的 `otto-auth` 是历史遗留：这个 host 上 `/auth/v1/`、`/rest/v1/`、
`/realtime/v1/` 那几个反代随自托管栈一起死了，`/gw/` 这一条还活着，也是现在唯一活着的。
看见 `otto-auth.stan.damianslife.com` 别当成死链接删——先分清是哪一半。

代码本体在 `~/otto-gateway`，`.env`（chmod 600）不在 git 里。数据不在这台机器上：
网关经 `SUPABASE_URL` + service role key 走 HTTPS 打 Cloud 项目
（`services/gateway/.env.example`），本地不再有库。

## 部署状态（2026-08-25）

- 钱包 schema（`0002_token_wallets.sql`、`0003_token_denominated_wallet.sql`，
  0003 起计费单位是 token、按 flash/pro 分桶，ADR-0021）随整套 schema 迁到了
  Cloud 项目，网关的扣额度走它
- 服务器 `.env` 的 `SUPABASE_URL` / `SUPABASE_JWT_SECRET` /
  `SUPABASE_SERVICE_ROLE_KEY` 已换成 Cloud 项目的值，旧值备份在
  `~/otto-gateway/.env.bak-selfhosted`。这三个值还指着旧栈时的症状是
  **所有请求 401**（验不过客户端 JWT），不像"库搬走了"——别往上游 key 上找
- 服务已 `systemctl enable --now`，开机自启
- 公网入口：`https://otto-auth.stan.damianslife.com/gw/`（`/gw/healthz` 返回 200）
- **`OTTO_UPSTREAM_API_KEY` still 是占位值** `REPLACE_ME_ROTATED_DEEPSEEK_KEY`

## 填官方 key

key 不要贴进聊天/工单/仓库任何地方。直接在服务器上改：

```bash
ssh -p 2222 stan@65.109.113.168
sed -i 's|^OTTO_UPSTREAM_API_KEY=.*|OTTO_UPSTREAM_API_KEY=你的新key|' ~/otto-gateway/.env
sudo systemctl restart otto-gateway
```

验一下（应当返回真实回答而不是 401）：

```bash
sudo journalctl -u otto-gateway -n 20 --no-pager
```

## 为什么用 tsx 而不是 node 直接跑 .ts

Node 24 自带类型擦除，但**不会把 `./x.js` 说明符解析到 `./x.ts`**——
仓库的 import 都带 `.js` 扩展（`verbatimModuleSyntax` + nodenext 的要求），
直接 `node src/server.ts` 会 `ERR_MODULE_NOT_FOUND`。tsx 负责这层解析。

## 常用命令

```bash
sudo systemctl status otto-gateway
sudo journalctl -u otto-gateway -f
```

更新代码：本地 `scp` 覆盖 `~/otto-gateway/src/`，然后 `sudo systemctl restart otto-gateway`。
