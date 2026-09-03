-- supabase/checks/0018_usage_event_window_anchor.check.sql
-- 跑完 0018 后在 SQL editor 执行；期望 PASS
select 'usage_event.window_open_at' as check, case when count(*) = 1 then 'PASS' else 'FAIL' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'usage_event' and column_name = 'window_open_at' and data_type = 'timestamp with time zone';
