-- supabase/checks/0067_app_rooms.behavior.sql —— 扮人跑一遍房间的规矩。**整笔回滚**：结尾故意 raise，结果在报错文本里。
-- 跑前把 :B / :C 两个占位换成真 uuid（select id from auth.users where id::text like '32c6716a%' / '009d3d63%' 现查）；
-- A/B 是好友、C 不是 A 的好友、APP 是 A 名下 current_version ≥ 1 的应用。
do $$
declare
  a uuid := '2819d0bb-933b-499d-be44-2bb51b5a8391';
  b uuid := ':B';
  c uuid := ':C';
  app uuid := '0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b';
  r uuid; res jsonb; n int; ok boolean;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  r := public.app_room_create(app, '测试局');
  perform public.app_room_invite(r, b);
  begin perform public.app_room_invite(r, c); raise exception 'FAIL: 非好友邀得进'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  res := public.app_room_set(r, 'board', '{"x":1}'::jsonb, 0);
  if (res->>'ok')::boolean is not true or (res->>'rev')::int <> 1 then raise exception 'FAIL: 首写 %', res; end if;

  -- B 被邀未加入：读不到数据、写不进
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.app_room_data where room_id = r;
  if n <> 0 then raise exception 'FAIL: 未加入读得到数据'; end if;
  begin perform public.app_room_set(r, 'board', '{"x":2}'::jsonb); raise exception 'FAIL: 未加入写得进'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform public.app_room_join(r);
  select count(*) into n from public.app_room_data where room_id = r;
  if n <> 1 then raise exception 'FAIL: 加入后读不到数据'; end if;
  select count(*) into n from public.app_versions v join public.app_rooms x on x.host_app_id = v.app_id and x.host_version = v.version where x.id = r;
  if n <> 1 then raise exception 'FAIL: 成员读不到房主那一版'; end if;
  -- if_rev 冲突回现值
  res := public.app_room_set(r, 'board', '{"x":3}'::jsonb, 5);
  if (res->>'ok')::boolean is not false or (res->>'rev')::int <> 1 or res->'value' <> '{"x":1}'::jsonb then raise exception 'FAIL: if_rev 冲突 %', res; end if;
  res := public.app_room_set(r, 'board', '{"x":3}'::jsonb, 1);
  if (res->>'rev')::int <> 2 then raise exception 'FAIL: if_rev 命中 %', res; end if;
  -- ping 限速
  ok := public.app_room_ping(r, '轮到你了');
  if not ok then raise exception 'FAIL: 第一条 ping'; end if;
  ok := public.app_room_ping(r, '再叫一次');
  if ok then raise exception 'FAIL: 10 秒内第二条 ping 没被限'; end if;
  -- broadcast 判据
  if not public.room_topic_member('room:' || r, b) then raise exception 'FAIL: 成员进不了频道'; end if;
  if public.room_topic_member('room:' || r, c) then raise exception 'FAIL: 非成员进得了频道'; end if;
  if public.room_topic_member('room:nope', b) then raise exception 'FAIL: 坏频道名'; end if;

  -- C：什么都读不到
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  select count(*) into n from public.app_rooms where id = r;
  if n <> 0 then raise exception 'FAIL: 外人看得到房间'; end if;
  select count(*) into n from public.app_room_pings;
  if n <> 0 then raise exception 'FAIL: 客户端读得到 pings'; end if;

  -- 房主离开 = 关房；关了只读
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.app_room_leave(r);
  begin perform public.app_room_set(r, 'board', '{"x":9}'::jsonb); raise exception 'FAIL: 关房后写得进'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  select count(*) into n from public.app_room_data where room_id = r;
  if n <> 1 then raise exception 'FAIL: 关房后读不到'; end if;

  raise exception 'ALL PASS（整笔回滚）';
end $$;
