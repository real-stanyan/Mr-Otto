-- 好友分支在场:心跳那条腿顺便带上"我在哪个仓库、哪个分支"(issue #167,ADR-0055)
-- 在 Supabase SQL editor 手动执行一次。重复执行安全。
--
-- 为什么放 profiles 而不是新表:它和 last_seen_at 是同一拍写的、同一个窗口判活的,
-- 是"心跳"的两个附加字段,不是独立实体。Realtime presence 的 track meta 是另一条腿
-- (同 0006 的两腿理由:线上 /realtime/v1 经 Kong 返 503,issue #77)。
--
-- repo_key 存的是规范化 remote URL 的 sha256 前 16 位,不是地址本身:好友之间只能
-- 比对"同不同一个仓库",拿不到私有仓库地址。repo_branch 是本地短名,detached 为 null。
-- 两列都可空:不在仓库里的会话写 null。

alter table public.profiles add column if not exists repo_key text;
alter table public.profiles add column if not exists repo_branch text;
-- 写权限沿用 0001 的 profiles_update_self,读权限沿用 listLastSeen 已在用的 select policy,
-- 不需要新 policy
