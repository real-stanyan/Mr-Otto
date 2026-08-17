# otto-auth: 服务器上的第二套 Supabase 栈

Task 1(login-v1 SDD)产物。目标:在已经跑着一套 dryrun 项目 Supabase 的服务器上,
再起一套独立的 Supabase(compose project 名 `otto`),给 Mr Otto 的 Google/GitHub
OAuth 登录用,和 dryrun 的容器/端口互不干扰。

服务器:`ssh -p 2222 stan@65.109.113.168`(root 免密,BatchMode 可用)。

## 目录结构(服务器上)

```
~/otto-supabase-src/          # git clone --depth 1 supabase/supabase(只为拿 docker/ 子目录)
~/otto-supabase/docker/       # 实际部署目录,从上面 cp -r docker 而来
  .env                        # 密钥 + 配置,chmod 600,不进 git
  docker-compose.yml          # 官方文件,本地改过 container_name(见下)
  docker-compose.yml.orig     # 改之前的备份
  docker-compose.override.yml # 本 repo 的 compose.override.yml,scp 过去改名而成
```

`~/otto-supabase-src` 和 `~/otto-supabase/docker` 都不在 git 里(服务器本地状态)。

## 关键决定 / 踩坑

### 1. `supabase/docker` 已经是新版,和需求书假设的键名/服务名有出入

Clone 下来的是 2026-08 的 `supabase/docker`,和需求书里假设的"旧版 kong 网关"
不一样:

- 网关服务名是 `api-gw`,镜像是 **Envoy**(`envoyproxy/envoy`),不是 Kong——
  supabase 在 2025 年把默认网关从 Kong 换成了 Envoy(仓库里注释写着
  `# Envoy is the default API gateway`)。`container_name` 仍然叫
  `supabase-envoy`,网络别名里保留了 `kong` 这个别名做兼容。
  `.env` 里控制它监听端口的变量也从 `KONG_HTTP_PORT` 换成了
  `API_GW_HTTP_PORT`(`KONG_HTTP_PORT` 仍读,作为 fallback:
  `${API_GW_HTTP_PORT:-${KONG_HTTP_PORT:-8000}}`)——两个我都设了,图个保险。
- `ENABLE_EMAIL_SIGNUP` / `ENABLE_ANONYMOUS_USERS` / `DISABLE_SIGNUP` 这几个键名
  在这版 `.env.example` 里**原样存在**,不像需求书担心的那样对不上,不需要塞进
  compose override 的 environment 里。
- `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` / `JWT_KEYS` / `JWT_JWKS`
  这套新的"非对称 + opaque key"体系(ES256)也在 `.env.example` 里,但需求书
  Step 1 的 gen-keys.mjs 只生成旧的 HS256 对称密钥体系(`JWT_SECRET` /
  `ANON_KEY` / `SERVICE_ROLE_KEY`),这版 compose 里旧体系仍然完整可用,新体系
  留空即可正常跑(auth/rest/realtime 都读 `JWT_SECRET`)。Task 5 客户端接入时如果
  要用新版 opaque key,需要另外跑 `./utils/add-new-auth-keys.sh` 补,这次没做。

### 2. 容器名冲突:选了"删掉 container_name 行"这条路

Dryrun 那套栈的容器名是固定的 `supabase-db`、`supabase-studio`、`supabase-kong`
等(官方 compose 硬编码 `container_name:`)。这版新 compose 同样硬编码了 11 个
`container_name:`(`supabase-studio` / `supabase-envoy` / `supabase-auth` /
`supabase-rest` / `realtime-dev.supabase-realtime` / `supabase-storage` /
`supabase-imgproxy` / `supabase-meta` / `supabase-edge-functions` /
`supabase-db` / `supabase-pooler`),和 dryrun 的名字**逐一相同**,直接
`docker compose -p otto up` 会因为容器名冲突起不来。

两种解法里选了**删掉 `container_name` 行**(而不是 sed 加 `otto-` 前缀),因为:
- compose 会自动用 `<project>-<service>-<index>` 补全容器名(`otto-db-1` 之类),
  不用手写前缀,以后升级 `supabase/docker` 重新 clone 时脚本可以照抄。
- 确认过 compose 文件内部没有任何地方用 `container_name` 的值当 hostname
  互相访问(服务发现走的是 compose 生成的 service 名,如 `POSTGRES_HOST=db`),
  删掉这行不影响容器间通信。

服务器上执行的命令(不进 git,纯部署步骤):
```bash
cd ~/otto-supabase/docker
cp docker-compose.yml docker-compose.yml.orig
sed -i '/^    container_name: /d' docker-compose.yml
```

### 3. `.env` 里的 `COMPOSE_FILE` 会吃掉 `docker-compose.override.yml` 的自动加载

这版 `.env.example` 自带一行:
```
COMPOSE_FILE=docker-compose.yml
```
（用来配合仓库自带的 `./run.sh config add|remove` 管理 override 文件列表）。
docker compose 平时会"顺手"自动叠加同目录下的 `docker-compose.override.yml`,
但**一旦 `.env` 里显式设了 `COMPOSE_FILE`,这个自动叠加就失效了**——必须手动把
override 文件名写进这个变量,否则 `docker compose -p otto up` 只会用
`docker-compose.yml`,我们的端口锁定文件被静默忽略(第一次部署就踩了这个坑,
容器起来后端口绑在了 `0.0.0.0` 而不是 `127.0.0.1`)。

修复:
```bash
sed -i 's|^COMPOSE_FILE=docker-compose.yml$|COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml|' .env
```

### 4. `ports` 数组是"拼接"不是"替换",要用 `!override` 合并标签

即使 override 文件被正确加载,docker compose 对 `ports` 这种数组字段默认是
**合并两个文件里的列表**,不是后者覆盖前者。`docker-compose.override.yml` 里
单纯写:
```yaml
services:
  api-gw:
    ports:
      - "127.0.0.1:${API_GW_HTTP_PORT:-8100}:8000"
```
会和 base 文件里原来那条 `${API_GW_HTTP_PORT:-...}:8000/tcp`(不绑 host IP)
**拼成两条**,同时尝试绑同一个 host 端口,容器起不来 / 或者只有其中一条生效。

用 Compose Specification 的 `!override` merge 标签强制"替换整个数组"解决:
```yaml
services:
  api-gw:
    ports: !override
      - "127.0.0.1:${API_GW_HTTP_PORT:-8100}:8000"
  supavisor:
    ports: !override
      - "127.0.0.1:${POSTGRES_PORT:-5433}:5432"
      - "127.0.0.1:${POOLER_PROXY_PORT_TRANSACTION:-6544}:6543"
```
这台机器上 `docker compose version` 是 `v5.1.3`,支持 `!override`/`!reset` 标签。

`studio` 服务这版 compose 本来就没有对外 `ports`(只在容器内网被 `api-gw`
反代到公开端口),不用额外锁。

### 5. 端口分配

| 服务 | dryrun(已占用) | otto(本次) |
|---|---|---|
| API 网关(envoy,兼容名 kong) | 127.0.0.1:8000 | 127.0.0.1:8100 |
| Postgres / supavisor session pooling | 127.0.0.1:5432 | 127.0.0.1:5433 |
| supavisor transaction pooling | 127.0.0.1:6543 | 127.0.0.1:6544 |

对应 `.env`:`API_GW_HTTP_PORT=8100`、`KONG_HTTP_PORT=8100`(fallback 键,一起设)、
`POSTGRES_PORT=5433`、`POOLER_PROXY_PORT_TRANSACTION=6544`。

### 6. 补随机化的 demo 密钥字段(下一个任务就要出公网,不能再留)

`.env.example` 除了需求书 Step 1 覆盖的 5 个值之外,还带一批默认值 / demo
密钥,已经在 gen-keys.mjs 里补上生成、推到服务器 `.env`、并 `docker compose -p
otto up -d` 重建了受影响的容器:

| 字段 | 消费方(docker-compose.yml 里读它的服务) | 长度要求 |
|---|---|---|
| `SECRET_KEY_BASE` | `realtime`、`supavisor` | ≥64 字符 |
| `REALTIME_DB_ENC_KEY` | `realtime`(加密 `_realtime` schema 敏感字段) | 恰好 16 字符 |
| `VAULT_ENC_KEY` | `supavisor` | 恰好 32 字符 |
| `PG_META_CRYPTO_KEY` | `studio`、`meta` | ≥32 字符 |
| `S3_PROTOCOL_ACCESS_KEY_ID`/`SECRET` | `storage` | 无强制长度 |
| `LOGFLARE_PUBLIC_ACCESS_TOKEN`/`PRIVATE_ACCESS_TOKEN` | 无(这版 compose 没有 `analytics`/`vector` 服务,当前未消费) | ≥32 字符 |
| `MINIO_ROOT_PASSWORD` | 无(需要 `docker-compose.s3.yml` overlay 才会用到,当前 `COMPOSE_FILE` 没叠加它) | ≥8 字符 |

`LOGFLARE_*` 和 `MINIO_ROOT_PASSWORD` 虽然当前没有容器读它们,还是一起换成
随机值——一次性成本很低,省得以后哪天升级 compose / 加了 analytics 服务时
留一个没人注意到的 demo 密钥当活靶子。

`POOLER_TENANT_ID`(默认值 `your-tenant-id`)判断为不是"密钥类"字段:它是
supavisor 连接串里的租户命名空间标识符(类似 `postgres.<tenant_id>` 前缀),
本身不是凭证,拿到这个值不能直接连上数据库,所以没有随机化。

重建后重跑过健康检查,`GET /auth/v1/health` 仍返回 200,容器日志(`storage` /
`meta` / `realtime`)干净无报错。

TLS / 反向代理 / `otto-auth.duckdns.org` 对外可达,不在 Task 1 范围内(DNS 已经
指向这台服务器,`dig +short otto-auth.duckdns.org` 返回 `65.109.113.168`),留给
后续任务。

## 部署步骤(服务器侧,已执行过一遍)

```bash
# 1. clone supabase/docker
git clone --depth 1 https://github.com/supabase/supabase ~/otto-supabase-src
mkdir -p ~/otto-supabase
cp -r ~/otto-supabase-src/docker ~/otto-supabase/docker
cd ~/otto-supabase/docker
cp .env.example .env

# 2. 本地(Mac)生成密钥,直接管道进服务器 .env,不落本地盘、不进 git:
#    node deploy/otto-auth/gen-keys.mjs | ssh -p 2222 stan@65.109.113.168 "cat >> ~/otto-supabase/docker/.env"
#    (实际操作里用了一个小合并脚本,把 5 个生成值 + 下面的固定配置值按 key 替换/追加进 .env,
#     而不是简单 >>,避免和 .env.example 里的占位符行重复)

# 3. .env 里除生成值外,还要设:
SITE_URL=https://otto-auth.duckdns.org
API_EXTERNAL_URL=https://otto-auth.duckdns.org/auth/v1
SUPABASE_PUBLIC_URL=https://otto-auth.duckdns.org
ADDITIONAL_REDIRECT_URLS=mrotto://auth-callback,http://127.0.0.1:43110/callback
API_GW_HTTP_PORT=8100
KONG_HTTP_PORT=8100
POSTGRES_PORT=5433
POOLER_PROXY_PORT_TRANSACTION=6544
DISABLE_SIGNUP=false
ENABLE_EMAIL_SIGNUP=false
ENABLE_ANONYMOUS_USERS=false
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml   # 见踩坑 3

chmod 600 .env

# 4. 去掉 container_name 冲突(见踩坑 2)
cp docker-compose.yml docker-compose.yml.orig
sed -i '/^    container_name: /d' docker-compose.yml

# 5. 端口锁定 override(本 repo 的 compose.override.yml,scp 过去改名):
scp -P 2222 deploy/otto-auth/compose.override.yml \
  stan@65.109.113.168:~/otto-supabase/docker/docker-compose.override.yml

# 6. 起栈
cd ~/otto-supabase/docker
docker compose -p otto up -d

# 7. 健康检查
ANON=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
curl -s http://127.0.0.1:8100/auth/v1/health -H "apikey: $ANON"
# => {"version":"v2.189.0","name":"GoTrue","description":"GoTrue is a user registration and authentication API"}
```

## 健康检查结果(2026-08-17)

```
$ curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://127.0.0.1:8100/auth/v1/health -H "apikey: $ANON_KEY"
{"version":"v2.189.0","name":"GoTrue","description":"GoTrue is a user registration and authentication API"}
HTTP_STATUS:200
```

11 个 otto 容器全部 healthy(`db` / `studio` / `api-gw` / `auth` / `rest` /
`realtime` / `storage` / `imgproxy` / `meta` / `functions` / `supavisor`),
dryrun 的容器和端口(8000/5432/6543)未受影响,两套栈的 docker network
(`otto_default` / `supabase_default`)也是分开的。

## TLS 部署(Task 2,2026-08-17)

目标:nginx vhost 只放行 `/auth/v1/`,反代到 Task 1 的 gateway(127.0.0.1:8100),
再用 certbot 签发 Let's Encrypt 证书。**vhost 部分已完成并验证;certbot 部分被一个
task 2 需求书没预料到的上游拦截层挡住,未能签发证书。**

### 已完成

1. `deploy/otto-auth/nginx-otto-auth.conf` scp 到服务器
   `/etc/nginx/sites-available/otto-auth`,`ln -s` 进 `sites-enabled/`,
   `nginx -t` + `systemctl reload nginx`,均成功。
2. **发现并修复一个真实 bug**:需求书 Step 1 给的 vhost 原样部署后,本机验证
   `curl -H 'Host: otto-auth.duckdns.org' http://127.0.0.1/auth/v1/health` 返回
   `426 Upgrade Required`,不是预期的 200 JSON。直接绕过 nginx 打 gateway
   (`curl http://127.0.0.1:8100/auth/v1/health`)是正常的 200,说明问题出在
   nginx→gateway 这一跳。原因:nginx 的 `proxy_pass` 默认用 HTTP/1.0 转发给
   上游,Envoy 网关对 HTTP/1.0 请求直接回 426。加一行 `proxy_http_version 1.1;`
   后,同样的本机验证变成 200 JSON(`{"version":"v2.189.0","name":"GoTrue",...}`),
   `/` 仍是 404。archive 的 conf 文件已经是修复后的版本。
3. `certbot` + `python3-certbot-nginx` 通过 `apt-get` 装好(版本 2.9.0-1),不需要
   snap。`certbot.timer` systemd timer 已确认存在(`systemctl list-timers` 能看到,
   包安装时自带,不用手动建)。

### 未完成 / 被阻塞:certbot 签发证书失败,根因是上游拦截层

`sudo certbot --nginx -d otto-auth.duckdns.org` 报:

```
Domain: otto-auth.duckdns.org
Type:   unauthorized
Detail: 65.109.113.168: Invalid response from
  http://otto-auth.duckdns.org/.well-known/acme-challenge/...: 404
```

排查过程(结论:**不是这台 VPS 的 nginx/防火墙问题,是公网到这台 VPS 之间还有一层
反代/网关,没有把 otto-auth.duckdns.org 的流量转发到这里**):

- 这台 VPS 的 `eth0` 是私网 IP `10.162.249.10/24`,网关 `10.162.249.1`——它本身
  **不直接持有**公网 IP `65.109.113.168`,是被某个上游节点做了 NAT/反代。
- 从 Mac 和从这台 VPS 自己(打自己的公网 IP)访问 `http://otto-auth.duckdns.org/`
  或 `https://.../`,两边都收到同一个**样式化的 "404 Page Not Found" 页面**
  (深色背景 + `Outfit`/`Inter` 字体),`Server: nginx/1.24.0 (Ubuntu)` 头看似像
  这台机器,但这台机器的 `/var/www/html` 里根本没有这个页面文件。
- `sudo tail /var/log/nginx/access.log` 显示:从 127.0.0.1 发的请求(本机验证)
  正常记录;从公网 IP 打进来的探测请求**完全没有落进这台机器的 access log**——
  说明请求根本没到这台 nginx,是在更上游被截胡应答的。
- `443` 端口(这台机器上此时**还没装任何证书、没有任何服务监听 443**)从公网
  居然也能完成 TLS 握手,拿到的证书是:
  `subject=C=AU, ST=NSW, L=Sydney, O=Atlas, CN=catch-all`
  ——自签名,`O=Atlas`。这和 Stan 自己 `~/system/` 里的 "Atlas Method"/
  `~/Github/atlas-dashboard` 明显是同一套个人基础设施的命名。
- 从这台 VPS 内部直接探测网关 `10.162.249.1`(它的 `80`/`443`/`22` 全通),打
  `curl http://10.162.249.1/` 拿到的是**一模一样的 catch-all 404**——证实这个
  网关就是那层反代本体,otto-auth.duckdns.org 目前没有在它的路由表里登记,所以
  落到了它的默认 catch-all 分支,根本没有转发到这台 VPS 的 `10.162.249.10:80`。
  这也是为什么 Let's Encrypt 的 HTTP-01 挑战会拿到 404:LE 服务器打的请求同样
  被这层网关截胡了,从没到过这台机器上刚部署好的 vhost。

**这超出了 task-2-brief.md 给的范围**(需求书假设"域名已经解析到这台机、只需要在
这台机上配 nginx+certbot 就够了",没预料到公网前面还有一层需要单独登记路由的
反代)。Certbot 尝试失败后已自动回滚了它对 vhost 的临时改动,当前
`/etc/nginx/sites-available/otto-auth` 干净,和本 repo 存档的
`nginx-otto-auth.conf` 一致,`nginx -t` 通过,没有留下损坏状态。

**下一步需要谁来处理**:需要有权限管理那层上游反代路由表的人(大概率是
`~/Github/atlas-dashboard` 或类似位置管理的 Stan 个人网关),给
`otto-auth.duckdns.org` 加一条转发规则指向这台 VPS(`10.162.249.10:80`,或者它
认的其他内网寻址方式)。路由生效后,重跑
`sudo certbot --nginx -d otto-auth.duckdns.org --non-interactive --agree-tos -m stanhavenoidea@gmail.com`
应该就能签发成功(nginx vhost 本身已经验证是对的);证书装上后按需求书注释,
`certbot --nginx` 会自动改写这份 vhost 加 443 server block + 80→443 跳转,记得把
改写后的最终版回抄进本文件替换当前版本。

### 验证记录(本机 / VPS 内部,截至 2026-08-17,均在 nginx 加了 `proxy_http_version 1.1` 修复之后)

```
$ ssh -p 2222 stan@65.109.113.168
$ curl -s -H 'Host: otto-auth.duckdns.org' -H "apikey: $ANON_KEY" http://127.0.0.1/auth/v1/health
{"version":"v2.189.0","name":"GoTrue","description":"GoTrue is a user registration and authentication API"}
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: otto-auth.duckdns.org' http://127.0.0.1/
404
```

公网验证(Mac 直连,预期 TLS 生效前会失败,记录为已知阻塞项,非本机配置问题):

```
$ curl -s https://otto-auth.duckdns.org/auth/v1/health
# 404(上游 catch-all 网关应答,不是这台 VPS,见上文根因分析)
$ curl -s -o /dev/null -w '%{http_code}\n' http://otto-auth.duckdns.org/
# 404(同上,未验证到 "301 跳转到 https" —— 因为 certbot 从未成功改写出这个跳转)
```

## ANON_KEY(公开值,Task 5 客户端要用)

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2OTQwMzY4LCJleHAiOjIxMDIzMDAzNjh9.fAajGeN-r_OVpUE0Cm-PhUeQTHxH7bHC7VpbdNQ-D8c
```

其余密钥(`POSTGRES_PASSWORD` / `JWT_SECRET` / `SERVICE_ROLE_KEY` /
`DASHBOARD_PASSWORD`)只在服务器的 `~/otto-supabase/docker/.env` 里,没有落
本地盘、没进 git、这份文档也不复述。
