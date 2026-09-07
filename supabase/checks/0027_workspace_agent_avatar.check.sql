-- 0027 的验收：跑完迁移后执行，两行都要 PASS。
select case when exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'workspace_agents'
            and column_name = 'avatar_slot' and is_nullable = 'YES'
       ) then 'PASS' else 'FAIL' end as "avatar_slot 列在且可空";

select case when exists (
         select 1 from pg_constraint
          where conname = 'workspace_agents_avatar_slot_range'
            and conrelid = 'public.workspace_agents'::regclass
       ) then 'PASS' else 'FAIL' end as "范围约束在";

-- 存量行应当全是 null（迁移不回填，null = 照旧派生）
select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) end as "存量行 avatar_slot 全为 null"
  from public.workspace_agents where avatar_slot is not null;
