-- 0039_task_append_pen_busy.sql —— 笔活着时，这条会话只有一个写者（#1258，ADR-0310）。
-- 幂等（整段是 create or replace），重跑不炸。
--
-- 病：0036 的免笔白名单**完全不看笔**，于是「设备 Y 正跑着 turn、设备 X 落一条人话」这件事
-- 会在云端插进 Y 那一轮的中间。Y 接着推它本地那条同号的 executor 事件 → seq_conflict →
-- 收口后对账：分歧处本地尾巴含 turn 痕迹 → `has_executor` → **Y 刚跑完的那一轮被整段流放**
-- 进「（本机未同步的分支）」，主会话换成云端那份（X 的话、没人答），随后再被答一遍。
--
-- 药：人的动作也要看笔——笔活着且在别人手上时回 `pen_busy`（P0014），客户端留着待会儿再推。
-- 这不是把 X 的话丢掉：笔一放（或 30 s 过期）它就正常落在那一轮**之后**，而那正是它该在的
-- 位置——那一轮没看见它，`lastUnanswered` 于是找得到它、下一轮来答。等于 ADR-0247
-- 「turn 跑着时回车 = 排队」的跨设备版。
--
-- **上线顺序：先发客户端，再跑这一条**（与 0038 相反，理由也相反）。老客户端不认识 P0014，
-- 它会落进 codeOf 的 default → `other` → 30 s 重试循环，最终笔放了照样推上去；
-- 但那期间账号页会写一句莫名其妙的失败。反过来（先跑 migration）没有任何好处。
--
-- 只改 `_task_append` 一个函数，签名一字不动 —— 两个包装（task_append / task_append_as）
-- 与全部 grant/revoke 都还指着同一个函数，不用重建。

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
    elsif v_type <> 'session_created'
          and v_row.pen_holder is not null and v_row.pen_holder is distinct from p_holder
          and v_row.pen_until is not null and v_row.pen_until > now() then
      -- 笔活着且在别人手上 = 他正在跑一轮：这条人的动作**现在**落不进去（#1258，ADR-0310）。
      -- 客户端留着待会儿再推；笔一放（或 30 s 过期）它就正常追加到那一轮**之后**。
      -- session_created 例外：建行那一刻行和笔都还不存在，拦它等于建不出任务会话。
      raise exception 'pen_busy' using errcode = 'P0014';
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
