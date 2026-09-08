-- 0030_workspace_mentions.sql —— 被 @ 的人类成员的收件箱（#1064，ADR-0256）。幂等，重跑不炸。
-- 与 0021 / 0023 / 0026 同一约定：Supabase SQL editor / Management API 手动执行一次。
-- 已于 2026-09-08 经维护者确认后在生产执行（Management API，逐条发——那个端点只回
-- 最后一条语句的结果，整份贴进去看不出哪条炸了）。执行后核过五条：
--   ① 表在、0 行、RLS 开着；② 列/主键/外键/两个索引与本文件逐字一致；
--   ③ 进了 supabase_realtime publication；④ 策略只有 select/update 两条，**没有
--      insert/delete**；⑤ 拿一条探针行按真身份走了一遍 RLS——本人且在籍看得见（1）、
--      另一个真实账号看不见（0）、替别人 insert 被 42501 拒、自己 delete 影响 0 行、
--      自己改 read_at 放行。探针行随后删掉，表回到 0 行。
--
-- 为什么要一张新表：云会话的权威日志在 VPS 上，桌面够不着（要先开一条那个工作区的
-- 会话房才读得到 backlog）。而「你不在的时候有人喊你」这件事，恰恰只发生在你没开着
-- 它的时候——角标必须在一条会话都没开的时候就画得出来。这张表是那份日志的**投影**
-- （`user_message{fromUid}` + 那一刻这句话点到的成员），整表丢掉重放日志能重新算出来。
--
-- 一行 = 一次点名。主键 (uid, session_id, seq)：同一条开场白被重写一次（daemon 重启
-- 补跑 / 重试）就是同一行，天然幂等，不必另造去重键。
--
-- 写方是 runtime（service key，绕过 RLS）；读方是**被 @ 的本人**（走 RLS）。
-- from_label / excerpt 是写入那一刻的快照：通知正文要它们，而 profiles.name 会变——
-- 回头看「那天是谁喊我、喊的什么」应该还是那天那份措辞。

create table if not exists public.workspace_mentions (
  uid          uuid not null references auth.users(id) on delete cascade,
  session_id   text not null,
  seq          bigint not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  from_uid     uuid not null,
  from_label   text not null default '',
  excerpt      text not null default '',
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  primary key (uid, session_id, seq)
);

-- 角标那条查询：某个人此刻所有未读。按 uid 找、按未读过滤
create index if not exists workspace_mentions_unread_idx
  on public.workspace_mentions (uid, created_at desc)
  where read_at is null;

alter table public.workspace_mentions enable row level security;

-- 只读自己那些行，**且要此刻还在籍**：踢出去 = 关门（ADR-0199 的 requireStillMember
-- 在写路径上是同一条判据）。行留着不删——重新拉回来的人该看见那段历史；退了群的人
-- 不该继续读得到群里的正文摘要
drop policy if exists wsmn_select_self on public.workspace_mentions;
create policy wsmn_select_self on public.workspace_mentions for select to authenticated
  using (uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));

-- 只能把**自己的**行标成已读，且只准动 read_at 之外什么都改不了（with check 里把
-- 其余列钉在原值上做不到，所以退一步：能改的只有自己的行，而这张表除了 read_at
-- 没有任何一格是客户端会想改的——改坏了也只坏自己的角标）
drop policy if exists wsmn_update_self on public.workspace_mentions;
create policy wsmn_update_self on public.workspace_mentions for update to authenticated
  using (uid = auth.uid())
  with check (uid = auth.uid());

-- **不给 insert / delete**：写方只有 runtime（service key）。给成员 insert 等于让
-- 任何一个在籍的人替别人伪造一条「有人 @ 了你」；给 delete 则让「读过了」与
-- 「从没发生过」变成同一件事

-- Realtime：进 publication 才有 postgres_changes 可推（RLS 照常生效）。
-- 幂等：add table 对已在 publication 里的表会报 42710，用 exception 吞掉（同 0013）
do $$
begin
  alter publication supabase_realtime add table public.workspace_mentions;
exception when duplicate_object then null;
end $$;
