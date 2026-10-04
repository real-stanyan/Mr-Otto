-- 0056 共享车道（#1523，#1461 P2）：好友私聊里带进来的智能体能在「仅我可见 / 公开给 TA」之间切。
-- 一个人对一位朋友**只有一条**车道、朝向可切（修订 ADR-0346 决定 1）：手机同一时刻只连得上一条云会话，
-- 「私密 + 共享各一条、两人各带」一页要连 3～4 条，做不了；维护者的原话也是一个开关（「可以选择是否公开或者是仅我可见」）。
-- 公开 = 朋友以 0043 那套「客人」的身份进同一条车道（chat_roster_changed.humans 里有他 → workspace_session_members 一行），
-- 他读那一行、读那几只智能体的名字都走 0043 现成的策略与 RPC（wss_select_guest / guest_chat_agents）——这份**不加任何策略、不加 RPC**。
-- 幂等，重跑不炸。Supabase SQL editor / Management API 手动执行一次（逐条发）。
-- **部署顺序：先跑这份、再部署 runtime（协议 25）、再发手机包**——反过来 runtime 切朝向时旧索引 (workspace_id, peer_uid, facing)
-- 仍在，倒不会炸（同一行改 facing 不撞自己），但老 runtime 的 findPairSession 按朝向找、会建出第二条。**还没有在生产执行**。

-- ① 唯一索引：从 (主场, 朋友, 朝向) 收成 (主场, 朋友)。先建新的再删旧的：中间任何一刻都至少有一条索引在
create unique index if not exists ws_sessions_one_pair_per_peer_v2
  on public.workspace_sessions (workspace_id, peer_uid)
  where chat_kind = 'pair';
drop index if exists public.ws_sessions_one_pair_per_peer;

-- ② 存量：若某一对已经有两条（self + both 各一条——0053 允许过），v2 索引建不起来。生产上 P1 只建过 self，不会有；
-- 真撞上时这份 migration 在 ① 就停下，由人决定留哪条，不在这里自动删会话（会话里有日志）。

-- ③ facing 那一列仍在（CHECK self / both 不变，0053）：runtime 在切朝向时跟着写，是投影；事实在日志里的客人名单。
-- pair_presence（0053）仍只数 facing = 'self' 的车道：公开的那条朋友自己看得到、不需要「在场提示」。
