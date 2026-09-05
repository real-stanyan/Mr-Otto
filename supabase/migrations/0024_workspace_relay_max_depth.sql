-- 0024_workspace_relay_max_depth.sql —— agent 互相 @ 的棒数上限，工作区可配（#950，spec §8）。幂等。
-- 与 0015 同一约定：Supabase SQL editor 手动执行一次。
-- 默认 6；范围 1–20（runtime 侧 normalizeRelayMaxDepth 同一口径，形状不对回默认）。

alter table public.workspaces
  add column if not exists relay_max_depth integer not null default 6
  check (relay_max_depth between 1 and 20);

-- workspaces 此前没有 update 策略（0015 只有 select/insert/delete）：owner 可改自己的群
drop policy if exists ws_update_owner on public.workspaces;
create policy ws_update_owner on public.workspaces for update to authenticated
  using (owner_uid = auth.uid())
  with check (owner_uid = auth.uid());
