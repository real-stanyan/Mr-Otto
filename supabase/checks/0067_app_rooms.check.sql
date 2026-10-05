-- supabase/checks/0067_app_rooms.check.sql —— 跑完迁移后执行，每行都要 PASS（Management API 一次只回最后一条：逐条发）
select case when count(*) = 4 then 'PASS' else 'FAIL: ' || count(*) end as "四张表都在且开了 RLS"
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('app_rooms', 'app_room_members', 'app_room_data', 'app_room_pings') and c.relrowsecurity;

select case when count(*) = 7 then 'PASS' else 'FAIL: ' || count(*) end as "七个 RPC 都是 security definer"
  from pg_proc where proname in ('app_room_create', 'app_room_invite', 'app_room_join', 'app_room_leave', 'app_room_set', 'app_room_remove', 'app_room_ping') and prosecdef;

select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) end as "没有给 authenticated 的写策略"
  from pg_policies where tablename in ('app_rooms', 'app_room_members', 'app_room_data', 'app_room_pings') and cmd <> 'SELECT';

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "app_versions 房间放行策略在"
  from pg_policies where tablename = 'app_versions' and policyname = 'app_versions_select_room';

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "otto-apps 桶房间放行策略在"
  from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'otto_apps_select_room';

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "broadcast 收发两条策略在"
  from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname in ('app_room_broadcast_select', 'app_room_broadcast_insert');

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "app_room_pings 进了 supabase_realtime（runtime 用 service role 订）"
  from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_room_pings';

select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) end as "app_room_data / app_room_members 没进 supabase_realtime（DELETE 事件绕过 RLS）"
  from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('app_room_data', 'app_room_members');

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "data / members 两个通知触发器在，且是 AFTER 行触发器"
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and t.tgname in ('app_room_data_notify', 'app_room_members_notify') and not t.tgisinternal
   and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0;

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "两个触发器函数是 security definer、客户端不能直接调"
  from pg_proc p where p.proname in ('app_room_data_notify', 'app_room_members_notify') and p.prosecdef
   and not has_function_privilege('authenticated', p.oid, 'execute');
