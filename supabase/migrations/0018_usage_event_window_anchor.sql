-- 0018：usage_event 记下「这笔成本落进了哪扇 5h 窗」（#863，ADR-0203 决定 19）
--
-- 5h 窗是跨周连续的（Quota DO 的 roll 只清周用量，不关 5h 窗），而冷启动重建以前
-- 只按「周段起点起的事件链」回放固定窗边界——链头不是一扇新窗的时候（跨周边界、
-- 或任何一次拉取起点落在窗中间），重建出来的窗就比线上那扇晚开、少算。
-- 锚是 settle 那一刻 DO 里的 open5hAt：window 事件总带；addon 事件只在溢出到窗口时带；
-- 0018 之前的旧行为 null，重建对它们退回链回放。
alter table public.usage_event add column if not exists window_open_at timestamptz;
comment on column public.usage_event.window_open_at is
  '这笔成本落进的 5h 窗的开窗时刻（settle 时 Quota DO 的 open5hAt）；null = 没有钱进窗（addon 未溢出）或 0018 之前的旧行';
