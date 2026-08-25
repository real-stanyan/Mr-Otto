-- 0011：德州扑克整层下线 —— 删表、删 RPC、删策略（ADR-0093）。
--
-- 0004 / 0005 / 0010 建的东西在这里全部收回，0006 的一半（game_invites）也在其中：
-- 牌局邀请是"约你上哪张桌"，桌不存在了它就没有指向。0006 的另一半
-- （profiles.last_seen_at 在线心跳）是好友系统的，留着。
--
-- 不动 token 钱包（token_wallets / token_ledger / token_balances 与
-- grant_tokens / spend_tokens / rebuild_balance）：那是"官方赠额"这条独立的线
-- （ADR-0085 第 1、2 条），同样休眠但不是德州。ledger 里 reason = poker_buyin /
-- poker_cashout 的历史行也留着 —— 账本是历史，余额由它累加而来，删了余额就错了。
--
-- 重跑安全：全部 if exists。

-- 函数先于表：poker_* 这几个 RPC 的函数体引用这些表，反过来删会在依赖上绊住。
drop function if exists public.poker_settle(uuid, uuid, text, integer, text, jsonb, text, jsonb, jsonb, jsonb, jsonb, jsonb);
drop function if exists public.poker_buyin(uuid, uuid, text, bigint, text);
drop function if exists public.poker_cashout(uuid, uuid, text);
drop function if exists public.poker_join(uuid, uuid, bigint, text);
drop function if exists public.poker_leave(uuid, uuid, text);
drop function if exists public.rebuild_stack(uuid, uuid);

-- cascade 是为了把 RLS 策略、索引、外键一起带走。game_invites 排在最前：
-- 它有一条指向 poker_tables 的外键，先删它，drop 的顺序才读得出依赖方向。
drop table if exists public.game_invites cascade;
drop table if exists public.poker_hands cascade;
drop table if exists public.poker_transfers cascade;
drop table if exists public.poker_stacks cascade;
drop table if exists public.poker_tables cascade;
