-- 0040_workspace_sessions_last.sql —— 名册的「最后一句 + 最近动静」（#1356 A1，spec §7.1）。幂等，重跑不炸。
--
-- 与 0016 / 0021 / 0026 / 0030 / 0035 同一约定：Supabase SQL editor / Management API 手动执行一次
-- （那个端点只回最后一条语句的结果，逐条发）。**部署顺序：先跑这份、再部署 runtime**——
-- runtime 在列不存在时只记一行日志不崩（cloudSessionMeta 的 write() 接住 42703），
-- 反过来也不出事，只是名册那一格一直空着。
--
-- 为什么是加三列而不是一张新表：这份东西**只有一个当前值**（最后一句），没有历史维度
-- （同 0035 participants 的理由）。RLS 已经有（wss_select_member，在籍即可读）。
--
-- 写方只有 runtime（service key，绕过 RLS）。**不新增任何 update 策略**：现有的
-- wss_update_publisher 钉在 kind='package' 上，云会话行客户端本来就改不动——给了就是
-- 让任何在籍成员伪造「某某刚说了一句」。
--
-- 不回填：缺席时各端按 spec §5.2 的退路排（updated_at → 智能体自己的 created_at）。
--
-- last_ts      : 那句话落盘的时刻；null = 还没人说过一句算数的话
-- last_excerpt : 第一段非空文字、折叠空白、≤120 字（判据 src/shared/sessionLast.ts）
-- last_from    : agent:<agentId> / human:<uid>

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'last_ts'
  ) then
    alter table public.workspace_sessions add column last_ts timestamptz;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'last_excerpt'
  ) then
    alter table public.workspace_sessions add column last_excerpt text not null default '';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'last_from'
  ) then
    alter table public.workspace_sessions add column last_from text not null default '';
  end if;
end $$;
