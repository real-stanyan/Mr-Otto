-- 好友系统三表 + RLS + Realtime(spec: docs/superpowers/specs/2026-08-18-friend-system-design.md)
-- 在 Supabase SQL editor 手动执行一次。重复执行安全,而且是"形状意义上的安全":
-- 对着一张同名但形状不同的旧表跑,也会把它收敛到本文件声明的形状(issue #62 的教训 ——
-- create table if not exists 见到同名表就整张跳过,列一个都不补,幂等只剩"不报错")。

-- ── profiles:auth.users 的公开投影(邮箱精确搜索找人) ──────────────
-- email 可空 + 部分唯一索引(不是 0001 初版的 unique not null):见 docs/adr/0025。
-- 手机/匿名注册没有邮箱,not null 会让这类注册当场失败,而 '' 只允许存在一行。
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text not null default '',
  avatar_url text not null default '',
  updated_at timestamptz not null default now()
);

-- 旧库收敛:2026-08 之前建的表叫 display_name,且没有 email/updated_at
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_name')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'name')
  then
    alter table public.profiles rename column display_name to name;
  end if;
end $$;

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- 旧表这两列可空,新形状不可空:先填平再钉死(重跑时全是 no-op)
update public.profiles set name = '' where name is null;
update public.profiles set avatar_url = '' where avatar_url is null;
alter table public.profiles alter column name set default '';
alter table public.profiles alter column name set not null;
alter table public.profiles alter column avatar_url set default '';
alter table public.profiles alter column avatar_url set not null;

-- email 的唯一事实源是 auth.users,profiles 只是投影,以 auth.users 为准回填
update public.profiles p set email = u.email, updated_at = now()
from auth.users u
where u.id = p.id and u.email is not null and p.email is distinct from u.email;

-- 唯一,但放过 null(部分索引:多行 null 不冲突)
create unique index if not exists profiles_email_unique
  on public.profiles (email) where email is not null;

alter table public.profiles enable row level security;

-- 意图:任何登录用户可读(支撑邮箱精确搜索);只有本人可改自己的行
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
-- 旧库里同语义的两条早期 policy:permissive policy 是 OR 关系,上面两条更宽,
-- 留着只会让下一班误以为读权限被收窄。删除不改变有效权限
drop policy if exists "own profile read" on public.profiles;
drop policy if exists "own profile write" on public.profiles;

-- 旧库遗留的 on_auth_user_created/handle_new_user 写的是 display_name,
-- 上面改完列名它必炸,而它挂在 auth.users 的 insert 上 = 新用户注册当场失败(#62)。
-- 新触发器接管,旧的必须在同一批次里删掉
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- auth.users → profiles 自动同步(注册/改资料)。security definer:触发器跑在
-- auth schema 的上下文里,普通用户无权直写 profiles 之外的行
create or replace function public.handle_auth_user_upsert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, avatar_url, updated_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'user_name',
             split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', ''),
    now()
  )
  on conflict (id) do update
    set email = excluded.email,
        -- 只在本地还没名字时接受 provider 的名字:profiles_update_self 允许用户
        -- 自己改名,每次 auth.users 更新都覆盖回去等于静默丢用户的数据
        name = case when profiles.name = '' then excluded.name else profiles.name end,
        avatar_url = excluded.avatar_url, updated_at = now();
  return new;
end $$;
drop trigger if exists on_auth_user_upsert on auth.users;
create trigger on_auth_user_upsert
  after insert or update on auth.users
  for each row execute function public.handle_auth_user_upsert();

-- 存量用户回填(触发器只管今后)
insert into public.profiles (id, email, name, avatar_url)
select id, email,
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
-- 被请求方接受 = pending→accepted(只改 status/updated_at,requester/addressee 列级 grant 钉死,防伪造好友对);双方都可删行
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

-- accept 只能改 status/updated_at:RLS with check 看不到旧行,靠列级 grant 钉死
-- requester/addressee 不可被 update 改写(防伪造好友对,解锁 messages insert)
revoke update on public.friendships from authenticated;
grant update (status, updated_at) on public.friendships to authenticated;

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
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships')
  then alter publication supabase_realtime add table public.friendships; end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages')
  then alter publication supabase_realtime add table public.messages; end if;
end $$;
