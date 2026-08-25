# Supabase migrations

真库 = **Supabase Cloud 项目 `kpeemypbhkynapkjzewr`**
(`https://kpeemypbhkynapkjzewr.supabase.co`,ap-northeast-1;配置见 `src/main/authConfig.ts`)。

> **订正(2026-08-25)**:本文原先写的是自托管实例 `https://otto-auth.stan.damianslife.com`。
> `2797488` 把 authConfig 指向 Cloud、`84fb628` 让自建栈退役之后,那个地址与 VPS 上的
> `otto-db-1` / `supabase-db-1` 容器**都是退役旧栈**——它们的表还停在 0010,数据也不再更新。
> 对着它们执行 migration 或跑 checks 是无效的,而且**不会报错**,只会静静地改错一个库。
> 本次订正的直接起因就是踩了这一脚。

执行方式:Supabase Studio → SQL editor 粘贴整个 migration 文件运行(按文件名顺序)。
无 CLI 管线——本目录是唯一事实来源,改 schema 必须新增编号 migration 文件,不改旧文件。

前置检查:实例必须开着 Realtime 服务(presence + postgres_changes),
且 publication `supabase_realtime` 存在——docker-compose 自托管默认有。

Realtime 通不通决定的是**快慢不是有无**(ADR-0027):客户端在订阅报错时会切到
轮询兜底,并用 `profiles.last_seen_at` 心跳兜住在线状态。所以自托管实例的
Realtime 暂时坏着(issue #77)时,好友/私信/牌局邀请仍然可用,只是慢几秒。

## 各文件要点

| 文件 | 内容 | 备注 |
|---|---|---|
| `0001_friends.sql` | profiles / friendships / messages + RLS + Realtime | 重跑安全,见文件头 |
| `0002`–`0005` | 额度钱包 / 德州账本 / 牌桌 | — |
| `0006_presence_heartbeat_and_game_invites.sql` | `profiles.last_seen_at` 心跳列 + `game_invites` 牌局邀请表 | 没跑这一条时,邀请功能会报表不存在;在线点退回只认 Realtime presence |
| `0007_profile_onboarding.sql` | `profiles.onboarded_at` 首登标记 + 修 `handle_auth_user_upsert` 不再用 provider 头像覆盖用户自设的头像 | 没跑这一条时,读资料会报列不存在,身份退回 `AccountInfo`(改动前的行为),引导不弹、改资料报错;详见 ADR-0028 |
| `0008_workspace_presence.sql` | `profiles.repo_key` / `repo_branch` 两列,心跳顺带广播「我在哪个仓库哪根分支」 | 没跑这一条时,客户端整拍心跳会被 PGRST204/42703 打回,自动退回旧形状——在线点照常,好友分支徽章全空;设计见 ADR-0055。**注意文件头注里「好友之间只能比对」那句不准确**:两列的读权限沿用 `profiles` 的 `using(true)` select policy，对**所有注册用户**可见，不止好友（#236，维护者已判定接受；migration 文件是历史记录不改，订正在 ADR-0055） |
| `0009_revoke_trigger_function_execute.sql` | 收掉 `handle_auth_user_upsert` 对 PUBLIC/anon/authenticated 的 execute | 纯收权限,不改形状。收之前对着真库做过事务内注册冒烟(见 issue #78);校验脚本要用 `-U supabase_admin` 跑,`postgres` 没有 set role `supabase_auth_admin` 的权限 |

`checks/` 下同名 `.check.sql` 是对着真库的一致性校验(整段事务 + rollback,不留痕),
跑法写在每个文件头部。

## 真库执行状态

截至 **2026-08-23**,`0001`–`0009` 全部已在**当时的自托管实例**执行完毕,并对着那个库跑过
`checks/` 下现有的全部校验脚本(`0001` / `0004` / `0005` / `0006` / `0007` / `0008` /
`0009`),逐条 PASS。

**2026-08-25 迁云后的状态**:数据已迁到 Cloud 项目 `kpeemypbhkynapkjzewr`,`profiles` 等表在。
但 **`0011_remote_devices.sql` 尚未执行**——用 anon key 探 PostgREST,`profiles` 回 200 而
`devices` 回 404(与一个不存在的表同码,已用对照组确认)。手机端远程投影(ADR-0094 起四篇)
的配对一连就会 404,计划 B 开工前必须先补这一条。`0010` 的执行状态未核。

这一行会过期,所以它记的是**日期**不是「已完成」:新增 migration 之后要么补一行,
要么直接跑一遍 checks —— 校验脚本不留痕,想知道真库是什么形状,跑它比读这段字准。

`0002` / `0003`(额度钱包)至今没有 check 脚本,那两条的真库形状只有"表在不在"这个
层面被 #76 的暴露面审计核过。

## 跑法(补充 README 开头那句「Studio → SQL editor」)

Studio 是给人用的路径。

> **订正(2026-08-25)**:下面这条 SSH 路径**通向已退役的自托管栈**,不再是真库。
> 留着它是因为那两个容器还在跑、还回得出数据,不写清楚下一个人照抄就会改错库。
> 迁云之后 agent 要动真库,走 `supabase` CLI(`supabase login` + `link` + `db push`)
> 或仓库 `.mcp.json` 里那台指向 `kpeemypbhkynapkjzewr` 的 Supabase MCP;两条都要凭据,
> 不是免密可达的。

~~以下为自托管时代的跑法,已失效~~ —— 服务器 SSH 免密可达,数据库容器是 `otto-db-1`:

```bash
ssh -p 2222 stan@<vps> \
  'docker exec -i otto-db-1 sh -lc '"'"'PGPASSWORD=$POSTGRES_PASSWORD psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -'"'"'' \
  < supabase/migrations/00XX_xxx.sql
```

**什么时候必须换 `-U supabase_admin`**:脚本里出现 `set role supabase_auth_admin`
(注册链路的角色)时。`postgres` 没有切到那个角色的权限,会在
`permission denied to set role "supabase_auth_admin"` 上停住。`0009` 的校验脚本就是这一类。

