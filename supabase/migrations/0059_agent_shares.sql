-- 0059 共有的智能体（#1545）：两个人同时拥有同一只（名片接受出来的那只）时，双方都要看得出「共有」。
-- 名片（ADR-0354）是**复制**定义：接受方主场里是一只新 id 的；分享方读不了接受方的 workspace_agents，反过来也一样，
-- 所以「谁和谁共有哪只」要有一张两边都读得到的小表，由**接受方**在接受那一刻写一行。
-- 幂等，重跑不炸。Supabase SQL editor / Management API 手动执行一次（逐条发）。没跑时：接受照常、只是写不进这张表（手机当没有共有）。

create table if not exists public.agent_shares (
  -- 分享方：原来那只住在谁的主场、原 id
  owner_uid     uuid not null references auth.users(id) on delete cascade,
  agent_id      text not null,
  -- 接受方：复制出来的那只住在谁那儿、新 id
  with_uid      uuid not null references auth.users(id) on delete cascade,
  copy_agent_id text not null,
  -- 名字快照（两边各自改名不同步，但「共有」那一行要说得出当初是哪只）
  name          text not null default '',
  created_at    timestamptz not null default now(),
  primary key (owner_uid, agent_id, with_uid)
);
create index if not exists agent_shares_with_idx on public.agent_shares (with_uid);

alter table public.agent_shares enable row level security;

-- 读：两边都读得到自己参与的那几行
drop policy if exists agent_shares_select_parties on public.agent_shares;
create policy agent_shares_select_parties on public.agent_shares for select to authenticated
  using (auth.uid() = owner_uid or auth.uid() = with_uid);

-- 写：只有接受方写、只能以自己为 with_uid、且两人是已接受的好友（名片只在好友私聊里发得出来）
drop policy if exists agent_shares_insert_with on public.agent_shares;
create policy agent_shares_insert_with on public.agent_shares for insert to authenticated
  with check (
    auth.uid() = with_uid
    and auth.uid() <> owner_uid
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and least(f.requester, f.addressee) = least(owner_uid, with_uid)
        and greatest(f.requester, f.addressee) = greatest(owner_uid, with_uid)
    )
  );

-- 删：接受方删掉复制出来的那只时顺手删这一行（删了才算不再共有）；分享方不删——他删的是自己那只，对方手里的还在
drop policy if exists agent_shares_delete_with on public.agent_shares;
create policy agent_shares_delete_with on public.agent_shares for delete to authenticated
  using (auth.uid() = with_uid);
