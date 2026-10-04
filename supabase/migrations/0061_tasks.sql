-- 0061_tasks.sql —— 任务的投影表（#1571，ADR-0364，spec §2.4）。幂等。与 0060 一起跑，再部署 runtime。
--
-- 任务是**事件**（task_created / task_assigned / task_progress / task_done / task_failed / task_needs_owner），
-- 落在管理员那条私聊的会话日志里；这张表是 runtime 折出来的投影，**客户端只读**（RLS：主场成员可读，
-- 写只有 service role——与 0044 的 agent_activity 同一条纪律）。重建这张表 = 重放日志，不是真相。
-- 状态行「执行中 · 任务：明天出游 › 订票」从 assignee_agent_id + session_id 反查这里。

create table if not exists public.tasks (
  id                 uuid primary key,
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  parent_id          uuid references public.tasks(id) on delete cascade,
  title              text not null check (char_length(title) between 1 and 80),
  brief              text not null default '' check (char_length(brief) <= 2000),
  assignee_agent_id  text,
  session_id         uuid,
  status             text not null check (status in ('open', 'assigned', 'running', 'needs_owner', 'done', 'failed')),
  question           text,
  summary            text,
  created_by_agent   text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists tasks_ws_status_idx on public.tasks (workspace_id, status);
create index if not exists tasks_assignee_idx on public.tasks (workspace_id, assignee_agent_id, session_id) where status in ('assigned', 'running');

alter table public.tasks enable row level security;

drop policy if exists tasks_select_member on public.tasks;
create policy tasks_select_member on public.tasks for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
-- 没有 insert / update / delete 策略：authenticated 一律写不进，只有 service role（runtime）能写

-- Realtime（手机状态行要跟着变）：同 0044，只订 INSERT / UPDATE，靠 RLS 不靠过滤。幂等：42710 吞掉
do $$
begin
  alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then null;
end $$;
