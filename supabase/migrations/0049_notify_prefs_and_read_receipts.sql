-- 0049_notify_prefs_and_read_receipts.sql —— 消息推送的开关、单聊免打扰、朋友私聊已读回执（#1442）。
-- 幂等，重跑不炸。同 0044 的约定：Supabase SQL editor / Management API 手动执行一次（那个端点只回最后
-- 一条语句的结果，逐条发）。**部署顺序：先跑这份、再部署 runtime、再发手机包**——反过来 runtime 每次要推
-- 都读不到开关，按「读不到就不推」（见 services/runtime/src/notifier.ts）一条都不发；手机设置页读不到开关
-- 就整段不画。
--
-- 三张表，写法各不相同：
--
-- · notify_prefs：一人一行，四个开关。没有这一行 = 全开（默认值就是 true，客户端第一次改才插）。
--   本人能读能写；runtime 用 service key 读，决定这一条推不推。
-- · chat_mutes：一人一条聊天一行 = 这条聊天「消息免打扰」。chat_key 与手机列表的键逐字相同
--   （src/shared/wechatInbox.ts 的 InboxRow.key：a: / g: / t: / j: / f:），runtime 按同一个规则算
--   （src/shared/notifyPrefs.ts 的 muteKeyFor），两边一个判据。不进 realtime publication：只有本人读，
--   而 Realtime 对 DELETE 不查 RLS，进了就是把「谁静音了谁」推给所有订阅者。
-- · friend_reads：朋友私聊的已读回执（已知例外：profiles 那一行被删时级联删行，DELETE 会把 (reader, peer)
--   推给订阅者；今天没有删账号的流程）。一行 = reader 已经读到 peer 发来的第几条（messages.id）。
--   只能经 mark_friend_read 往前推（客户端不许直接写：直接写就能替别人把「已读」标上）；双方都能读，
--   进 realtime 让发信的那一侧当场看到「已读」。**从不删行**（同 0044：DELETE 会把主键 (reader, peer)
--   ——也就是「谁和谁是朋友」——推给所有订阅者）：关掉已读回执时把 last_read_id 置空，对方那边就什么都不画。

-- ── notify_prefs ────────────────────────────────────────────────────

create table if not exists public.notify_prefs (
  uid            uuid primary key references auth.users(id) on delete cascade,
  agent_reply    boolean not null default true,   -- 智能体回答（私聊 / 我建的群 / 团队群里我问的那一句）
  mentions       boolean not null default true,   -- 有人在团队群里 @ 我
  friends        boolean not null default true,   -- 朋友私聊
  read_receipts  boolean not null default true,   -- 让朋友看到我已读
  updated_at     timestamptz not null default now()
);
alter table public.notify_prefs enable row level security;

drop policy if exists np_select_self on public.notify_prefs;
create policy np_select_self on public.notify_prefs for select to authenticated using (uid = auth.uid());
drop policy if exists np_insert_self on public.notify_prefs;
create policy np_insert_self on public.notify_prefs for insert to authenticated with check (uid = auth.uid());
drop policy if exists np_update_self on public.notify_prefs;
create policy np_update_self on public.notify_prefs for update to authenticated using (uid = auth.uid()) with check (uid = auth.uid());

-- ── chat_mutes ──────────────────────────────────────────────────────

create table if not exists public.chat_mutes (
  uid        uuid not null references auth.users(id) on delete cascade,
  chat_key   text not null check (chat_key ~ '^[agtjf]:[0-9A-Za-z_-]{1,120}$'),
  created_at timestamptz not null default now(),
  primary key (uid, chat_key)
);
alter table public.chat_mutes enable row level security;

drop policy if exists cm_select_self on public.chat_mutes;
create policy cm_select_self on public.chat_mutes for select to authenticated using (uid = auth.uid());
drop policy if exists cm_insert_self on public.chat_mutes;
create policy cm_insert_self on public.chat_mutes for insert to authenticated with check (uid = auth.uid());
drop policy if exists cm_delete_self on public.chat_mutes;
create policy cm_delete_self on public.chat_mutes for delete to authenticated using (uid = auth.uid());

-- ── friend_reads ────────────────────────────────────────────────────

create table if not exists public.friend_reads (
  reader       uuid not null references public.profiles(id) on delete cascade,
  peer         uuid not null references public.profiles(id) on delete cascade,
  last_read_id bigint,                              -- null = 不让对方知道（关了已读回执）
  updated_at   timestamptz not null default now(),
  primary key (reader, peer)
);
alter table public.friend_reads enable row level security;

drop policy if exists fr_select_parties on public.friend_reads;
create policy fr_select_parties on public.friend_reads for select to authenticated
  using (auth.uid() = reader or auth.uid() = peer);

-- 读到了 peer 发来的第 p_last_id 条：只往前推，且封顶在 peer 真发给我的最后一条（多报一个不存在的
-- id 只会让对方看到一句假话，这里顺手挡掉）。
-- 「有这一行」本身就是一句话：对方的手机认得已读回执（旧客户端从不写这一行，对方那边据此什么都不画，
-- 而不是一直写「未读」）。所以一条都还没读过也写一行 0；关了已读回执写一行 null（只在没有这一行时写，
-- 不碰 updated_at：碰了就是把「他刚打开过这个聊天」告诉对方）
create or replace function public.mark_friend_read(p_peer uuid, p_last_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_cap bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_peer is null or p_last_id is null or p_peer = auth.uid() then raise exception 'bad args'; end if;
  -- 只对朋友写（同 messages 的 insert 策略）：不然谁都能给任意一个人挂一行「我打开过和你的聊天」
  if not exists (
    select 1 from friendships f
    where f.status = 'accepted'
      and least(f.requester, f.addressee) = least(auth.uid(), p_peer)
      and greatest(f.requester, f.addressee) = greatest(auth.uid(), p_peer)
  ) then return; end if;
  if exists (select 1 from notify_prefs where uid = auth.uid() and read_receipts = false) then
    insert into friend_reads (reader, peer, last_read_id, updated_at) values (auth.uid(), p_peer, null, now())
    on conflict (reader, peer) do nothing;
    return;
  end if;
  select max(id) into v_cap from messages where sender = p_peer and recipient = auth.uid() and id <= p_last_id;
  insert into friend_reads (reader, peer, last_read_id, updated_at)
  values (auth.uid(), p_peer, coalesce(v_cap, 0), now())
  on conflict (reader, peer) do update
    set last_read_id = greatest(coalesce(friend_reads.last_read_id, 0), excluded.last_read_id), updated_at = now()
    -- 没往前走就不写：写了就是一条推给对方的 UPDATE，等于告诉他「他刚打开过这个聊天」
    where friend_reads.last_read_id is distinct from greatest(coalesce(friend_reads.last_read_id, 0), excluded.last_read_id);
end $$;
revoke all on function public.mark_friend_read(uuid, bigint) from public;
grant execute on function public.mark_friend_read(uuid, bigint) to authenticated;

-- 关掉已读回执：我名下的回执一律置空（不删行，理由见文件头）。开回来不补：下一次读到新消息时再写
create or replace function public.notify_prefs_receipts_off() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.read_receipts = false and (tg_op = 'INSERT' or old.read_receipts is distinct from false) then
    update friend_reads set last_read_id = null, updated_at = now() where reader = new.uid and last_read_id is not null;
  end if;
  return new;
end $$;
drop trigger if exists notify_prefs_receipts_off on public.notify_prefs;
create trigger notify_prefs_receipts_off after insert or update of read_receipts on public.notify_prefs
  for each row execute function public.notify_prefs_receipts_off();

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friend_reads')
  then alter publication supabase_realtime add table public.friend_reads; end if;
end $$;
