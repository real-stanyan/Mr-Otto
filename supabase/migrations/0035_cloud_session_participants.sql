-- 0035_cloud_session_participants.sql —— 「最近谁在这条云会话里说过话」（#1213）。幂等，重跑不炸。
--
-- 原为 0034：合并 origin/main 时撞号，另一条 lane（#1140）的
-- `0034_workspace_wiki_journal.sql` 已于 2026-09-09 在生产 Supabase 上执行过（见
-- docs/adr/0282、supabase/README.md 的执行状态记录），这个号先到先得，改号的是这份
-- 从没跑过的（project ADR-0074）。库认的是 workspace_sessions 与两个新列名，不是
-- 文件编号——这次改号不改 SQL 本体一个字，之前算好的列定义仍然原样。
--
-- 与 0016 / 0021 / 0026 / 0030 同一约定：Supabase SQL editor / Management API 手动执行一次
-- （那个端点只回最后一条语句的结果，逐条发，整份贴进去看不出哪条炸了）。
--
-- 为什么是加两列而不是一张新表：这份东西**只有一个当前值**——固定窗切桶、永远显示
-- 最后一个有过对话的那个窗，所以没有历史维度可留（#1213 拍板第 3 条）。而
-- listCloudSessions 已经在查这张表，加两格 select 是零额外往返；RLS 也已经有
-- （wss_select_member，在籍即可读）。新表要另写一遍 RLS、另开一次查询，还会凭空
-- 长出一个没有消费方的历史维度。
--
-- 与 0030 的 workspace_mentions 为什么是新表不矛盾：那份是一人一行的收件箱
-- （主键 (uid, session_id, seq)、要按人查、要标已读），这份是会话的一格属性。
--
-- 写方只有 runtime（service key，绕过 RLS）。**不新增任何 update 策略**：现有的
-- wss_update_publisher 钉在 kind='package' 上，云会话行客户端本来就改不动——
-- 给了就是让任何在籍成员伪造「某某参与过」。
--
-- participants        : uid 数组（jsonb），首次出现的顺序，已去重
-- participants_window : floor(ts / 5h) —— 那个数组属于哪个窗

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'participants'
  ) then
    alter table public.workspace_sessions
      add column participants jsonb not null default '[]'::jsonb;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'participants_window'
  ) then
    alter table public.workspace_sessions
      add column participants_window bigint not null default 0;
  end if;
end $$;
