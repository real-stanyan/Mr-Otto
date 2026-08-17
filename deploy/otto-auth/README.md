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

### 6. 尚未处理的已知缺口(记录下来,不在本 Task 范围内)

`.env.example` 里除了需求书 Step 1 覆盖的 5 个值(`POSTGRES_PASSWORD` /
`JWT_SECRET` / `ANON_KEY` / `SERVICE_ROLE_KEY` / `DASHBOARD_PASSWORD`)之外,
还有一批默认值 / demo 密钥没有随机化:`SECRET_KEY_BASE`、
`REALTIME_DB_ENC_KEY`、`VAULT_ENC_KEY`、`PG_META_CRYPTO_KEY`、
`LOGFLARE_PUBLIC_ACCESS_TOKEN`、`LOGFLARE_PRIVATE_ACCESS_TOKEN`、
`S3_PROTOCOL_ACCESS_KEY_ID`/`SECRET`、`POOLER_TENANT_ID`、`MINIO_ROOT_PASSWORD`。
这些字段各有长度要求(比如 `SECRET_KEY_BASE` ≥64 字符、`REALTIME_DB_ENC_KEY`
恰好 16 字符),需求书的 gen-keys.mjs 没覆盖,超出了 Task 1 明确列出的范围,
先按官方 demo 默认值放着——反正整个栈只绑 `127.0.0.1`,不直接对公网暴露。
后续做安全加固/上生产前应该补一轮 `sh utils/generate-keys.sh` 或手动
`openssl rand` 替换。

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

## ANON_KEY(公开值,Task 5 客户端要用)

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2OTQwMzY4LCJleHAiOjIxMDIzMDAzNjh9.fAajGeN-r_OVpUE0Cm-PhUeQTHxH7bHC7VpbdNQ-D8c
```

其余密钥(`POSTGRES_PASSWORD` / `JWT_SECRET` / `SERVICE_ROLE_KEY` /
`DASHBOARD_PASSWORD`)只在服务器的 `~/otto-supabase/docker/.env` 里,没有落
本地盘、没进 git、这份文档也不复述。
