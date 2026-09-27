-- 0042_workspace_agents_voice.sql —— 每只智能体可以挑「说话的声音」（#1372，#1356 A4b）。幂等。
-- 与 0027 同一约定：Supabase SQL editor / Management API 手动执行一次（生产库动作等维护者明说）。
-- **读是单独一条容错查询**（src/shared/supabaseWorkspacesApi.ts 的 fetchAgentVoices），所以先合代码后跑库
-- 也行：这一列不在时一格都读不到 = 全部按 agent_id 派生，名册照常；手机上挑了按「存」会被库拒，
-- 界面说「服务端还没升级」（agentAdmin.ts 的 VOICE_NOT_READY）。
--
-- 存的是我们自己的键（qing / wen / chen / gan / shao / bo），不是 MiniMax 的音色 id：换一档背后的音色
-- 只改 src/shared/agentVoice.ts 那张表，不用再跑库。约束只管形状，不写死这六个（同 0027 不写死 13 张
-- 头像）：旧客户端读到新键当没挑过，由客户端兜。null = 没挑过 = 照旧按 agent_id 派生，存量行一行不改。

alter table public.workspace_agents
  add column if not exists voice text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'workspace_agents_voice_shape'
       and conrelid = 'public.workspace_agents'::regclass
  ) then
    alter table public.workspace_agents
      add constraint workspace_agents_voice_shape
      check (voice is null or voice ~ '^[a-z]{1,16}$');
  end if;
end $$;

comment on column public.workspace_agents.voice is
  '说话的声音：我们自己的键（src/shared/agentVoice.ts 的 AGENT_VOICE_CHOICES）。null = 没挑过，按 agent_id 派生。#1372';
