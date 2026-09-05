-- 0024_workspace_relay_max_depth.sql —— agent 互相 @ 的棒数上限，工作区可配（#950，spec §8）。幂等。
-- 与 0015 同一约定：Supabase SQL editor 手动执行一次。
-- 默认 6；范围 1–20（runtime 侧 normalizeRelayMaxDepth 同一口径，形状不对回默认）。

alter table public.workspaces
  add column if not exists relay_max_depth integer not null default 6
  check (relay_max_depth between 1 and 20);

-- workspaces 此前没有 update 策略（0015 只有 select/insert/delete）：owner 可改自己的群
-- RLS 不能按列限——这条策略给 owner 整表 UPDATE（with check 只挡住换 owner），今天
-- 唯一的写入路径是 relay_max_depth；要收紧成"只能改这一列"用
-- `grant update (relay_max_depth) on public.workspaces to authenticated`（不在本 migration 做，
-- 那要连 name 等其余字段的写入路径一起理清楚，本 migration 只加这一列 + 让 owner 能存它）
drop policy if exists ws_update_owner on public.workspaces;
create policy ws_update_owner on public.workspaces for update to authenticated
  using (owner_uid = auth.uid())
  with check (owner_uid = auth.uid());
