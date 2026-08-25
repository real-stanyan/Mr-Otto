-- 0012：把好友三张表重新加回 supabase_realtime publication。
--
-- 为什么需要这一条：2026-08-25 从自建栈迁到 Supabase Cloud 时，schema 和数据都
-- 过去了，publication 的成员关系没有 —— pg_dump 不会为一个不属于本次转储的
-- publication 生成 alter，于是新库里 supabase_realtime 是空的。表现不是报错，
-- 是"慢"：postgres_changes 一条都不推，客户端按 ADR-0027 静默切到轮询兜底，
-- 好友请求/私信要等下一拍心跳才出现。查了才知道，所以要有这条 migration。
--
-- 幂等：add table 对已在 publication 里的表会报 42710，用 exception 吞掉。

do $$
begin
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.friendships;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
end $$;
