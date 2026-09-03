-- supabase/checks/0017_subscriptions.check.sql
-- 跑完 0017 + seed 后在 SQL editor 执行；每行期望 PASS
select 'plan rows' as check, case when count(*) = 4 then 'PASS' else 'FAIL' end from public.plan;
select 'lite limits' as check, case when window5h_limit_micro = 665000 and week_limit_micro = 3325000 then 'PASS' else 'FAIL' end
  from public.plan where id = 'lite';
select 'routes enabled' as check, case when count(*) >= 3 then 'PASS' else 'FAIL' end from public.model_route where enabled;
select 'usage_event rls' as check, case when relrowsecurity then 'PASS' else 'FAIL' end
  from pg_class where oid = 'public.usage_event'::regclass;
select 'no write policy' as check, case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_policies where schemaname = 'public'
   and tablename in ('plan','subscription','credit_grant','usage_event','model_route')
   and cmd <> 'SELECT';
