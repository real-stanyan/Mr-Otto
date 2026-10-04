-- 0062_quiet_report.sql —— 免打扰时段与管理员的定时汇报（#1569，ADR-0366）。都挂在 notify_prefs 上（一人一行，0049）：
--   quiet   jsonb  null = 不开；{ "start": "22:00", "end": "08:00", "days": [1..7]? }  跨夜允许（start > end），days 缺席 = 每天
--   report  jsonb  null = 不开；{ "schedule": { "kind": "daily", "time": "09:00" } | { "kind": "weekly", "days": [..], "time": "HH:mm" }, "mode": "call" | "message" }
--   tz      text   手机写的 IANA 时区，两样都按它算
--   report_next_at / report_last_at  runtime 的认领指针（同 agent_routines 的 next_run_at：先推进再起 turn，#1283）；
--                  客户端改设置时把 report_next_at 清空，runtime 下一拍重算
-- 读写：客户端经 RLS 只读写自己那一行（0049 的三条策略原样覆盖新列）；runtime 用 service key 读全表的到点行、认领、写 last。

alter table public.notify_prefs add column if not exists quiet jsonb;
alter table public.notify_prefs add column if not exists report jsonb;
alter table public.notify_prefs add column if not exists tz text;
alter table public.notify_prefs add column if not exists report_next_at timestamptz;
alter table public.notify_prefs add column if not exists report_last_at timestamptz;

-- 形状只在入口挡最粗的那一层（同 0058 的 schedule）：细校验在 shared/quietHours.ts，两边都读得懂才算
alter table public.notify_prefs drop constraint if exists notify_prefs_quiet_shape;
alter table public.notify_prefs add constraint notify_prefs_quiet_shape
  check (quiet is null or (jsonb_typeof(quiet) = 'object' and quiet ? 'start' and quiet ? 'end'));
alter table public.notify_prefs drop constraint if exists notify_prefs_report_shape;
alter table public.notify_prefs add constraint notify_prefs_report_shape
  check (report is null or (jsonb_typeof(report) = 'object' and report->>'mode' in ('call', 'message') and jsonb_typeof(report->'schedule') = 'object'));

-- 到点那一拍只扫开了汇报的行
create index if not exists notify_prefs_report_due on public.notify_prefs (report_next_at) where report is not null;
