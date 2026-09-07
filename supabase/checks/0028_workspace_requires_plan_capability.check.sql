-- 0028 的验收：跑完迁移后执行，四行都要 PASS。（补写 —— 0028 当时没配 check）

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "pro/max 带工作区"
  from public.plan
 where id in ('pro', 'max') and (capabilities ->> 'workspace')::boolean is true;

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "lite 明确不带（不是缺键）"
  from public.plan
 where id = 'lite' and (capabilities ->> 'workspace')::boolean is false;

select case when exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'can_create_workspace'
       ) then 'PASS' else 'FAIL' end as "can_create_workspace() 在";

-- 策略换成了新函数。这一行是这条迁移的**全部意义**：判据从「有活跃订阅」变成
-- 「这一档带工作区」，而 has_active_subscription 原样留着（名字不能撒谎）
select case when pg_get_expr(polwithcheck, polrelid) like '%can_create_workspace%'
            then 'PASS' else 'FAIL: ' || pg_get_expr(polwithcheck, polrelid) end as "ws_insert_self 用新判据"
  from pg_policy where polrelid = 'public.workspaces'::regclass and polname = 'ws_insert_self';
