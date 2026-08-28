-- 好友间会话 fork 的分享记录表（docs/adr/0147）。
-- 在 Supabase SQL editor 手动执行一次。重复执行安全。
--
-- payload 是一整份「投影所需最小事件集」的 JSON（SessionSharePayload 形状，
-- src/shared/sessionShare.ts），走 jsonb 列而不是拆表：会话分享是「一次性快照」，
-- 收到即读、读完即用，不需要按事件查询——拆成行只会让 RLS 和 Realtime 复杂十倍，
-- 换不来任何查询能力。体积上限由客户端在写入前把守（MAX_SHARE_PAYLOAD_BYTES ≈ 1MB，
-- 超限拒绝分享），不在库里设约束——库里设约束报的是 22P02，客户端把守报的是
-- 人能看懂的话。

create table if not exists public.session_shares (
  id uuid primary key default gen_random_uuid(),
  sender uuid not null references auth.users(id) on delete cascade,
  recipient uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  message text not null default '',
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  check (sender <> recipient)
);
alter table public.session_shares enable row level security;

-- 意图：仅当事双方可见；只能以自己名义发 pending；接收方把 pending 改成
-- accepted/declined。status 的列级 grant 钉死（同 0001 friendships 的手法）：
-- 发起方不能把自己的 pending 改成 accepted 绕过接收方。
drop policy if exists "session_shares_select_parties" on public.session_shares;
create policy "session_shares_select_parties" on public.session_shares
  for select to authenticated
  using (auth.uid() = sender or auth.uid() = recipient);

drop policy if exists "session_shares_insert_sender" on public.session_shares;
create policy "session_shares_insert_sender" on public.session_shares
  for insert to authenticated
  with check (auth.uid() = sender and status = 'pending');

drop policy if exists "session_shares_accept_recipient" on public.session_shares;
create policy "session_shares_accept_recipient" on public.session_shares
  for update to authenticated
  using (auth.uid() = recipient and status = 'pending')
  with check (status in ('accepted', 'declined'));

-- 列级 grant：sender/recipient/payload/title/message/created_at 都不可被 update 改写，
-- 只能动 status（接收方接受/拒绝）。revoke update 再逐列 grant，同 0001 先例
revoke update on public.session_shares from authenticated;
grant update (status) on public.session_shares to authenticated;

-- Realtime：接收方靠 postgres_changes 的 INSERT 推送收到分享通知（RLS 照常生效，
-- 只有 recipient 自己订得到发给他的行）
do $$
begin
  begin
    alter publication supabase_realtime add table public.session_shares;
  exception when duplicate_object then null;
  end;
end $$;
