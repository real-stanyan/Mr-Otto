-- 0057_agent_routines.sql —— 智能体的定时任务（#1283，ADR-0356）。幂等，重跑不炸。
-- 同 0049 的约定：Supabase SQL editor / Management API 手动执行一次（那个端点只回最后一条语句的结果，逐条发）。
-- **部署顺序：先跑这份、再部署 runtime、再发手机热更新**——反过来 runtime 的调度器每 30 秒读一次不存在的表、
-- 只记一行日志；手机的「定时任务」那一行读不到表就整行不画。**还没有在生产执行**。
--
-- 一行 = 一只智能体的一条任务。调度器只看 next_run_at（部分索引），认领是
--   update … set next_run_at = <下一跳> where id = $1 and next_run_at = $2 returning *
-- 两个 runtime 实例同时 tick 只有一个 returning 有行。墙上时间 + tz 存在 schedule / tz 里，
-- next_run_at 是按它们算出来的绝对时刻缓存（runtime 认领时按 schedule 重算，手机算错最多早 / 晚一次）。
-- 没有 session_id：私聊按 0037 的唯一索引 (workspace_id, agent_ids[1]) where chat_kind='dm' 现查。
-- 写入要求 workspace 是本人的（owner_uid = auth.uid() 且 workspaces.owner_uid = auth.uid()）：定时任务只存在于个人主场，视同主人亲口起的轮，别人不能往你的主场里塞一条。

create table if not exists public.agent_routines (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  agent_id      text not null,
  owner_uid     uuid not null references auth.users(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 40),
  instruction   text not null check (char_length(instruction) between 1 and 2000),
  schedule      jsonb not null,
  tz            text not null,
  enabled       boolean not null default true,
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_status   text check (last_status in ('done', 'skipped_quota', 'missed', 'failed')),
  created_by    text not null check (created_by in ('user', 'agent')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (workspace_id, agent_id) references public.workspace_agents(workspace_id, agent_id) on delete cascade
);

-- 表级兜底（C1）：schedule 至少得是三种 kind 之一、tz 至少长得像 IANA 名字。客户端与 runtime 各自校验过，
-- 这两条拦的是绕过客户端直接打 REST 的写入——一条坏行在 runtime 那边会被 due() 隔离 / 调度器停用，
-- 但能在入口就挡住的不该放进来。drop + add 而不是写进 create table：表若已在别处建过（dev 库跑过旧版），重跑也补得上。
alter table public.agent_routines drop constraint if exists agent_routines_schedule_shape;
alter table public.agent_routines add constraint agent_routines_schedule_shape
  check (jsonb_typeof(schedule) = 'object' and schedule->>'kind' in ('once', 'daily', 'weekly'));
alter table public.agent_routines drop constraint if exists agent_routines_tz_shape;
alter table public.agent_routines add constraint agent_routines_tz_shape
  check (char_length(tz) between 1 and 64 and tz ~ '^[A-Za-z0-9_+\-/]+$');

create index if not exists agent_routines_due on public.agent_routines (next_run_at) where next_run_at is not null;
create index if not exists agent_routines_agent on public.agent_routines (workspace_id, agent_id);

alter table public.agent_routines enable row level security;

drop policy if exists ar_select_owner on public.agent_routines;
create policy ar_select_owner on public.agent_routines for select to authenticated using (owner_uid = auth.uid());
drop policy if exists ar_insert_owner on public.agent_routines;
create policy ar_insert_owner on public.agent_routines for insert to authenticated
  with check (owner_uid = auth.uid()
    and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()));
drop policy if exists ar_update_owner on public.agent_routines;
create policy ar_update_owner on public.agent_routines for update to authenticated
  using (owner_uid = auth.uid())
  with check (owner_uid = auth.uid()
    and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()));
drop policy if exists ar_delete_owner on public.agent_routines;
create policy ar_delete_owner on public.agent_routines for delete to authenticated using (owner_uid = auth.uid());

-- 不进 supabase_realtime：只有本人读，而 Realtime 对 DELETE 不查 RLS（同 chat_mutes 的理由）。

-- 主人的设备时区（spec §6.3）：手机前台时写，调度器建任务时 tz 省略就用它。IANA 名字，由客户端校验，这里只拦形状。
-- **不放 profiles**：profiles 的 select 策略是 using (true)（0001_friends），所有登录用户都读得到；
-- 一个出差就会变、手机前台就会改写的时区放在那儿，等于让任何人跟踪你人在哪。单开一张只有本人读写的表
-- （runtime 用 service key 读，不受 RLS 管）。
create table if not exists public.user_settings (
  uid        uuid primary key references auth.users(id) on delete cascade,
  timezone   text check (timezone is null or (char_length(timezone) between 1 and 64 and timezone ~ '^[A-Za-z0-9_+\-/]+$')),
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
drop policy if exists us_select_self on public.user_settings;
create policy us_select_self on public.user_settings for select to authenticated using (uid = auth.uid());
drop policy if exists us_insert_self on public.user_settings;
create policy us_insert_self on public.user_settings for insert to authenticated with check (uid = auth.uid());
drop policy if exists us_update_self on public.user_settings;
create policy us_update_self on public.user_settings for update to authenticated using (uid = auth.uid()) with check (uid = auth.uid());
