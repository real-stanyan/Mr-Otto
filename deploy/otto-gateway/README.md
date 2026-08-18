# otto-gateway 的服务器侧配置

服务器：`ssh -p 2222 stan@65.109.113.168`（与 `deploy/otto-auth` 同一台）。
本目录是**服务器上已生效配置的副本**，改这边记得同步过去，反之亦然。

| 文件 | 服务器路径 |
|---|---|
| `otto-gateway.service` | `/etc/systemd/system/otto-gateway.service` |
| `nginx-gw-location.conf` | 插在 `/etc/nginx/sites-available/otto-auth` 的 server 块里 |

代码本体在 `~/otto-gateway`，`.env`（chmod 600）不在 git 里。

## 部署状态（2026-08-18）

- `supabase/migrations/0002_token_wallets.sql` 已在 `otto-db-1` 执行并逐条验过行为
- 服务已 `systemctl enable --now`，开机自启
- 公网入口：`https://otto-auth.stan.damianslife.com/gw/`（`/gw/healthz` 返回 200）
- **`OTTO_UPSTREAM_API_KEY` still 是占位值** `REPLACE_ME_ROTATED_DEEPSEEK_KEY`

## 填官方 key（唯一未完成的一步）

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
