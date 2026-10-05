-- 0067 Otto 应用的房间（#1675，spec docs/superpowers/specs/2026-10-05-otto-app-rooms-design.md §3）
-- 一局 / 一本共享的账 = 一间房：成员共读写的键值（app_room_data）+ 成员间即时消息（Realtime broadcast，只在 realtime.messages 里留保留期，不进我们的表）。
-- 写只走下面的 RPC（比较后再写、人数上限、好友判据、限速都要在一个事务里判）；表对 authenticated 只开 select。

create table if not exists public.app_rooms (
  id            uuid primary key default gen_random_uuid(),
  host_uid      uuid not null references auth.users(id) on delete cascade,
  host_app_id   uuid not null references public.apps(id) on delete cascade,
  host_version  int  not null check (host_version >= 1),
  family_id     uuid not null,
  title         text not null check (char_length(title) between 1 and 40),
  closed        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists app_rooms_family on public.app_rooms (family_id);
create index if not exists app_rooms_host on public.app_rooms (host_uid);
create index if not exists app_rooms_host_app_version on public.app_rooms (host_app_id, host_version);

create table if not exists public.app_room_members (
  room_id     uuid not null references public.app_rooms(id) on delete cascade,
  uid         uuid not null references auth.users(id) on delete cascade,
  status      text not null check (status in ('invited', 'joined', 'left')),
  invited_by  uuid references auth.users(id) on delete set null,
  joined_at   timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (room_id, uid)
);
create index if not exists app_room_members_uid on public.app_room_members (uid);

create table if not exists public.app_room_data (
  room_id     uuid not null references public.app_rooms(id) on delete cascade,
  key         text not null check (char_length(key) between 1 and 200),
  value       jsonb not null,
  rev         bigint not null default 1,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (room_id, key)
);

create table if not exists public.app_room_pings (
  id          bigserial primary key,
  room_id     uuid not null references public.app_rooms(id) on delete cascade,
  from_uid    uuid not null references auth.users(id) on delete cascade,
  text        text not null check (char_length(text) between 1 and 80),
  created_at  timestamptz not null default now()
);
create index if not exists app_room_pings_rate on public.app_room_pings (room_id, from_uid, created_at desc);

alter table public.app_rooms enable row level security;
alter table public.app_room_members enable row level security;
alter table public.app_room_data enable row level security;
alter table public.app_room_pings enable row level security;

-- 成员判据只有这一处（joined 才算；关了的房间照样能读，写由 RPC 拦）。只问「我」（auth.uid()）：不带 uid 参数，登录用户没法拿它探别人在不在哪间房
create or replace function public.is_room_member(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_room_members m where m.room_id = p_room and m.uid = auth.uid() and m.status = 'joined');
$$;
revoke all on function public.is_room_member(uuid) from public, anon;
grant execute on function public.is_room_member(uuid) to authenticated;

-- broadcast 两种频道：
--   room:<uuid>      成员互发的即时消息（应用自己的 msg）——joined 成员读、写（「成员 + 没关房」在加入频道时判一次，不逐条判：
--                    已经 join 的人在关房 / 退房后仍能发，直到重新 join，见 ADR-0375 §8）；
--   room-sys:<uuid>  触发器发的系统事件（change / members / closed）——成员只能读，客户端写不了，所以伪造不了。
-- 名字不合形状回 false（不让 ::uuid 的转换报错把策略炸掉）。只问当前登录的人，不带 uid 参数。
create or replace function public.room_topic_readable(p_topic text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if p_topic is null or p_topic !~ '^(room|room-sys):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return false; end if;
  return public.is_room_member(substring(p_topic from position(':' in p_topic) + 1)::uuid);
end $$;
revoke all on function public.room_topic_readable(text) from public, anon;
grant execute on function public.room_topic_readable(text) to authenticated;

create or replace function public.room_topic_writable(p_topic text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_room uuid;
begin
  if p_topic is null or p_topic !~ '^room:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return false; end if;
  v_room := substring(p_topic from 6)::uuid;
  if not public.is_room_member(v_room) then return false; end if;
  return not exists (select 1 from public.app_rooms where id = v_room and closed);
end $$;
revoke all on function public.room_topic_writable(text) from public, anon;
grant execute on function public.room_topic_writable(text) to authenticated;

-- 读：房主 / 被邀的 / 成员看得到房间与名单；数据只有 joined 成员看得到；pings 客户端不读（runtime 用 service role）
drop policy if exists app_rooms_select on public.app_rooms;
create policy app_rooms_select on public.app_rooms for select to authenticated using (
  host_uid = auth.uid()
  or exists (select 1 from public.app_room_members m where m.room_id = app_rooms.id and m.uid = auth.uid() and m.status in ('invited', 'joined'))
);
drop policy if exists app_room_members_select on public.app_room_members;
create policy app_room_members_select on public.app_room_members for select to authenticated using (
  uid = auth.uid() or public.is_room_member(room_id)
);
drop policy if exists app_room_data_select on public.app_room_data;
create policy app_room_data_select on public.app_room_data for select to authenticated using (public.is_room_member(room_id));

-- 建一间：应用是自己的、打过第一版；钉住当前版本；family = 源（副本取 share: 后面那个 id）
create or replace function public.app_room_create(p_app uuid, p_title text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_app public.apps%rowtype;
  v_family uuid;
  v_id uuid;
begin
  if v_uid is null then raise exception '还没登录'; end if;
  select * into v_app from public.apps where id = p_app and owner_uid = v_uid;
  if not found then raise exception '这个应用不是你的'; end if;
  if v_app.current_version < 1 then raise exception '这个应用还没有打出第一版'; end if;
  if (select count(*) from public.app_rooms where host_uid = v_uid and not closed) >= 50 then
    raise exception '开着的房间最多 50 个，先关掉几个';
  end if;
  v_family := case when v_app.created_by_agent ~ '^share:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then substring(v_app.created_by_agent from 7)::uuid else v_app.id end;
  insert into public.app_rooms (host_uid, host_app_id, host_version, family_id, title)
    values (v_uid, v_app.id, v_app.current_version, v_family, left(coalesce(nullif(btrim(p_title), ''), '一局'), 40))
    returning id into v_id;
  insert into public.app_room_members (room_id, uid, status, invited_by, joined_at) values (v_id, v_uid, 'joined', v_uid, now());
  return v_id;
end $$;

-- 邀请：只有房主；对方是 accepted 好友；人数（invited + joined）≤ 8；已在就幂等
create or replace function public.app_room_invite(p_room uuid, p_uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_room public.app_rooms%rowtype;
begin
  if v_uid is null then raise exception '还没登录'; end if;
  -- 锁房间行再数人头：两个并发邀请不会同时看到 7 人、一起塞成 9 人
  select * into v_room from public.app_rooms where id = p_room for update;
  if not found or v_room.host_uid <> v_uid then raise exception '只有房主能邀请'; end if;
  if v_room.closed then raise exception '这一局已经结束了'; end if;
  if p_uid = v_uid then return; end if;
  if not exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and least(f.requester, f.addressee) = least(v_uid, p_uid)
       and greatest(f.requester, f.addressee) = greatest(v_uid, p_uid)
  ) then raise exception '只能邀请好友'; end if;
  if exists (select 1 from public.app_room_members where room_id = p_room and uid = p_uid and status in ('invited', 'joined')) then return; end if;
  if (select count(*) from public.app_room_members where room_id = p_room and status in ('invited', 'joined')) >= 8 then
    raise exception '一间最多 8 个人';
  end if;
  insert into public.app_room_members (room_id, uid, status, invited_by) values (p_room, p_uid, 'invited', v_uid)
    on conflict (room_id, uid) do update set status = 'invited', invited_by = v_uid, updated_at = now();
end $$;

create or replace function public.app_room_join(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if exists (select 1 from public.app_rooms where id = p_room and closed) then raise exception '这一局已经结束了'; end if;
  update public.app_room_members set status = 'joined', joined_at = coalesce(joined_at, now()), updated_at = now()
   where room_id = p_room and uid = v_uid and status in ('invited', 'joined');
  if not found then raise exception '你没被邀请进这一局'; end if;
end $$;

-- 离开：房主离开 = 关房（数据留着只读）
create or replace function public.app_room_leave(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if exists (select 1 from public.app_rooms where id = p_room and host_uid = v_uid) then
    update public.app_rooms set closed = true, updated_at = now() where id = p_room;
    return;
  end if;
  update public.app_room_members set status = 'left', updated_at = now() where room_id = p_room and uid = v_uid;
end $$;

-- 写一个键。p_if_rev：null = 直接写；0 = 只在还没有这个键时写；n = 只在现在是第 n 版时写。对不上不抛，回现值
create or replace function public.app_room_set(p_room uuid, p_key text, p_value jsonb, p_if_rev bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_rev bigint;
  v_cur jsonb;
  v_cur_rev bigint;
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if not public.is_room_member(p_room) then raise exception '你不在这一局里'; end if;
  -- 锁房间行再判关房与 500 键上限：并发的新键写入不会一起越过上限
  perform 1 from public.app_rooms where id = p_room for update;
  if exists (select 1 from public.app_rooms where id = p_room and closed) then raise exception '这一局已经结束了，只能看'; end if;
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 200 then raise exception 'key 要是 1–200 字'; end if;
  if p_value is null then raise exception 'value 不能是空（要删用 remove）'; end if;
  if pg_column_size(p_value) > 65536 then raise exception '这个值太大（单个最多 64 KB）'; end if;
  if not exists (select 1 from public.app_room_data where room_id = p_room and key = p_key)
     and (select count(*) from public.app_room_data where room_id = p_room) >= 500 then
    raise exception '这一局的键太多了（最多 500 个）';
  end if;
  if p_if_rev is null then
    insert into public.app_room_data (room_id, key, value, rev, updated_by) values (p_room, p_key, p_value, 1, v_uid)
      on conflict (room_id, key) do update set value = excluded.value, rev = public.app_room_data.rev + 1, updated_by = v_uid, updated_at = now()
      returning rev into v_rev;
  elsif p_if_rev = 0 then
    insert into public.app_room_data (room_id, key, value, rev, updated_by) values (p_room, p_key, p_value, 1, v_uid)
      on conflict (room_id, key) do nothing
      returning rev into v_rev;
  else
    update public.app_room_data set value = p_value, rev = rev + 1, updated_by = v_uid, updated_at = now()
     where room_id = p_room and key = p_key and rev = p_if_rev
     returning rev into v_rev;
  end if;
  if v_rev is null then
    select value, rev into v_cur, v_cur_rev from public.app_room_data where room_id = p_room and key = p_key;
    return jsonb_build_object('ok', false, 'rev', coalesce(v_cur_rev, 0), 'value', v_cur);
  end if;
  update public.app_rooms set updated_at = now() where id = p_room;
  return jsonb_build_object('ok', true, 'rev', v_rev);
end $$;

create or replace function public.app_room_remove(p_room uuid, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if not public.is_room_member(p_room) then raise exception '你不在这一局里'; end if;
  -- 同 app_room_set：锁房间行再判关房（不和关房 / 别的写交错），删完顶房间的 updated_at（rooms() 按它排序）
  perform 1 from public.app_rooms where id = p_room for update;
  if exists (select 1 from public.app_rooms where id = p_room and closed) then raise exception '这一局已经结束了，只能看'; end if;
  delete from public.app_room_data where room_id = p_room and key = p_key;
  update public.app_rooms set updated_at = now() where id = p_room;
end $$;

-- 叫人：成员、没关房；同人同房 10 秒一条、每小时 60 条——超了回 false（提醒丢一条不该让游戏报错）
create or replace function public.app_room_ping(p_room uuid, p_text text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_text text := left(btrim(coalesce(p_text, '')), 80);
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if not public.is_room_member(p_room) then raise exception '你不在这一局里'; end if;
  -- 锁房间行再查限速：同一人的并发 ping 排队，不会都看到「10 秒内没有」而一起放行
  perform 1 from public.app_rooms where id = p_room for update;
  if exists (select 1 from public.app_rooms where id = p_room and closed) then return false; end if;
  if v_text = '' then raise exception '要说点什么'; end if;
  if exists (select 1 from public.app_room_pings where room_id = p_room and from_uid = v_uid and created_at > now() - interval '10 seconds') then return false; end if;
  if (select count(*) from public.app_room_pings where room_id = p_room and from_uid = v_uid and created_at > now() - interval '1 hour') >= 60 then return false; end if;
  insert into public.app_room_pings (room_id, from_uid, text) values (p_room, v_uid, v_text);
  return true;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'app_room_create(uuid, text)', 'app_room_invite(uuid, uuid)', 'app_room_join(uuid)', 'app_room_leave(uuid)',
    'app_room_set(uuid, text, jsonb, bigint)', 'app_room_remove(uuid, text)', 'app_room_ping(uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
  end loop;
end $$;
grant execute on function public.app_room_create(uuid, text) to authenticated;
grant execute on function public.app_room_invite(uuid, uuid) to authenticated;
grant execute on function public.app_room_join(uuid) to authenticated;
grant execute on function public.app_room_leave(uuid) to authenticated;
grant execute on function public.app_room_set(uuid, text, jsonb, bigint) to authenticated;
grant execute on function public.app_room_remove(uuid, text) to authenticated;
grant execute on function public.app_room_ping(uuid, text) to authenticated;

-- 跑房主那一版：成员能读房主钉住的那一版清单与文件（别的版本、别的应用仍读不到）
drop policy if exists app_versions_select_room on public.app_versions;
create policy app_versions_select_room on public.app_versions for select to authenticated using (
  exists (select 1 from public.app_rooms r
           where r.host_app_id = app_versions.app_id and r.host_version = app_versions.version
             and public.is_room_member(r.id))
);
drop policy if exists "otto_apps_select_room" on storage.objects;
create policy "otto_apps_select_room" on storage.objects for select to authenticated using (
  bucket_id = 'otto-apps' and exists (
    select 1 from public.app_rooms r
     where (storage.foldername(name))[1] = r.host_uid::text
       and (storage.foldername(name))[2] = r.host_app_id::text
       and (storage.foldername(name))[3] = r.host_version::text
       and public.is_room_member(r.id)
  )
);

-- 即时消息：私有 broadcast——room:<id> joined 成员收发（「没关房」在加入频道时判一次，不逐条判，见 ADR-0375 §8）；room-sys:<id> 成员只收（系统事件只有触发器能发）
drop policy if exists "app_room_broadcast_select" on realtime.messages;
create policy "app_room_broadcast_select" on realtime.messages for select to authenticated using (
  realtime.messages.extension = 'broadcast' and public.room_topic_readable(realtime.topic())
);
drop policy if exists "app_room_broadcast_insert" on realtime.messages;
create policy "app_room_broadcast_insert" on realtime.messages for insert to authenticated with check (
  realtime.messages.extension = 'broadcast' and public.room_topic_writable(realtime.topic())
);

-- 变更推送：app_room_data / app_room_members 不进 supabase_realtime publication——
-- postgres_changes 的 DELETE 事件不过 RLS，任何登录用户订阅这两张表都会收到别人房间的 (room_id, key) / (room_id, uid)。
-- 改成行触发器调 realtime.send 往私有 broadcast 频道 room-sys:<id> 发（不是成员能写的 room:<id>：成员伪造不了 change / members / closed）：投递由上面 realtime.messages 的 select 策略把关，只有 joined 成员收得到。
-- 只有 app_room_pings 留在 publication（runtime 用 service role 订，客户端没有它的 select 策略，也就收不到）。
create or replace function public.app_room_data_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if tg_op = 'DELETE' then
      perform realtime.send(
        jsonb_build_object('key', old.key, 'removed', true),
        'change', 'room-sys:' || old.room_id, true
      );
    else
      perform realtime.send(
        jsonb_build_object('key', new.key, 'value', new.value, 'rev', new.rev, 'by', new.updated_by),
        'change', 'room-sys:' || new.room_id, true
      );
    end if;
  exception when others then
    null; -- 通知没发出去不能把这次写入（或整局的清理）一起回滚；应用回前台时会重读一遍对齐
  end;
  return null;
end $$;
revoke all on function public.app_room_data_notify() from public, anon, authenticated;
drop trigger if exists app_room_data_notify on public.app_room_data;
create trigger app_room_data_notify
  after insert or update or delete on public.app_room_data
  for each row execute function public.app_room_data_notify();

create or replace function public.app_room_members_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_room uuid;
  v_uid uuid;
  v_status text;
begin
  if tg_op = 'DELETE' then
    v_room := old.room_id; v_uid := old.uid; v_status := null;
  else
    v_room := new.room_id; v_uid := new.uid; v_status := new.status;
  end if;
  begin
    perform realtime.send(
      jsonb_build_object('uid', v_uid, 'status', v_status),
      'members', 'room-sys:' || v_room, true
    );
  exception when others then
    null; -- 同上：名单变动的通知丢了，不能回滚邀请 / 加入 / 离开本身
  end;
  return null;
end $$;
revoke all on function public.app_room_members_notify() from public, anon, authenticated;
drop trigger if exists app_room_members_notify on public.app_room_members;
create trigger app_room_members_notify
  after insert or update or delete on public.app_room_members
  for each row execute function public.app_room_members_notify();

-- 关房：通知成员（room-sys 上只有触发器能发，所以「关了」这件事伪造不了）
create or replace function public.app_room_closed_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.closed is distinct from true and new.closed then
    begin
      perform realtime.send(
        jsonb_build_object('closed', true),
        'closed',
        'room-sys:' || new.id,
        true
      );
    exception when others then
      null; -- 同上：通知丢了不能让关房本身回滚
    end;
  end if;
  return null;
end $$;
revoke all on function public.app_room_closed_notify() from public, anon, authenticated;
drop trigger if exists app_room_closed_notify on public.app_rooms;
-- 只在 closed 这一列被更新、且从没关变成关时触发（set / remove 顶 updated_at 不再白跑一趟）；函数里的判断留着兜底
create trigger app_room_closed_notify
  after update of closed on public.app_rooms
  for each row
  when (old.closed is distinct from true and new.closed)
  execute function public.app_room_closed_notify();

do $$
declare t text;
begin
  foreach t in array array['app_room_pings'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
