-- 0066：定时任务放宽（#1659 第二轮）
-- ① schedule 多一种形状 every（时段内每隔 N 分钟，src/shared/routines.ts 的 parseRoutineSchedule 是唯一校验）：
--    表级兜底只认 kind，同 0058 的写法。
-- ② 一只智能体启用中的任务上限 20 → 50（ROUTINES_ENABLED_MAX）。店铺管家在营业时段按 30 分钟一档排满了 20 条。
-- 幂等：drop constraint if exists + create or replace function，重跑无害。

alter table public.agent_routines drop constraint if exists agent_routines_schedule_shape;
alter table public.agent_routines add constraint agent_routines_schedule_shape
  check (jsonb_typeof(schedule) = 'object' and schedule->>'kind' in ('once', 'daily', 'weekly', 'every'));

create or replace function public.agent_routines_enabled_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled) then
    if (select count(*) from public.agent_routines r
        where r.workspace_id = new.workspace_id and r.agent_id = new.agent_id and r.enabled and r.id <> new.id) >= 50 then
      raise exception '启用中的定时任务最多 50 条' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
