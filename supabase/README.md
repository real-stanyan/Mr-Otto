# Supabase migrations

真库 = **Supabase Cloud 项目 `kpeemypbhkynapkjzewr`**
(`https://kpeemypbhkynapkjzewr.supabase.co`,ap-northeast-1;配置见 `src/main/authConfig.ts`)。

> **订正(2026-08-25)**:本文原先写的是自托管实例 `https://otto-auth.stan.damianslife.com`。
> `2797488` 把 authConfig 指向 Cloud、`84fb628` 让自建栈退役之后,那个地址与 VPS 上的
> `otto-db-1` / `supabase-db-1` 容器**都是退役旧栈**——它们的表还停在 0010,数据也不再更新。
> 对着它们执行 migration 或跑 checks 是无效的,而且**不会报错**,只会静静地改错一个库。
> 本次订正的直接起因就是踩了这一脚。**那两个容器至今还在跑**(停不掉的理由见 ADR-0098),
> 所以这段警告在它们真正停掉之前一直有效。

执行方式:Supabase Studio → SQL editor 粘贴整个 migration 文件运行(按文件名顺序)。
agent 也可以不开浏览器,拿 Management API 直接跑
(`POST /v1/projects/{ref}/database/query`,body 是 `{"query": "整个文件"}`,
带 personal access token)——`0012` / `0013` 就是这么跑的。
无 CLI 管线——本目录是唯一事实来源,改 schema 必须新增编号 migration 文件。

**旧文件永远不改**:真库上已经跑过的那一次撤不回来,改文件只会让文件和真库对不上,
而下一个人读到的是文件。发现旧 migration 写错了,订正写进新 migration 或 ADR
(`0008` 的头注就是这么被订正的,见下表)。

前置检查:publication `supabase_realtime` 存在**且好友三张表在它里面**——光有 publication
不够,成员关系是单独一份状态(`0013` 就是踩了这个,见下表)。

Realtime 通不通决定的是**快慢不是有无**(ADR-0027):客户端在订阅报错时会切到
轮询兜底,并用 `profiles.last_seen_at` 心跳兜住在线状态。这条兜底路径不因为换了
托管版就该删——订阅照样会因为网络、配额、客户端休眠而断,断了好友/私信只是慢几秒。

## 各文件要点

| 文件 | 内容 | 备注 |
|---|---|---|
| `0001_friends.sql` | profiles / friendships / messages + RLS + Realtime | 重跑安全,见文件头 |
| `0002` / `0003` | 额度钱包(`token_wallets` / `token_ledger` / `token_balances`,0003 起计费单位是 token、按 flash/pro 分桶,ADR-0021) | 功能休眠但表还在,网关按它扣额度;至今没有 check 脚本 |
| `0004` / `0005` / `0010` | 德州扑克的账本 / 牌桌 / 规则放开 | 已被 `0012_drop_poker.sql` 整体撤销。文件留着不删:真库确实按顺序跑过它们,把源头抽掉会让 `0012` 在删什么变得读不懂 |
| `0006_presence_heartbeat_and_game_invites.sql` | `profiles.last_seen_at` 心跳列 + `game_invites` 牌局邀请表 | 心跳这半边是在线点的第二来源,还在用;`game_invites` 那半边随 `0012` 一起没了 |
| `0007_profile_onboarding.sql` | `profiles.onboarded_at` 首登标记 + 修 `handle_auth_user_upsert` 不再用 provider 头像覆盖用户自设的头像 | 没跑这一条时,读资料会报列不存在,身份退回 `AccountInfo`(改动前的行为),引导不弹、改资料报错;详见 ADR-0028 |
| `0008_workspace_presence.sql` | `profiles.repo_key` / `repo_branch` 两列,心跳顺带广播「我在哪个仓库哪根分支」 | 没跑这一条时,客户端整拍心跳会被 PGRST204/42703 打回,自动退回旧形状——在线点照常,好友分支徽章全空;设计见 ADR-0055。**注意文件头注里「好友之间只能比对」那句不准确**:两列的读权限沿用 `profiles` 的 `using(true)` select policy，对**所有注册用户**可见，不止好友（#236，维护者已判定接受;migration 文件是历史记录不改，订正在 ADR-0055） |
| `0009_revoke_trigger_function_execute.sql` | 收掉 `handle_auth_user_upsert` 对 PUBLIC/anon/authenticated 的 execute | 纯收权限,不改形状。收之前对着真库做过事务内注册冒烟(见 issue #78) |
| `0011_remote_devices.sql` | 手机端远程投影的 `devices` 配对表（ADR-0094 起四篇） | **尚未在 Cloud 上执行**，见下节；不是本目录里唯一没跑的，但它是唯一有人在等的 |
| `0012_drop_poker.sql` | 删掉德州扑克的全部表 / 函数 / policy | 删除面**不含**钱包:`token_*` 三张表和 `grant_tokens` / `spend_tokens` / `rebuild_balance` 是另一套(休眠中的)功能,网关还在用 |
| `0013_realtime_publication.sql` | 把好友三张表重新加回 `supabase_realtime` publication | 迁 Cloud 时 schema 和数据都过去了、publication 成员关系没有。没跑这一条时不报错,只是"慢":推送全断,一路走轮询兜底(ADR-0027) |
| `0017_subscriptions.sql` | 订阅制五张表（`plan` / `subscription` / `credit_grant` / `usage_event` / `model_route`）+ RLS；seed 在 `seed/0017_plans_routes.sql`（档位数字与首批价表，**价格待核**） | ADR-0174 起三篇 + spec 2026-09-02；旧 `token_*` 三张不动不认（#696）。**尚未在 Cloud 上执行** |

## 真库执行状态

截至 **2026-08-23**,`0001`–`0009` 全部已在**当时的自托管实例**执行完毕,并对着那个库跑过
`checks/` 下现有的全部校验脚本(`0001` / `0004` / `0005` / `0006` / `0007` / `0008` /
`0009`),逐条 PASS。整套 schema 于 **2026-08-25** 迁到 Cloud 项目 `kpeemypbhkynapkjzewr`。

`0012_drop_poker.sql` / `0013_realtime_publication.sql` 同日已在 Cloud 上执行并核对过结果:
public 下只剩 `profiles` / `friendships` / `messages` 与 `token_*` 三张,函数只剩
`handle_auth_user_upsert` / `grant_tokens` / `spend_tokens` / `rebuild_balance`,
`supabase_realtime` 里是好友那三张表。

**2026-08-25 迁云后的状态**:数据已迁到 Cloud 项目 `kpeemypbhkynapkjzewr`,`profiles` 等表在。
但 **`0011_remote_devices.sql` 尚未执行**——用 anon key 探 PostgREST,`profiles` 回 200 而
`devices` 回 404(与一个不存在的表同码,已用对照组确认)。手机端远程投影(ADR-0094 起四篇)
的配对一连就会 404,计划 B 开工前必须先补这一条。`0010` 的执行状态未核。

`0017_subscriptions.sql` 及其 seed(`seed/0017_plans_routes.sql`)**尚未在 Cloud 上执行**。

这一行会过期,所以它记的是**日期**不是「已完成」:新增 migration 之后要么补一行,
要么直接跑一遍 checks —— 校验脚本不留痕,想知道真库是什么形状,跑它比读这段字准。

`0002` / `0003`(额度钱包)至今没有 check 脚本,那两条的真库形状只有"表在不在"这个
层面被 #76 的暴露面审计核过。

## checks 怎么跑

`checks/` 下按编号对应的 `.check.sql` 是对着真库的一致性校验(整段事务 + rollback,不留痕)。

> 曾经这里写的是 `ssh <vps> docker exec -i otto-db-1 psql`。那条路**通向已退役的自托管栈**,
> 不是真库;它还回得出数据,所以照抄不会报错,只会改错库。下面这条是现在的跑法。

一条命令跑全部:

```bash
OTTO_DB_URL='postgresql://...' scripts/db-checks.sh        # 全跑
OTTO_DB_URL='postgresql://...' scripts/db-checks.sh 0008   # 只跑文件名含 0008 的
```

连接串在 Supabase Dashboard → Project Settings → Database 里取,**由调用方临时传进来,
不进仓库**:它带库密码,和写死在 `authConfig.ts` 里的 anon key 不是一个性质的东西。
