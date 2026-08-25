# ADR-0093: 自建 Supabase 退役，迁到 Supabase Cloud

日期：2026-08-25
状态：已接受（stanyan 会话指示；实现见 PR #406，本 ADR 是补记）

## 决定

Mr Otto 的认证与业务库从 VPS 上自建的 Supabase docker 栈（`deploy/otto-auth/`，
compose project `otto`）整体迁到 Supabase Cloud，项目 ref `kpeemypbhkynapkjzewr`。

- 客户端 `src/main/authConfig.ts` 与网关 `SUPABASE_URL` 都指向
  `https://kpeemypbhkynapkjzewr.supabase.co`。
- schema（0001–0010）、`auth.users` / `auth.identities`、public 下 11 张表的数据、
  19 条 RLS 策略、序列、注册触发器全部搬过去并逐项对账。
- 云项目的签名 key **停在 legacy HS256** 那把（新建项目默认发的是 ES256）。
- `deploy/otto-auth/` 整个目录删除，仓库不再保留自建栈的搭建物。

## 理由

- 迁移的直接动因是邮箱确认信：自建 GoTrue 要自己接 SMTP、自己扛投递率，
  Cloud 免费档直接给。邮箱密码注册（ADR 待补 / PR #406）没有确认信就不成立。
- 一台 VPS 上十三个容器换成托管服务，省掉的是备份、升级、证书、Realtime
  这几件长期没人愿意值班的事。
- **HS256 而不是 ES256**：网关 `services/gateway/src/jwt.ts` 是手写的验签，
  只认 HS256。换 ES256 要给网关加 JWKS 拉取 + 缓存 + 轮转处理，是一件独立的
  工程；迁移当天把云项目的 key 切回 legacy HS256，一行代码不动就能过。
  代价记在这里：这条路把项目钉在了 legacy key 上，将来 Supabase 停供 legacy
  HS256 时，网关必须先支持 ES256/JWKS 才能跟着走。
- **`deploy/otto-auth/` 删而不留**：它是一份搭建记录，不是配置源；留在树里
  只会让下一个人以为那套栈还在。历史在 git 里，删除不等于消失。

## 遗留

- 那台 VPS 上的 `otto` compose 栈**当时没有停**：nginx 日志显示还有未升级的
  打包版客户端在按 30 秒心跳打 `/rest/v1/`。停栈的前提是发一版指向 Cloud 的
  构建并确认老栈日志静默（`docker compose -p otto down`，不带 `-v`，卷保留）。
- `otto-auth.stan.damianslife.com` 这个域名**不随栈退役**：otto-gateway 仍然
  跑在那台 VPS 上，靠这个 vhost 的 `/gw/` location 对外，`src/shared/gatewayConfig.ts`
  指的就是它。死掉的只是同一个 vhost 上 `/auth/v1/`、`/rest/v1/`、`/realtime/v1/`
  这三个转给自建栈的前缀。
- 迁移漏了 `supabase_realtime` publication 的成员关系（pg_dump 不会为它生成
  alter），云库上它一直是空的 —— 好友/私信的 postgres_changes 一条都没推，
  客户端按 ADR-0027 静默走轮询兜底。由 `supabase/migrations/0012` 补回。

## 会被推翻的前提

「托管比自建省事」若因价格、数据驻留或合规要求不再成立，本决定失效；
届时回自建的成本是恢复 `deploy/otto-auth/`（git 历史里）+ 反向迁一次数据。
