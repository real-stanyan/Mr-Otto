-- 0023_workspace_memories.sql —— 工作区多智能体的记忆（#949，spec §6）。幂等，重跑不炸。
-- 与 0021 同一约定：在 Supabase SQL editor 手动执行一次。
-- 一档一行：agent_id = '' 是工作区共享档，其余是那只 agent 的私有档。条目切分（"\n§\n"）
-- 是 src/shared/memoryStore.ts 的纯层，DB 只存整份文本。
-- 读写方是 runtime（service key，绕过 RLS）与桌面设置页（成员，走 RLS）。

create table if not exists public.workspace_memories (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id     text not null default '',
  content      text not null default '',
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, agent_id)
);

alter table public.workspace_memories enable row level security;

-- 成员可读（对称于 workspace_agents）
drop policy if exists wsm_mem_select_member on public.workspace_memories;
create policy wsm_mem_select_member on public.workspace_memories for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));

-- 成员可写：在籍即可（对称于连接器池 ADR-0198 决策③——记忆是群的公共财产，不是谁的私产）
drop policy if exists wsm_mem_insert_member on public.workspace_memories;
create policy wsm_mem_insert_member on public.workspace_memories for insert to authenticated
  with check (public.is_ws_member(workspace_id, auth.uid()));

drop policy if exists wsm_mem_update_member on public.workspace_memories;
create policy wsm_mem_update_member on public.workspace_memories for update to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()))
  with check (public.is_ws_member(workspace_id, auth.uid()));

drop policy if exists wsm_mem_delete_member on public.workspace_memories;
create policy wsm_mem_delete_member on public.workspace_memories for delete to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
