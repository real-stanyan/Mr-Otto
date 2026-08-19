# Supabase migrations

自托管实例:https://otto-auth.stan.damianslife.com(配置见 src/main/authConfig.ts)。

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

`checks/` 下同名 `.check.sql` 是对着真库的一致性校验(整段事务 + rollback,不留痕),
跑法写在每个文件头部。
