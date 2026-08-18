-- 好友系统三表 + RLS + Realtime(spec: docs/superpowers/specs/2026-08-18-friend-system-design.md)
-- 在 Supabase SQL editor 手动执行一次。重复执行安全(if not exists / or replace)。

-- ── profiles:auth.users 的公开投影(邮箱精确搜索找人) ──────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text not null default '',
  avatar_url text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- 意图:任何登录用户可读(支撑邮箱精确搜索);只有本人可改自己的行
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- auth.users → profiles 自动同步(注册/改资料)。security definer:触发器跑在
-- auth schema 的上下文里,普通用户无权直写 profiles 之外的行
create or replace function public.handle_auth_user_upsert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, avatar_url, updated_at)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'user_name',
             split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', ''),
    now()
  )
  on conflict (id) do update
    set email = excluded.email, name = excluded.name,
        avatar_url = excluded.avatar_url, updated_at = now();
  return new;
end $$;
drop trigger if exists on_auth_user_upsert on auth.users;
create trigger on_auth_user_upsert
  after insert or update on auth.users
  for each row execute function public.handle_auth_user_upsert();

-- 存量用户回填(触发器只管今后)
insert into public.profiles (id, email, name, avatar_url)
select id, coalesce(email, ''),
       coalesce(raw_user_meta_data->>'name', raw_user_meta_data->>'user_name',
                split_part(coalesce(email, ''), '@', 1)),
       coalesce(raw_user_meta_data->>'avatar_url', raw_user_meta_data->>'picture', '')
from auth.users
on conflict (id) do nothing;

-- ── friendships:关系链(pending=请求中,accepted=好友;拒绝/删好友=删行) ──
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references public.profiles(id) on delete cascade,
  addressee uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester <> addressee)  -- 不能加自己
);
-- 无序对唯一:A→B 与 B→A 视为同一关系,防双向重复请求
create unique index if not exists friendships_pair_unique
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
alter table public.friendships enable row level security;

-- 意图:仅当事双方可见;发起方只能插 pending 且 requester 必须是自己;
-- 被请求方接受 = pending→accepted(只有这一条 update 路径);双方都可删行
drop policy if exists "friendships_select_parties" on public.friendships;
create policy "friendships_select_parties" on public.friendships
  for select to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);
drop policy if exists "friendships_insert_requester" on public.friendships;
create policy "friendships_insert_requester" on public.friendships
  for insert to authenticated
  with check (auth.uid() = requester and status = 'pending');
drop policy if exists "friendships_accept_addressee" on public.friendships;
create policy "friendships_accept_addressee" on public.friendships
  for update to authenticated
  using (auth.uid() = addressee and status = 'pending')
  with check (status = 'accepted');
drop policy if exists "friendships_delete_parties" on public.friendships;
create policy "friendships_delete_parties" on public.friendships
  for delete to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

-- ── messages:好友间一对一 DM ──────────────────────────────────────
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  sender uuid not null references public.profiles(id) on delete cascade,
  recipient uuid not null references public.profiles(id) on delete cascade,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
alter table public.messages enable row level security;

-- 意图:仅收发双方可读;只能以自己名义发,且必须已是 accepted 好友
drop policy if exists "messages_select_parties" on public.messages;
create policy "messages_select_parties" on public.messages
  for select to authenticated
  using (auth.uid() = sender or auth.uid() = recipient);
drop policy if exists "messages_insert_accepted_friend" on public.messages;
create policy "messages_insert_accepted_friend" on public.messages
  for insert to authenticated
  with check (
    auth.uid() = sender
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and least(f.requester, f.addressee) = least(sender, recipient)
        and greatest(f.requester, f.addressee) = greatest(sender, recipient)
    )
  );

-- Realtime:两张表进 publication,postgres_changes 才有得推(RLS 照常生效)
alter publication supabase_realtime add table public.friendships;
alter publication supabase_realtime add table public.messages;
