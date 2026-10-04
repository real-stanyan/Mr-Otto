-- 0057 公开智能体（#1533，#1532 一期）：每人可以设定一只自己主场里的智能体为「公开智能体」——朋友在和我的私聊里能 @ 它、
-- 给它打电话（走 #1523 的共享车道：朋友以 0043 客人身份进我主场里那条车道）。
-- 幂等，重跑不炸。Supabase SQL editor / Management API 手动执行一次（逐条发）。
-- **部署顺序：先跑这份、再部署 runtime（协议 26）、再发手机包。** 没跑时：手机「我」页存公开智能体报「没这一列」，
-- 朋友那边读不到任何公开智能体（RPC 不存在 → null → 不画），runtime 收到 onBehalf 的 create 查不到列 → 说「服务器还没准备好」。

-- ① 设定落在 profiles 上：自己改自己那一行（profiles_update_self 现成）。只存 agent_id：那只必须住在本人主场里，
--    RPC 那边按主场 join，不存 workspace_id（主场只有一个、kind='home' 的那一个）
alter table public.profiles add column if not exists public_agent_id text;

-- ② 朋友读我的公开智能体：只给**已接受的好友**、且生效档位（两边取最小值，0054 / ADR-0350）到了「可带智能体」的人；
--    只回画头像 / @ 选人 / 建车道要用的几列——提示词、型号、连接器一格都不给（同 0043 的 guest_chat_agents）。
--    security definer：朋友对我的 workspace_agents 没有读路径。没设 / 不是好友 / 档位不够 / 那只已删一律回空（不泄露存在性）
create or replace function public.public_agent_of(p_uid uuid)
returns table (workspace_id uuid, agent_id text, name text, description text, avatar_slot smallint)
language sql stable security definer set search_path = public as $$
  select w.id, a.agent_id, a.name, a.description, a.avatar_slot
  from profiles p
  join workspaces w on w.kind = 'home' and w.owner_uid = p.id
  join workspace_agents a on a.workspace_id = w.id and a.agent_id = p.public_agent_id
  where p.id = p_uid
    and p.public_agent_id is not null
    and exists (
      select 1 from friendships f
      where f.status = 'accepted'
        and ((f.requester = p_uid and f.addressee = auth.uid()) or (f.requester = auth.uid() and f.addressee = p_uid))
        -- 两边取最小值 ≥ agents：任一边是 chat 就不给
        and f.requester_tier <> 'chat' and f.addressee_tier <> 'chat'
    )
  limit 1
$$;
revoke all on function public.public_agent_of(uuid) from public;
revoke all on function public.public_agent_of(uuid) from anon;
grant execute on function public.public_agent_of(uuid) to authenticated;
