-- 0036_task_sessions.sql —— 任务会话的云端日志（#1223，spec docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md）。幂等，重跑不炸。
-- 与 0016 / 0021 / 0030 / 0035 同一约定：Supabase SQL editor / Management API 手动执行一次
-- （那个端点只回最后一条语句的结果，逐条发，整份贴进去看不出哪条炸了）。
--
-- 为什么是两张新表而不是复用 workspace_sessions：那张表的 workspace_id 是非空外键、RLS 按在籍判，
-- 而任务会话是**一个人**的东西，没有团队可言（spec §8）。
--
-- 写只走 RPC：客户端表上没有 insert/update 策略，事件表连 delete 都没有——append-only 在 DB 层成立
-- （同本机 sqlite 的 events_no_update/no_delete 触发器）。谁能追加什么由「笔」决定（spec §3.3）：
-- executor 类事件必须握着笔，人话免笔；手机从不握笔，天然只发得出人话；runtime 拿 service key
-- 走 _as 包装，同一条规矩不因为角色绕过（SQL 里不按角色分支放行，只按包装决定 uid 从哪来）。
--
-- 权限走仓库既有习惯（0002 的 ensure_wallet 那一族）：security definer + 内部实现函数对所有角色
-- revoke；authenticated 只拿到 uid 从 auth.uid() 读的包装；service_role 只拿到显式 p_uid 的 _as 包装。
-- 不用 auth.role()（仓库零先例）。
--
-- 错误码：P0010 seq_conflict / P0011 pen_required / P0012 forbidden 或形状非法 / P0013 no_session。
-- 客户端（src/main/supabaseTaskSessionsApi.ts）按 SQLSTATE 认，不按文案。

-- ── 表 ──────────────────────────────────────────────────────────────────────
create table if not exists public.task_sessions (
  id          text primary key,                                  -- s-<14 位>-<8 hex>，与桌面同形（src/shared/sessionId.ts）
  uid         uuid not null references auth.users(id) on delete cascade,
  title       text not null default '',
  title_rank  smallint not null default 0,                       -- 3 renamed > 2 autotitled > 1 首行 > 0 无
  archived    boolean not null default false,
  last_seq    integer not null default -1,                       -- CAS 基准
  pen_holder  text,                                              -- desktop:<deviceId> / cloud / phone:<deviceId>
  pen_until   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists task_sessions_uid_updated_idx on public.task_sessions (uid, updated_at desc);

create table if not exists public.task_session_events (
  session_id  text not null references public.task_sessions(id) on delete cascade,
  seq         integer not null,
  uid         uuid not null,                                     -- 冗余一份，RLS select 不用 join
  ts          bigint not null,
  type        text not null,
  payload     jsonb not null,                                    -- 整条事件原样（含 seq/sessionId/ts/type）
  primary key (session_id, seq)
);

alter table public.task_sessions enable row level security;
alter table public.task_session_events enable row level security;

-- 只读自己的行；删自己的会话（级联抹事件）。**没有 insert/update 策略**：写只走 RPC
drop policy if exists task_sessions_select_own on public.task_sessions;
create policy task_sessions_select_own on public.task_sessions for select to authenticated using (uid = auth.uid());
drop policy if exists task_sessions_delete_own on public.task_sessions;
create policy task_sessions_delete_own on public.task_sessions for delete to authenticated using (uid = auth.uid());
drop policy if exists task_session_events_select_own on public.task_session_events;
create policy task_session_events_select_own on public.task_session_events for select to authenticated using (uid = auth.uid());

-- Realtime 只订 task_sessions 的小行（last_seq / pen 变了再去 select 尾巴，spec §3.1）。
-- UPDATE 事件带过滤要能读到整行：replica identity full
alter table public.task_sessions replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.task_sessions;
exception when duplicate_object then null;
end $$;

-- ── 追加 ────────────────────────────────────────────────────────────────────
create or replace function public._task_append(p_uid uuid, p_session_id text, p_expected_seq integer, p_holder text, p_events jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_row      public.task_sessions%rowtype;
  v_seq      integer;
  v_ev       jsonb;
  v_type     text;
  v_title    text;
  v_rank     smallint;
  v_archived boolean;
begin
  if p_uid is null then raise exception 'forbidden: no uid' using errcode = 'P0012'; end if;
  if p_holder is null or p_holder = '' then raise exception 'forbidden: holder required' using errcode = 'P0012'; end if;
  if p_events is null or jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'bad_request: p_events must be a non-empty array' using errcode = 'P0012';
  end if;
  if jsonb_array_length(p_events) = 0 then
    raise exception 'bad_request: p_events must be a non-empty array' using errcode = 'P0012';
  end if;

  select * into v_row from public.task_sessions where id = p_session_id for update;
  if not found then
    if p_expected_seq <> 0 then raise exception 'no_session' using errcode = 'P0013'; end if;
    if (p_events->0->>'type') is distinct from 'session_created' then
      raise exception 'bad_request: first event must be session_created' using errcode = 'P0012';
    end if;
    -- 建行时顺手把笔发给创建者：这一批里第二条起就是 executor 类（memory_loaded…），
    -- 没有这一手就是「要笔得先有行、有行得先追加」的死结。select ... for update 锁不住一行
    -- 还不存在的行，两条并发的 expected_seq=0 都会走到这里；插入撞 unique_violation 是
    -- 「输了竞态」不是表坏了，翻成 seq_conflict 让客户端走既有重试路径
    begin
      insert into public.task_sessions (id, uid, pen_holder, pen_until)
        values (p_session_id, p_uid, p_holder, now() + make_interval(secs => 30))
        returning * into v_row;
    exception when unique_violation then
      raise exception 'seq_conflict' using errcode = 'P0010';
    end;
  elsif v_row.uid <> p_uid then
    raise exception 'forbidden' using errcode = 'P0012';
  end if;

  if v_row.last_seq + 1 <> p_expected_seq then
    raise exception 'seq_conflict' using errcode = 'P0010';
  end if;

  v_seq := p_expected_seq;
  v_title := v_row.title;
  v_rank := v_row.title_rank;
  v_archived := v_row.archived;

  for v_ev in select value from jsonb_array_elements(p_events) loop
    v_type := v_ev->>'type';
    if v_type is null then raise exception 'bad_request: event without type' using errcode = 'P0012'; end if;
    if (v_ev->>'seq')::integer is distinct from v_seq then raise exception 'seq_conflict' using errcode = 'P0010'; end if;
    if v_type = 'session_created' and v_seq <> 0 then
      raise exception 'bad_request: session_created only at seq 0' using errcode = 'P0012';
    end if;
    if octet_length(v_ev::text) > 2097152 then raise exception 'bad_request: event too large' using errcode = 'P0012'; end if;
    if v_type = 'user_message' and octet_length(coalesce(v_ev->>'content', '')) > 65536 then
      raise exception 'bad_request: user_message too large' using errcode = 'P0012';
    end if;
    -- 免笔类型白名单：与 src/shared/taskSync.ts 的 PEN_VERDICTS（human）逐字一致，
    -- tests/docs/taskSessionsMigration.test.ts 对表
    if v_type not in ('session_created', 'user_message', 'session_renamed', 'session_archived', 'session_unarchived',
                      'session_topic_set', 'model_changed', 'image_model_changed', 'memory_user_edit',
                      'branch_checked_out', 'session_shared', 'share_grant_note') then
      if v_row.pen_holder is distinct from p_holder or v_row.pen_until is null or v_row.pen_until <= now() then
        raise exception 'pen_required' using errcode = 'P0011';
      end if;
    end if;

    insert into public.task_session_events (session_id, seq, uid, ts, type, payload)
      values (p_session_id, v_seq, p_uid, coalesce((v_ev->>'ts')::bigint, 0), v_type, v_ev);

    -- 标题投影：renamed(3) > autotitled(2) > 首行(1)，低档不盖高档（同桌面 store.sessions()）
    if v_type = 'session_renamed' and btrim(coalesce(v_ev->>'title', '')) <> '' then
      v_title := btrim(v_ev->>'title'); v_rank := 3;
    elsif v_type = 'session_autotitled' and v_rank <= 2 and btrim(coalesce(v_ev->>'title', '')) <> '' then
      v_title := btrim(v_ev->>'title'); v_rank := 2;
    elsif v_type = 'session_created' and v_rank = 0 and btrim(coalesce(v_ev->>'title', '')) <> '' then
      v_title := btrim(v_ev->>'title'); v_rank := 1;
    elsif v_type = 'user_message' and v_rank = 0 and (v_ev->>'origin') is null
          and btrim(rtrim(left(split_part(coalesce(v_ev->>'content', ''), E'\n', 1), 80), E'\r')) <> '' then
      v_title := btrim(rtrim(left(split_part(coalesce(v_ev->>'content', ''), E'\n', 1), 80), E'\r')); v_rank := 1;
    end if;
    if v_type = 'session_archived' then v_archived := true;
    elsif v_type = 'session_unarchived' then v_archived := false;
    end if;
    v_seq := v_seq + 1;
  end loop;

  update public.task_sessions
     set last_seq = v_seq - 1, title = v_title, title_rank = v_rank, archived = v_archived, updated_at = now()
   where id = p_session_id;
  return v_seq - 1;
end $$;

create or replace function public.task_append(p_session_id text, p_expected_seq integer, p_holder text, p_events jsonb)
returns integer language sql security definer set search_path = public as
$$ select public._task_append(auth.uid(), p_session_id, p_expected_seq, p_holder, p_events) $$;

create or replace function public.task_append_as(p_uid uuid, p_session_id text, p_expected_seq integer, p_holder text, p_events jsonb)
returns integer language sql security definer set search_path = public as
$$ select public._task_append(p_uid, p_session_id, p_expected_seq, p_holder, p_events) $$;

-- ── 笔 ──────────────────────────────────────────────────────────────────────
create or replace function public._task_pen_acquire(p_uid uuid, p_session_id text, p_holder text, p_ttl_s integer)
returns table (ok boolean, holder text, until timestamptz) language plpgsql security definer set search_path = public as $$
declare
  v_row public.task_sessions%rowtype;
begin
  if p_uid is null then raise exception 'forbidden: no uid' using errcode = 'P0012'; end if;
  if p_holder is null or p_holder = '' then raise exception 'forbidden: holder required' using errcode = 'P0012'; end if;
  select * into v_row from public.task_sessions where id = p_session_id for update;
  if not found then raise exception 'no_session' using errcode = 'P0013'; end if;
  if v_row.uid <> p_uid then raise exception 'forbidden' using errcode = 'P0012'; end if;
  -- 空 / 过期 / 同 holder（= 续期）才拿到
  if v_row.pen_holder is null or v_row.pen_until is null or v_row.pen_until <= now() or v_row.pen_holder = p_holder then
    update public.task_sessions
       set pen_holder = p_holder, pen_until = now() + make_interval(secs => greatest(1, least(p_ttl_s, 300))), updated_at = now()
     where id = p_session_id
     returning pen_holder, pen_until into holder, until;
    ok := true;
    return next;
    return;
  end if;
  ok := false; holder := v_row.pen_holder; until := v_row.pen_until;
  return next;
end $$;

create or replace function public._task_pen_release(p_uid uuid, p_session_id text, p_holder text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_uid is null then raise exception 'forbidden: no uid' using errcode = 'P0012'; end if;
  if p_holder is null or p_holder = '' then raise exception 'forbidden: holder required' using errcode = 'P0012'; end if;
  update public.task_sessions
     set pen_holder = null, pen_until = null, updated_at = now()
   where id = p_session_id and uid = p_uid and pen_holder = p_holder;
  return found;
end $$;

create or replace function public.task_pen_acquire(p_session_id text, p_holder text, p_ttl_s integer)
returns table (ok boolean, holder text, until timestamptz) language sql security definer set search_path = public as
$$ select * from public._task_pen_acquire(auth.uid(), p_session_id, p_holder, p_ttl_s) $$;
create or replace function public.task_pen_acquire_as(p_uid uuid, p_session_id text, p_holder text, p_ttl_s integer)
returns table (ok boolean, holder text, until timestamptz) language sql security definer set search_path = public as
$$ select * from public._task_pen_acquire(p_uid, p_session_id, p_holder, p_ttl_s) $$;
create or replace function public.task_pen_release(p_session_id text, p_holder text)
returns boolean language sql security definer set search_path = public as
$$ select public._task_pen_release(auth.uid(), p_session_id, p_holder) $$;
create or replace function public.task_pen_release_as(p_uid uuid, p_session_id text, p_holder text)
returns boolean language sql security definer set search_path = public as
$$ select public._task_pen_release(p_uid, p_session_id, p_holder) $$;

-- ── 权限（同 0002 的写法）────────────────────────────────────────────────
revoke all on function public._task_append(uuid, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public._task_pen_acquire(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public._task_pen_release(uuid, text, text) from public, anon, authenticated;
revoke all on function public.task_append_as(uuid, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.task_pen_acquire_as(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.task_pen_release_as(uuid, text, text) from public, anon, authenticated;
grant execute on function public.task_append_as(uuid, text, integer, text, jsonb) to service_role;
grant execute on function public.task_pen_acquire_as(uuid, text, text, integer) to service_role;
grant execute on function public.task_pen_release_as(uuid, text, text) to service_role;
revoke all on function public.task_append(text, integer, text, jsonb) from public, anon;
revoke all on function public.task_pen_acquire(text, text, integer) from public, anon;
revoke all on function public.task_pen_release(text, text) from public, anon;
grant execute on function public.task_append(text, integer, text, jsonb) to authenticated;
grant execute on function public.task_pen_acquire(text, text, integer) to authenticated;
grant execute on function public.task_pen_release(text, text) to authenticated;

-- ── 附件：Storage bucket，own-folder 四条（照抄 0014，去掉好友可读那条）──
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

drop policy if exists "task_attachments_insert_own" on storage.objects;
create policy "task_attachments_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'task-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "task_attachments_update_own" on storage.objects;
create policy "task_attachments_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'task-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "task_attachments_select_own" on storage.objects;
create policy "task_attachments_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'task-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "task_attachments_delete_own" on storage.objects;
create policy "task_attachments_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'task-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
