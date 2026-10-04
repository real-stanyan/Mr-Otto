-- 0054 的验收：跑完迁移后执行，每行都要 PASS。

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "两列都在、默认 agents"
  from information_schema.columns
 where table_schema = 'public' and table_name = 'friendships'
   and column_name in ('requester_tier', 'addressee_tier') and column_default like '%agents%';

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "两条 check 约束都在"
  from pg_constraint where conname in ('friendships_requester_tier_check', 'friendships_addressee_tier_check');

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "insert 策略钉住对方那一边是默认值"
  from pg_policies where tablename = 'friendships' and policyname = 'friendships_insert_requester'
   and with_check like '%addressee_tier = ''agents''%';

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "已接受双方可改档位的策略在"
  from pg_policies where tablename = 'friendships' and policyname = 'friendships_tier_parties';

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "只改自己那一边的触发器在"
  from pg_trigger where tgname = 'friendships_guard_tiers' and not tgisinternal;

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "两列的 update 列级 grant 都给了 authenticated"
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'friendships' and grantee = 'authenticated'
   and privilege_type = 'UPDATE' and column_name in ('requester_tier', 'addressee_tier');

select case when prosrc like '%requester_tier <> ''chat''%' then 'PASS' else 'FAIL' end as "pair_presence 按档位走"
  from pg_proc where proname = 'pair_presence';
