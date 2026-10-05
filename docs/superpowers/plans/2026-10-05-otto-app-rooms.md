# Otto 应用的「房间」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Otto 应用能和好友一起玩 / 一起记——房主在应用里开房间、邀好友，房间里有成员共读写的持久数据与即时消息，回合制能 ping 对方。

**Architecture:** 房间建在 Supabase 上（migration 0067：四张表 + security definer RPC + RLS + Realtime 策略）；手机宿主 `MiniAppScreen` 多一个房间模式（跑房主钉住的那一版、订变更与 broadcast）；桥 `window.otto.room` + `otto.on/off` 事件；邀请卡 = 应用卡信封多一格 `room`（不进位 cs 协议）；runtime 订 `app_room_pings` 推送。

**Tech Stack:** Postgres / Supabase（RLS、RPC、Realtime postgres_changes + private broadcast）、TypeScript strict、vitest、React Native（expo）、react-native-webview。

**Spec:** `docs/superpowers/specs/2026-10-05-otto-app-rooms-design.md`

## Global Constraints

- 房间人数（invited + joined）≤ 8；每人同时开着的房间 ≤ 50；单房间键数 ≤ 500；单值 ≤ 64 KB（`pg_column_size`）；键 1–200 字。
- 即时消息 JSON ≤ 4 KB、每秒 ≤ 20 条（客户端闸）；ping 正文 1–80 字、同人同房 10 秒一条、每小时 60 条（超了回 false 不抛）；房间名 1–40 字。
- **不改 cs 协议号**（`CS_PROTOCOL_VERSION` 保持 29）、不加帧。
- 写只走 RPC；表对 authenticated 只开 select（`app_room_pings` 连 select 都不开）。
- 个人 `app_data` 不动；`room` 是新能力，清单不声明就拒（`bridgeDenied`）。
- 智能体不进房间（第一版只人和人）。
- migration 号 0067、ADR 号 0374 都是**合并时认领**：合并前 re-fetch，撞号改 max+1 并改全部引用（AGENTS.md / ADR-0074）。
- 跑生产 migration 要维护者在会话里点头。
- 门禁：`npm test`（tsc + mobile tsc + vitest）。测试放 `tests/` 镜像 `src/`。
- 子 agent 派发词固定两句禁令（本仓记忆）：不许 `git stash`、不许改本任务 Files 以外的文件；全角 / 易混字符在派发词里用文字描述，不抄码点。

---

## File Structure

| 文件 | 新建/改 | 职责 |
|---|---|---|
| `supabase/migrations/0067_app_rooms.sql` | 新建 | 表、`is_room_member` / `room_topic_member`、RPC、RLS、版本与桶的读放行、Realtime |
| `supabase/checks/0067_app_rooms.check.sql` | 新建 | 结构验收（逐条 PASS） |
| `supabase/checks/0067_app_rooms.behavior.sql` | 新建 | 行为验收：一个 DO 块扮人跑完整场景，结尾 `raise exception` 让整笔回滚，结果写在报错里 |
| `src/shared/appRoom.ts` | 新建 | 常量、行解析、邀请信封、`familyOf` / `myAppForHost`、`roomTopic`、速率闸 |
| `src/shared/appRoomApi.ts` | 新建 | 客户端 IO：RPC 包装、读、订阅（postgres_changes + broadcast） |
| `src/shared/apps.ts` | 改 | `APP_CAPABILITIES` 加 `room` |
| `src/shared/appBridge.ts` | 改 | `otto.room.*`、`otto.on/off`、`__ottoEvent`、`bridgeEventJs`、`capabilityOf` |
| `src/shared/wechatInbox.ts` | 改 | 列表第二行：邀请卡显示 `[邀请] …` |
| `services/runtime/src/buildAppTool.ts` | 改 | jsdom 假桥对 `room.list` / `room.rooms` 回 `[]`；工具说明写房间 API |
| `src/shared/tierPrompt.ts` | 改 | 应用专员与管理员各一句房间 |
| `mobile/src/nav/types.ts` | 改 | `MiniApp: { appId; share?; roomId? }` |
| `mobile/src/apps/MiniAppScreen.tsx` | 改 | 房间模式：载房主那一版、`room.*` 处理、订阅、邀请 |
| `mobile/src/apps/AppShareBubble.tsx` | 改 | 邀请卡：「邀请你一起玩」+「加入」 |
| `mobile/src/friends/FriendChatScreen.tsx` | 改 | 把 `room` 一格传给气泡 |
| `src/shared/notifyPrefs.ts` | 改 | `AlertTarget` 加 `room` |
| `services/runtime/src/roomPush.ts` | 新建 | 订 `app_room_pings` INSERT → 推其他成员 |
| `services/runtime/src/daemon.ts` | 改 | 装配 roomPush |
| `mobile/src/push/messagePush.ts` | 改 | 点开 room 推送进房间模式 |
| `docs/adr/0374-…md`、`CONTEXT.md`、`docs/where-to-find-things.md` | 新建/改 | 决策、术语、代码地图 |

---

### Task 1: migration 0067 + 两份验收 SQL

**Files:**
- Create: `supabase/migrations/0067_app_rooms.sql`
- Create: `supabase/checks/0067_app_rooms.check.sql`
- Create: `supabase/checks/0067_app_rooms.behavior.sql`
- Test: `tests/docs/migrationAppRooms.test.ts`（新建，读文件断言关键片段——本仓没有本地 Postgres，SQL 的真验收在生产跑 check/behavior，见 Task 11）

**Interfaces:**
- Produces（RPC，全部 `security definer`、`set search_path = public`、`grant execute … to authenticated`、`revoke … from public, anon`）：
  - `app_room_create(p_app uuid, p_title text) returns uuid`
  - `app_room_invite(p_room uuid, p_uid uuid) returns void`
  - `app_room_join(p_room uuid) returns void`
  - `app_room_leave(p_room uuid) returns void`
  - `app_room_set(p_room uuid, p_key text, p_value jsonb, p_if_rev bigint default null) returns jsonb` → `{"ok":true,"rev":n}` | `{"ok":false,"rev":n,"value":…}`
  - `app_room_remove(p_room uuid, p_key text) returns void`
  - `app_room_ping(p_room uuid, p_text text) returns boolean`
  - 表列见下；`app_rooms.family_id` = 建房那个应用的「源」（副本取 `share:` 后面的 id，原版取自己）

- [ ] **Step 1: 写读文件测试（先红）**

```ts
// tests/docs/migrationAppRooms.test.ts
// migration 0067（#1675）的形状钉子：本仓没有本地 Postgres，真验收在生产跑 supabase/checks/0067_*.sql；这里钉住不能漏的几处
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0067_app_rooms.sql", import.meta.url), "utf8");

describe("0067 app rooms", () => {
  it("四张表都开 RLS", () => {
    for (const t of ["app_rooms", "app_room_members", "app_room_data", "app_room_pings"]) {
      expect(sql).toContain(`create table if not exists public.${t}`);
      expect(sql).toContain(`alter table public.${t} enable row level security`);
    }
  });
  it("写只走 RPC：没有给 authenticated 的 insert / update / delete 策略（broadcast 的 realtime.messages 除外）", () => {
    const own = sql.split("\n").filter((l) => /create policy/.test(l) && !/realtime\.messages/.test(l)).join("\n");
    expect(own).not.toMatch(/for (insert|update|delete|all) to authenticated/);
  });
  it("七个 RPC 都是 security definer、都 grant 给 authenticated", () => {
    for (const f of ["app_room_create", "app_room_invite", "app_room_join", "app_room_leave", "app_room_set", "app_room_remove", "app_room_ping"]) {
      expect(sql).toMatch(new RegExp(`create or replace function public\\.${f}\\([^)]*\\)[\\s\\S]*?security definer`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${f}\\(`));
    }
  });
  it("跑房主那一版：app_versions 与 otto-apps 桶各一条按房间成员放行的 select", () => {
    expect(sql).toContain("create policy app_versions_select_room on public.app_versions for select to authenticated");
    expect(sql).toContain(`create policy "otto_apps_select_room" on storage.objects for select to authenticated`);
  });
  it("broadcast 私有频道按成员放行；变更推送进 publication", () => {
    expect(sql).toContain("on realtime.messages for select to authenticated");
    expect(sql).toContain("on realtime.messages for insert to authenticated");
    expect(sql).toMatch(/supabase_realtime[\s\S]*app_room_data/);
  });
  it("限额与 if_rev 在 RPC 里判", () => {
    for (const s of [">= 8", ">= 50", ">= 500", "65536", "interval '10 seconds'", ">= 60", "p_if_rev"]) expect(sql).toContain(s);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run tests/docs/migrationAppRooms.test.ts`
Expected: FAIL（ENOENT，文件不存在）

- [ ] **Step 3: 写 migration**

```sql
-- 0067 Otto 应用的房间（#1675，spec docs/superpowers/specs/2026-10-05-otto-app-rooms-design.md §3）
-- 一局 / 一本共享的账 = 一间房：成员共读写的键值（app_room_data）+ 成员间即时消息（Realtime broadcast，不落库）。
-- 写只走下面的 RPC（比较后再写、人数上限、好友判据、限速都要在一个事务里判）；表对 authenticated 只开 select。

create table if not exists public.app_rooms (
  id            uuid primary key default gen_random_uuid(),
  host_uid      uuid not null references auth.users(id) on delete cascade,
  host_app_id   uuid not null references public.apps(id) on delete cascade,
  host_version  int  not null check (host_version >= 1),
  family_id     uuid not null,
  title         text not null check (char_length(title) between 1 and 40),
  closed        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists app_rooms_family on public.app_rooms (family_id);
create index if not exists app_rooms_host on public.app_rooms (host_uid) where not closed;

create table if not exists public.app_room_members (
  room_id     uuid not null references public.app_rooms(id) on delete cascade,
  uid         uuid not null references auth.users(id) on delete cascade,
  status      text not null check (status in ('invited', 'joined', 'left')),
  invited_by  uuid references auth.users(id) on delete set null,
  joined_at   timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (room_id, uid)
);
create index if not exists app_room_members_uid on public.app_room_members (uid);

create table if not exists public.app_room_data (
  room_id     uuid not null references public.app_rooms(id) on delete cascade,
  key         text not null check (char_length(key) between 1 and 200),
  value       jsonb not null,
  rev         bigint not null default 1,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (room_id, key)
);

create table if not exists public.app_room_pings (
  id          bigserial primary key,
  room_id     uuid not null references public.app_rooms(id) on delete cascade,
  from_uid    uuid not null references auth.users(id) on delete cascade,
  text        text not null check (char_length(text) between 1 and 80),
  created_at  timestamptz not null default now()
);
create index if not exists app_room_pings_rate on public.app_room_pings (room_id, from_uid, created_at desc);

alter table public.app_rooms enable row level security;
alter table public.app_room_members enable row level security;
alter table public.app_room_data enable row level security;
alter table public.app_room_pings enable row level security;

-- 成员判据只有这一处（joined 才算；关了的房间照样能读，写由 RPC 拦）
create or replace function public.is_room_member(p_room uuid, p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_room_members m where m.room_id = p_room and m.uid = p_uid and m.status = 'joined');
$$;
revoke all on function public.is_room_member(uuid, uuid) from public, anon;
grant execute on function public.is_room_member(uuid, uuid) to authenticated;

-- broadcast 频道名 room:<uuid> → 是不是成员。名字不合形状回 false（不让 ::uuid 的转换报错把策略炸掉）
create or replace function public.room_topic_member(p_topic text, p_uid uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if p_topic is null or p_topic !~ '^room:[0-9a-fA-F-]{36}$' then return false; end if;
  return public.is_room_member(substring(p_topic from 6)::uuid, p_uid);
end $$;
revoke all on function public.room_topic_member(text, uuid) from public, anon;
grant execute on function public.room_topic_member(text, uuid) to authenticated;

-- 读：房主 / 被邀的 / 成员看得到房间与名单；数据只有 joined 成员看得到；pings 客户端不读（runtime 用 service role）
drop policy if exists app_rooms_select on public.app_rooms;
create policy app_rooms_select on public.app_rooms for select to authenticated using (
  host_uid = auth.uid()
  or exists (select 1 from public.app_room_members m where m.room_id = app_rooms.id and m.uid = auth.uid() and m.status in ('invited', 'joined'))
);
drop policy if exists app_room_members_select on public.app_room_members;
create policy app_room_members_select on public.app_room_members for select to authenticated using (
  uid = auth.uid() or public.is_room_member(room_id, auth.uid())
);
drop policy if exists app_room_data_select on public.app_room_data;
create policy app_room_data_select on public.app_room_data for select to authenticated using (public.is_room_member(room_id, auth.uid()));

-- 建一间：应用是自己的、打过第一版；钉住当前版本；family = 源（副本取 share: 后面那个 id）
create or replace function public.app_room_create(p_app uuid, p_title text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_app public.apps%rowtype;
  v_family uuid;
  v_id uuid;
begin
  if v_uid is null then raise exception '还没登录'; end if;
  select * into v_app from public.apps where id = p_app and owner_uid = v_uid;
  if not found then raise exception '这个应用不是你的'; end if;
  if v_app.current_version < 1 then raise exception '这个应用还没有打出第一版'; end if;
  if (select count(*) from public.app_rooms where host_uid = v_uid and not closed) >= 50 then
    raise exception '开着的房间最多 50 个，先关掉几个';
  end if;
  v_family := case when v_app.created_by_agent ~ '^share:[0-9a-fA-F-]{36}$' then substring(v_app.created_by_agent from 7)::uuid else v_app.id end;
  insert into public.app_rooms (host_uid, host_app_id, host_version, family_id, title)
    values (v_uid, v_app.id, v_app.current_version, v_family, left(coalesce(nullif(btrim(p_title), ''), '一局'), 40))
    returning id into v_id;
  insert into public.app_room_members (room_id, uid, status, invited_by, joined_at) values (v_id, v_uid, 'joined', v_uid, now());
  return v_id;
end $$;

-- 邀请：只有房主；对方是 accepted 好友；人数（invited + joined）≤ 8；已在就幂等
create or replace function public.app_room_invite(p_room uuid, p_uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_room public.app_rooms%rowtype;
begin
  if v_uid is null then raise exception '还没登录'; end if;
  select * into v_room from public.app_rooms where id = p_room;
  if not found or v_room.host_uid <> v_uid then raise exception '只有房主能邀请'; end if;
  if v_room.closed then raise exception '这一局已经结束了'; end if;
  if p_uid = v_uid then return; end if;
  if not exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and least(f.requester, f.addressee) = least(v_uid, p_uid)
       and greatest(f.requester, f.addressee) = greatest(v_uid, p_uid)
  ) then raise exception '只能邀请好友'; end if;
  if exists (select 1 from public.app_room_members where room_id = p_room and uid = p_uid and status in ('invited', 'joined')) then return; end if;
  if (select count(*) from public.app_room_members where room_id = p_room and status in ('invited', 'joined')) >= 8 then
    raise exception '一间最多 8 个人';
  end if;
  insert into public.app_room_members (room_id, uid, status, invited_by) values (p_room, p_uid, 'invited', v_uid)
    on conflict (room_id, uid) do update set status = 'invited', invited_by = v_uid, updated_at = now();
end $$;

create or replace function public.app_room_join(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if exists (select 1 from public.app_rooms where id = p_room and closed) then raise exception '这一局已经结束了'; end if;
  update public.app_room_members set status = 'joined', joined_at = coalesce(joined_at, now()), updated_at = now()
   where room_id = p_room and uid = v_uid and status in ('invited', 'joined');
  if not found then raise exception '你没被邀请进这一局'; end if;
end $$;

-- 离开：房主离开 = 关房（数据留着只读）
create or replace function public.app_room_leave(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if exists (select 1 from public.app_rooms where id = p_room and host_uid = v_uid) then
    update public.app_rooms set closed = true, updated_at = now() where id = p_room;
    return;
  end if;
  update public.app_room_members set status = 'left', updated_at = now() where room_id = p_room and uid = v_uid;
end $$;

-- 写一个键。p_if_rev：null = 直接写；0 = 只在还没有这个键时写；n = 只在现在是第 n 版时写。对不上不抛，回现值
create or replace function public.app_room_set(p_room uuid, p_key text, p_value jsonb, p_if_rev bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_rev bigint;
  v_cur jsonb;
  v_cur_rev bigint;
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if not public.is_room_member(p_room, v_uid) then raise exception '你不在这一局里'; end if;
  if exists (select 1 from public.app_rooms where id = p_room and closed) then raise exception '这一局已经结束了，只能看'; end if;
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 200 then raise exception 'key 要是 1–200 字'; end if;
  if p_value is null then raise exception 'value 不能是空（要删用 remove）'; end if;
  if pg_column_size(p_value) > 65536 then raise exception '这个值太大（单个最多 64 KB）'; end if;
  if not exists (select 1 from public.app_room_data where room_id = p_room and key = p_key)
     and (select count(*) from public.app_room_data where room_id = p_room) >= 500 then
    raise exception '这一局的键太多了（最多 500 个）';
  end if;
  if p_if_rev is null then
    insert into public.app_room_data (room_id, key, value, rev, updated_by) values (p_room, p_key, p_value, 1, v_uid)
      on conflict (room_id, key) do update set value = excluded.value, rev = public.app_room_data.rev + 1, updated_by = v_uid, updated_at = now()
      returning rev into v_rev;
  elsif p_if_rev = 0 then
    insert into public.app_room_data (room_id, key, value, rev, updated_by) values (p_room, p_key, p_value, 1, v_uid)
      on conflict (room_id, key) do nothing
      returning rev into v_rev;
  else
    update public.app_room_data set value = p_value, rev = rev + 1, updated_by = v_uid, updated_at = now()
     where room_id = p_room and key = p_key and rev = p_if_rev
     returning rev into v_rev;
  end if;
  if v_rev is null then
    select value, rev into v_cur, v_cur_rev from public.app_room_data where room_id = p_room and key = p_key;
    return jsonb_build_object('ok', false, 'rev', coalesce(v_cur_rev, 0), 'value', v_cur);
  end if;
  update public.app_rooms set updated_at = now() where id = p_room;
  return jsonb_build_object('ok', true, 'rev', v_rev);
end $$;

create or replace function public.app_room_remove(p_room uuid, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if not public.is_room_member(p_room, v_uid) then raise exception '你不在这一局里'; end if;
  if exists (select 1 from public.app_rooms where id = p_room and closed) then raise exception '这一局已经结束了，只能看'; end if;
  delete from public.app_room_data where room_id = p_room and key = p_key;
end $$;

-- 叫人：成员、没关房；同人同房 10 秒一条、每小时 60 条——超了回 false（提醒丢一条不该让游戏报错）
create or replace function public.app_room_ping(p_room uuid, p_text text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_text text := left(btrim(coalesce(p_text, '')), 80);
begin
  if v_uid is null then raise exception '还没登录'; end if;
  if not public.is_room_member(p_room, v_uid) then raise exception '你不在这一局里'; end if;
  if exists (select 1 from public.app_rooms where id = p_room and closed) then return false; end if;
  if v_text = '' then raise exception '要说点什么'; end if;
  if exists (select 1 from public.app_room_pings where room_id = p_room and from_uid = v_uid and created_at > now() - interval '10 seconds') then return false; end if;
  if (select count(*) from public.app_room_pings where room_id = p_room and from_uid = v_uid and created_at > now() - interval '1 hour') >= 60 then return false; end if;
  insert into public.app_room_pings (room_id, from_uid, text) values (p_room, v_uid, v_text);
  return true;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'app_room_create(uuid, text)', 'app_room_invite(uuid, uuid)', 'app_room_join(uuid)', 'app_room_leave(uuid)',
    'app_room_set(uuid, text, jsonb, bigint)', 'app_room_remove(uuid, text)', 'app_room_ping(uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
  end loop;
end $$;
grant execute on function public.app_room_create(uuid, text) to authenticated;
grant execute on function public.app_room_invite(uuid, uuid) to authenticated;
grant execute on function public.app_room_join(uuid) to authenticated;
grant execute on function public.app_room_leave(uuid) to authenticated;
grant execute on function public.app_room_set(uuid, text, jsonb, bigint) to authenticated;
grant execute on function public.app_room_remove(uuid, text) to authenticated;
grant execute on function public.app_room_ping(uuid, text) to authenticated;

-- 跑房主那一版：成员能读房主钉住的那一版清单与文件（别的版本、别的应用仍读不到）
drop policy if exists app_versions_select_room on public.app_versions;
create policy app_versions_select_room on public.app_versions for select to authenticated using (
  exists (select 1 from public.app_rooms r
           where r.host_app_id = app_versions.app_id and r.host_version = app_versions.version
             and public.is_room_member(r.id, auth.uid()))
);
drop policy if exists "otto_apps_select_room" on storage.objects;
create policy "otto_apps_select_room" on storage.objects for select to authenticated using (
  bucket_id = 'otto-apps' and exists (
    select 1 from public.app_rooms r
     where (storage.foldername(name))[1] = r.host_uid::text
       and (storage.foldername(name))[2] = r.host_app_id::text
       and (storage.foldername(name))[3] = r.host_version::text
       and public.is_room_member(r.id, auth.uid())
  )
);

-- 即时消息：私有 broadcast 频道 room:<id>，只许 joined 成员收发
drop policy if exists "app_room_broadcast_select" on realtime.messages;
create policy "app_room_broadcast_select" on realtime.messages for select to authenticated using (
  realtime.messages.extension = 'broadcast' and public.room_topic_member(realtime.topic(), auth.uid())
);
drop policy if exists "app_room_broadcast_insert" on realtime.messages;
create policy "app_room_broadcast_insert" on realtime.messages for insert to authenticated with check (
  realtime.messages.extension = 'broadcast' and public.room_topic_member(realtime.topic(), auth.uid())
);

-- 变更推送：数据与名单给成员（postgres_changes 过 RLS），pings 给 runtime（service role）
do $$
declare t text;
begin
  foreach t in array array['app_room_data', 'app_room_members', 'app_room_pings'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
```

- [ ] **Step 4: 结构验收 SQL**（逐条 PASS，形状同 `0054_friend_tiers.check.sql`）

```sql
-- supabase/checks/0067_app_rooms.check.sql —— 跑完迁移后执行，每行都要 PASS（Management API 一次只回最后一条：逐条发）
select case when count(*) = 4 then 'PASS' else 'FAIL: ' || count(*) end as "四张表都在且开了 RLS"
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('app_rooms', 'app_room_members', 'app_room_data', 'app_room_pings') and c.relrowsecurity;

select case when count(*) = 7 then 'PASS' else 'FAIL: ' || count(*) end as "七个 RPC 都是 security definer"
  from pg_proc where proname in ('app_room_create', 'app_room_invite', 'app_room_join', 'app_room_leave', 'app_room_set', 'app_room_remove', 'app_room_ping') and prosecdef;

select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) end as "没有给 authenticated 的写策略"
  from pg_policies where tablename in ('app_rooms', 'app_room_members', 'app_room_data', 'app_room_pings') and cmd <> 'SELECT';

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "app_versions 房间放行策略在"
  from pg_policies where tablename = 'app_versions' and policyname = 'app_versions_select_room';

select case when count(*) = 1 then 'PASS' else 'FAIL: ' || count(*) end as "otto-apps 桶房间放行策略在"
  from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'otto_apps_select_room';

select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) end as "broadcast 收发两条策略在"
  from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname in ('app_room_broadcast_select', 'app_room_broadcast_insert');

select case when count(*) = 3 then 'PASS' else 'FAIL: ' || count(*) end as "三张表进了 supabase_realtime"
  from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('app_room_data', 'app_room_members', 'app_room_pings');
```

- [ ] **Step 5: 行为验收 SQL**（一个 DO 块；`A` = dev qq 号、`B` = 主号（A 的好友）、`C` = herz 号（不是 A 的好友）；`APP` = A 名下一个已打出版本的应用；结尾抛 `ALL PASS` 让整笔回滚——生产库上不留痕迹）

```sql
-- supabase/checks/0067_app_rooms.behavior.sql —— 扮人跑一遍房间的规矩。**整笔回滚**：结尾故意 raise，结果在报错文本里。
-- 跑前把 :B / :C 两个占位换成真 uuid（select id from auth.users where id::text like '32c6716a%' / '009d3d63%' 现查）；
-- A/B 是好友、C 不是 A 的好友、APP 是 A 名下 current_version ≥ 1 的应用。
do $$
declare
  a uuid := '2819d0bb-933b-499d-be44-2bb51b5a8391';
  b uuid := ':B';
  c uuid := ':C';
  app uuid := '0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b';
  r uuid; res jsonb; n int; ok boolean;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  r := public.app_room_create(app, '测试局');
  perform public.app_room_invite(r, b);
  begin perform public.app_room_invite(r, c); raise exception 'FAIL: 非好友邀得进'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  res := public.app_room_set(r, 'board', '{"x":1}'::jsonb, 0);
  if (res->>'ok')::boolean is not true or (res->>'rev')::int <> 1 then raise exception 'FAIL: 首写 %', res; end if;

  -- B 被邀未加入：读不到数据、写不进
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.app_room_data where room_id = r;
  if n <> 0 then raise exception 'FAIL: 未加入读得到数据'; end if;
  begin perform public.app_room_set(r, 'board', '{"x":2}'::jsonb); raise exception 'FAIL: 未加入写得进'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform public.app_room_join(r);
  select count(*) into n from public.app_room_data where room_id = r;
  if n <> 1 then raise exception 'FAIL: 加入后读不到数据'; end if;
  select count(*) into n from public.app_versions v join public.app_rooms x on x.host_app_id = v.app_id and x.host_version = v.version where x.id = r;
  if n <> 1 then raise exception 'FAIL: 成员读不到房主那一版'; end if;
  -- if_rev 冲突回现值
  res := public.app_room_set(r, 'board', '{"x":3}'::jsonb, 5);
  if (res->>'ok')::boolean is not false or (res->>'rev')::int <> 1 or res->'value' <> '{"x":1}'::jsonb then raise exception 'FAIL: if_rev 冲突 %', res; end if;
  res := public.app_room_set(r, 'board', '{"x":3}'::jsonb, 1);
  if (res->>'rev')::int <> 2 then raise exception 'FAIL: if_rev 命中 %', res; end if;
  -- ping 限速
  ok := public.app_room_ping(r, '轮到你了');
  if not ok then raise exception 'FAIL: 第一条 ping'; end if;
  ok := public.app_room_ping(r, '再叫一次');
  if ok then raise exception 'FAIL: 10 秒内第二条 ping 没被限'; end if;
  -- broadcast 判据
  if not public.room_topic_member('room:' || r, b) then raise exception 'FAIL: 成员进不了频道'; end if;
  if public.room_topic_member('room:' || r, c) then raise exception 'FAIL: 非成员进得了频道'; end if;
  if public.room_topic_member('room:nope', b) then raise exception 'FAIL: 坏频道名'; end if;

  -- C：什么都读不到
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  select count(*) into n from public.app_rooms where id = r;
  if n <> 0 then raise exception 'FAIL: 外人看得到房间'; end if;
  select count(*) into n from public.app_room_pings;
  if n <> 0 then raise exception 'FAIL: 客户端读得到 pings'; end if;

  -- 房主离开 = 关房；关了只读
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.app_room_leave(r);
  begin perform public.app_room_set(r, 'board', '{"x":9}'::jsonb); raise exception 'FAIL: 关房后写得进'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  select count(*) into n from public.app_room_data where room_id = r;
  if n <> 1 then raise exception 'FAIL: 关房后读不到'; end if;

  raise exception 'ALL PASS（整笔回滚）';
end $$;
```

- [ ] **Step 6: 跑测试，确认绿**

Run: `npx vitest run tests/docs/migrationAppRooms.test.ts`
Expected: PASS（6 条）

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0067_app_rooms.sql supabase/checks/0067_app_rooms.check.sql supabase/checks/0067_app_rooms.behavior.sql tests/docs/migrationAppRooms.test.ts
git commit -m "feat(apps): migration 0067——应用的房间：表、RPC、RLS、跑房主那一版的读放行、broadcast 策略（#1675）"
```

---

### Task 2: `src/shared/appRoom.ts`（纯逻辑）

**Files:**
- Create: `src/shared/appRoom.ts`
- Test: `tests/shared/appRoom.test.ts`

**Interfaces:**
- Consumes: `AppShareCard` / `APP_CARD_KIND` / `decodeAppCard` / `appShareMarker`（`src/shared/appCard.ts`）、`AppRow`（`src/shared/apps.ts`）、`DM_BODY_MAX`（`src/shared/contactCard.ts`）
- Produces:
  ```ts
  export const ROOM_MEMBERS_MAX = 8, ROOM_KEYS_MAX = 500, ROOM_VALUE_BYTES_MAX = 65536, ROOM_KEY_MAX = 200,
    ROOM_MSG_BYTES_MAX = 4096, ROOM_MSG_PER_SEC = 20, ROOM_PING_TEXT_MAX = 80, ROOM_TITLE_MAX = 40;
  export type RoomMemberStatus = "invited" | "joined" | "left";
  export interface RoomRow { id: string; hostUid: string; hostAppId: string; hostVersion: number; familyId: string; title: string; closed: boolean; updatedTs: number }
  export interface RoomMember { uid: string; status: RoomMemberStatus }
  export interface RoomEntry { key: string; value: unknown; rev: number; by: string | null }
  export type RoomSetResult = { ok: true; rev: number } | { ok: false; rev: number; value: unknown };
  export interface RoomInvite { id: string; title: string }
  export function roomRowOf(raw: unknown): RoomRow | null
  export function roomMemberOf(raw: unknown): RoomMember | null
  export function roomEntryOf(raw: unknown): RoomEntry | null
  export function roomSetResultOf(raw: unknown): RoomSetResult | null
  export const roomTopic: (roomId: string) => string            // "room:<id>"
  export function encodeRoomInvite(card: AppShareCard, room: RoomInvite): string
  export function decodeRoomInvite(body: string): { card: AppShareCard; room: RoomInvite } | null
  export function roomInvitePreview(card: AppShareCard): string // "[邀请] <icon> <name>"
  export function familyOf(app: AppRow): string                 // share:<id> → id；否则 app.id
  export function myAppForHost(apps: readonly AppRow[], hostAppId: string): AppRow | null
  export function createRateGate(perSec: number, now?: () => number): () => boolean
  export function roomKeyOk(k: unknown): k is string
  export function jsonBytes(v: unknown): number                 // JSON.stringify 的 UTF-8 字节数；序列化不了回 Infinity
  ```

- [ ] **Step 1: 写测试（先红）**

```ts
// tests/shared/appRoom.test.ts
import { describe, expect, it } from "vitest";
import { decodeAppCard, encodeAppCard, type AppShareCard } from "../../src/shared/appCard.js";
import type { AppRow } from "../../src/shared/apps.js";
import {
  createRateGate, decodeRoomInvite, encodeRoomInvite, familyOf, jsonBytes, myAppForHost, roomEntryOf, roomInvitePreview,
  roomKeyOk, roomMemberOf, roomRowOf, roomSetResultOf, roomTopic,
} from "../../src/shared/appRoom.js";

const U1 = "2819d0bb-933b-499d-be44-2bb51b5a8391";
const APP = "0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b";
const ROOM = "11111111-2222-4333-8444-555555555555";
const card: AppShareCard = { appId: APP, version: 2, name: "五子棋", icon: "⚫", slug: "gomoku", description: "", from: { uid: U1, name: "Stan" } };
const app = (o: Partial<AppRow>): AppRow => ({ id: APP, workspaceId: "w", ownerUid: U1, slug: "gomoku", name: "五子棋", icon: "⚫", description: "", currentVersion: 1, createdByAgent: "a_x", updatedTs: 0, ...o });

describe("appRoom", () => {
  it("邀请信封：应用卡多一格 room；老解码器仍当应用卡认", () => {
    const body = encodeRoomInvite(card, { id: ROOM, title: "第 3 局" });
    expect(decodeRoomInvite(body)).toEqual({ card, room: { id: ROOM, title: "第 3 局" } });
    expect(decodeAppCard(body)).toEqual(card); // 老手机 / 老 runtime 的路
    expect(decodeRoomInvite(encodeAppCard(card))).toBeNull(); // 普通应用卡不是邀请
    expect(decodeRoomInvite(body.replace(ROOM, "nope"))).toBeNull();
    expect(roomInvitePreview(card)).toBe("[邀请] ⚫ 五子棋");
  });
  it("行解析：形状不对回 null", () => {
    expect(roomRowOf({ id: ROOM, host_uid: U1, host_app_id: APP, host_version: 2, family_id: APP, title: "局", closed: false, updated_at: "2026-10-05T00:00:00Z" }))
      .toEqual({ id: ROOM, hostUid: U1, hostAppId: APP, hostVersion: 2, familyId: APP, title: "局", closed: false, updatedTs: Date.parse("2026-10-05T00:00:00Z") });
    expect(roomRowOf({ id: ROOM })).toBeNull();
    expect(roomMemberOf({ uid: U1, status: "joined" })).toEqual({ uid: U1, status: "joined" });
    expect(roomMemberOf({ uid: U1, status: "boss" })).toBeNull();
    expect(roomEntryOf({ key: "board", value: { x: 1 }, rev: "3", updated_by: U1 })).toEqual({ key: "board", value: { x: 1 }, rev: 3, by: U1 });
    expect(roomSetResultOf({ ok: true, rev: 2 })).toEqual({ ok: true, rev: 2 });
    expect(roomSetResultOf({ ok: false, rev: 1, value: { x: 1 } })).toEqual({ ok: false, rev: 1, value: { x: 1 } });
    expect(roomSetResultOf("nope")).toBeNull();
  });
  it("一家子：副本的源 / 原版自己；找我名下对应房主应用的那一份", () => {
    expect(familyOf(app({}))).toBe(APP);
    const mine = app({ id: "c0000000-0000-4000-8000-000000000000", createdByAgent: `share:${APP}` });
    expect(familyOf(mine)).toBe(APP);
    expect(myAppForHost([mine], APP)).toBe(mine);
    expect(myAppForHost([app({})], APP)?.id).toBe(APP);
    expect(myAppForHost([], APP)).toBeNull();
  });
  it("频道名、键、字节数、速率闸", () => {
    expect(roomTopic(ROOM)).toBe(`room:${ROOM}`);
    expect(roomKeyOk("a")).toBe(true);
    expect(roomKeyOk("")).toBe(false);
    expect(roomKeyOk("x".repeat(201))).toBe(false);
    expect(jsonBytes({ a: "中" })).toBe(new TextEncoder().encode(JSON.stringify({ a: "中" })).length);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonBytes(cyclic)).toBe(Infinity);
    let t = 0;
    const gate = createRateGate(2, () => t);
    expect([gate(), gate(), gate()]).toEqual([true, true, false]);
    t = 1001;
    expect(gate()).toBe(true);
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/appRoom.test.ts`
Expected: FAIL（Cannot find module appRoom.js）

- [ ] **Step 3: 实现**

```ts
// src/shared/appRoom.ts
// appRoom —— Otto 应用的房间（#1675，spec docs/superpowers/specs/2026-10-05-otto-app-rooms-design.md）的纯逻辑：
// 限额常量（与 migration 0067 的 RPC 一致）、行解析（字节来自网络，逐格验）、邀请信封（应用卡多一格 room——不进位 cs 协议）、
// 「一家子」（副本认源）、即时消息的速率闸。IO 在 appRoomApi.ts。
import { APP_CARD_KIND, appShareMarker, decodeAppCard, type AppShareCard } from "./appCard.js";
import type { AppRow } from "./apps.js";
import { DM_BODY_MAX } from "./contactCard.js";

export const ROOM_MEMBERS_MAX = 8;
export const ROOM_KEYS_MAX = 500;
export const ROOM_VALUE_BYTES_MAX = 65536;
export const ROOM_KEY_MAX = 200;
export const ROOM_MSG_BYTES_MAX = 4096;
export const ROOM_MSG_PER_SEC = 20;
export const ROOM_PING_TEXT_MAX = 80;
export const ROOM_TITLE_MAX = 40;

export type RoomMemberStatus = "invited" | "joined" | "left";
export interface RoomRow { id: string; hostUid: string; hostAppId: string; hostVersion: number; familyId: string; title: string; closed: boolean; updatedTs: number }
export interface RoomMember { uid: string; status: RoomMemberStatus }
export interface RoomEntry { key: string; value: unknown; rev: number; by: string | null }
export type RoomSetResult = { ok: true; rev: number } | { ok: false; rev: number; value: unknown };
export interface RoomInvite { id: string; title: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rec = (raw: unknown): Record<string, unknown> | null => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);

export function roomRowOf(raw: unknown): RoomRow | null {
  const o = rec(raw);
  if (o === null) return null;
  const id = uuid(o.id), hostUid = uuid(o.host_uid), hostAppId = uuid(o.host_app_id), familyId = uuid(o.family_id), hostVersion = int(o.host_version);
  if (id === null || hostUid === null || hostAppId === null || familyId === null || hostVersion === null || hostVersion < 1) return null;
  if (typeof o.title !== "string" || o.title === "" || typeof o.closed !== "boolean") return null;
  const ts = typeof o.updated_at === "string" ? Date.parse(o.updated_at) : NaN;
  return { id, hostUid, hostAppId, hostVersion, familyId, title: o.title, closed: o.closed, updatedTs: Number.isNaN(ts) ? 0 : ts };
}

export function roomMemberOf(raw: unknown): RoomMember | null {
  const o = rec(raw);
  const uid = o === null ? null : uuid(o.uid);
  if (o === null || uid === null) return null;
  return o.status === "invited" || o.status === "joined" || o.status === "left" ? { uid, status: o.status } : null;
}

export function roomEntryOf(raw: unknown): RoomEntry | null {
  const o = rec(raw);
  if (o === null || !roomKeyOk(o.key) || !("value" in o)) return null;
  const rev = int(o.rev);
  if (rev === null) return null;
  return { key: o.key, value: o.value, rev, by: uuid(o.updated_by) };
}

export function roomSetResultOf(raw: unknown): RoomSetResult | null {
  const o = rec(raw);
  const rev = o === null ? null : int(o.rev);
  if (o === null || rev === null) return null;
  if (o.ok === true) return { ok: true, rev };
  if (o.ok === false) return { ok: false, rev, value: o.value ?? null };
  return null;
}

export const roomTopic = (roomId: string): string => `room:${roomId}`;

export function encodeRoomInvite(card: AppShareCard, room: RoomInvite): string {
  const body = JSON.stringify({ otto: APP_CARD_KIND, v: 1, card, room: { id: room.id, title: room.title.slice(0, ROOM_TITLE_MAX) } });
  if (body.length > DM_BODY_MAX) throw new Error("这个应用的说明太长，发不了邀请");
  return body;
}

/** 认得出回 {card, room}；普通应用卡（没有 room）/ 别的信封回 null。card 那一半复用 decodeAppCard 的严格判 */
export function decodeRoomInvite(body: string): { card: AppShareCard; room: RoomInvite } | null {
  const card = decodeAppCard(body);
  if (card === null) return null;
  let env: unknown;
  try {
    env = JSON.parse(body);
  } catch {
    return null;
  }
  const r = rec(rec(env)?.room);
  const id = r === null ? null : uuid(r.id);
  if (r === null || id === null || typeof r.title !== "string" || r.title === "" || r.title.length > ROOM_TITLE_MAX) return null;
  return { card, room: { id, title: r.title } };
}

export const roomInvitePreview = (card: AppShareCard): string => `[邀请] ${card.icon} ${card.name}`;

/** 这个应用属于哪一家：副本（share:<源>）认源，原版认自己。同 migration 0067 app_room_create 里 family 的算法 */
export function familyOf(app: AppRow): string {
  const m = /^share:([0-9a-f-]{36})$/i.exec(app.createdByAgent);
  return m !== null ? m[1]!.toLowerCase() : app.id;
}

/** 我名下对应房主那个应用的一份：房主就是我（同一个 id）或我手里是它的副本 */
export function myAppForHost(apps: readonly AppRow[], hostAppId: string): AppRow | null {
  return apps.find((a) => a.id === hostAppId) ?? apps.find((a) => a.createdByAgent === appShareMarker(hostAppId)) ?? null;
}

/** 每秒最多 perSec 次：滑动一秒的窗 */
export function createRateGate(perSec: number, now: () => number = () => Date.now()): () => boolean {
  const hits: number[] = [];
  return () => {
    const t = now();
    while (hits.length > 0 && t - hits[0]! >= 1000) hits.shift();
    if (hits.length >= perSec) return false;
    hits.push(t);
    return true;
  };
}

export const roomKeyOk = (k: unknown): k is string => typeof k === "string" && k.length >= 1 && k.length <= ROOM_KEY_MAX;

export function jsonBytes(v: unknown): number {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? Infinity : new TextEncoder().encode(s).length;
  } catch {
    return Infinity;
  }
}
```

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/shared/appRoom.test.ts`
Expected: PASS（4 条）

- [ ] **Step 5: Commit**

```bash
git add src/shared/appRoom.ts tests/shared/appRoom.test.ts
git commit -m "feat(apps): appRoom 纯逻辑——限额、行解析、邀请信封（应用卡多一格 room）、一家子、速率闸（#1675）"
```

---

### Task 3: `src/shared/appRoomApi.ts`（客户端 IO）

**Files:**
- Create: `src/shared/appRoomApi.ts`
- Test: `tests/shared/appRoomApi.test.ts`

**Interfaces:**
- Consumes: Task 2 全部；`SupabaseClient`
- Produces:
  ```ts
  export async function createRoom(client: SupabaseClient, appId: string, title: string): Promise<string>
  export function inviteToRoom(client: SupabaseClient, roomId: string, uid: string): Promise<void>
  export function joinRoom(client: SupabaseClient, roomId: string): Promise<void>
  export function leaveRoom(client: SupabaseClient, roomId: string): Promise<void>
  export async function fetchRoom(client: SupabaseClient, roomId: string): Promise<RoomRow | null>
  export async function fetchMembers(client: SupabaseClient, roomId: string): Promise<RoomMember[] | null>
  export async function listRooms(client: SupabaseClient, familyId: string): Promise<RoomRow[] | null>
  export const roomData: {
    get(client, roomId: string, key: unknown): Promise<RoomEntry | null>;
    list(client, roomId: string, prefix: unknown): Promise<RoomEntry[]>;
    set(client, roomId: string, key: unknown, value: unknown, opts?: unknown): Promise<RoomSetResult>; // opts = { ifRev?: number }
    remove(client, roomId: string, key: unknown): Promise<void>;
  }
  export async function pingRoom(client: SupabaseClient, roomId: string, text: unknown): Promise<boolean>
  export interface RoomLinkHandlers { change(e: RoomEntry | { key: string; removed: true }): void; members(): void; message(from: string, msg: unknown): void; status?(s: string): void }
  export function subscribeRoom(client: SupabaseClient, roomId: string, selfUid: string, h: RoomLinkHandlers): { send(msg: unknown): Promise<void>; close(): void }
  ```
  抛错 = 没做成（桥把那句话回给应用）；读不到回 null（同 appsApi 的纪律）。

- [ ] **Step 1: 写测试（先红）**——用一个最小假 client 记下调了什么

```ts
// tests/shared/appRoomApi.test.ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRoom, pingRoom, roomData, subscribeRoom } from "../../src/shared/appRoomApi.js";

const ROOM = "11111111-2222-4333-8444-555555555555";
const U1 = "2819d0bb-933b-499d-be44-2bb51b5a8391";

function fakeClient(rpcReply: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const handlers: { filter: unknown; cb: (p: unknown) => void }[] = [];
  const sent: unknown[] = [];
  let broadcastCb: ((p: { payload: unknown }) => void) | null = null;
  const channel = {
    on(kind: string, filter: unknown, cb: (p: unknown) => void) {
      if (kind === "broadcast") broadcastCb = cb as (p: { payload: unknown }) => void;
      else handlers.push({ filter, cb });
      return channel;
    },
    subscribe() { return channel; },
    async send(m: unknown) { sent.push(m); return "ok"; },
  };
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) { calls.push({ fn, args }); return rpcReply(fn, args); },
    channel: () => channel,
    removeChannel: async () => "ok",
  } as unknown as SupabaseClient;
  return { client, calls, handlers, sent, fireBroadcast: (p: unknown) => broadcastCb?.({ payload: p }) };
}

describe("appRoomApi", () => {
  it("createRoom 走 app_room_create，回房间 id；RPC 报错就抛那句话", async () => {
    const f = fakeClient(() => ({ data: ROOM, error: null }));
    expect(await createRoom(f.client, "a", "第 1 局")).toBe(ROOM);
    expect(f.calls[0]).toEqual({ fn: "app_room_create", args: { p_app: "a", p_title: "第 1 局" } });
    const bad = fakeClient(() => ({ data: null, error: { message: "这个应用不是你的" } }));
    await expect(createRoom(bad.client, "a", "x")).rejects.toThrow("这个应用不是你的");
  });
  it("roomData.set：键 / 大小先在客户端拦；ifRev 传成 p_if_rev；冲突回 {ok:false}", async () => {
    const f = fakeClient(() => ({ data: { ok: false, rev: 4, value: { x: 1 } }, error: null }));
    await expect(roomData.set(f.client, ROOM, "", 1)).rejects.toThrow("key");
    await expect(roomData.set(f.client, ROOM, "k", "x".repeat(70_000))).rejects.toThrow("64 KB");
    expect(await roomData.set(f.client, ROOM, "board", { x: 2 }, { ifRev: 3 })).toEqual({ ok: false, rev: 4, value: { x: 1 } });
    expect(f.calls.at(-1)).toEqual({ fn: "app_room_set", args: { p_room: ROOM, p_key: "board", p_value: { x: 2 }, p_if_rev: 3 } });
  });
  it("pingRoom：空的抛；回 RPC 的布尔", async () => {
    const f = fakeClient(() => ({ data: false, error: null }));
    expect(await pingRoom(f.client, ROOM, "轮到你了")).toBe(false);
    await expect(pingRoom(f.client, ROOM, "  ")).rejects.toThrow();
  });
  it("subscribeRoom：数据变更 → change；删除 → removed；broadcast → message；send 过大小限", async () => {
    const f = fakeClient(() => ({ data: null, error: null }));
    const got: unknown[] = [];
    const link = subscribeRoom(f.client, ROOM, U1, {
      change: (e) => got.push(["change", e]),
      members: () => got.push(["members"]),
      message: (from, msg) => got.push(["message", from, msg]),
    });
    const dataH = f.handlers.find((h) => JSON.stringify(h.filter).includes("app_room_data"))!;
    dataH.cb({ eventType: "UPDATE", new: { key: "board", value: { x: 1 }, rev: 2, updated_by: U1 } });
    dataH.cb({ eventType: "DELETE", old: { room_id: ROOM, key: "board" } });
    f.handlers.find((h) => JSON.stringify(h.filter).includes("app_room_members"))!.cb({ eventType: "UPDATE" });
    f.fireBroadcast({ from: "other", msg: { go: 1 } });
    expect(got).toEqual([
      ["change", { key: "board", value: { x: 1 }, rev: 2, by: U1 }],
      ["change", { key: "board", removed: true }],
      ["members"],
      ["message", "other", { go: 1 }],
    ]);
    await link.send({ hi: 1 });
    expect(f.sent[0]).toEqual({ type: "broadcast", event: "msg", payload: { from: U1, msg: { hi: 1 } } });
    await expect(link.send("x".repeat(5000))).rejects.toThrow("4 KB");
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/appRoomApi.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/shared/appRoomApi.ts
// appRoomApi —— 房间在客户端这一侧的 IO（#1675）：七个 RPC 的包装、读（RLS 已按成员圈）、订阅（postgres_changes + 私有 broadcast）。
// 判据在 appRoom.ts 与 migration 0067；这里先在客户端把明显不对的拦下（省一趟），服务端照样再判一遍。
// 抛错 = 没做成（桥把那句话回给应用）；读不到回 null。
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createRateGate, jsonBytes, roomEntryOf, roomKeyOk, roomMemberOf, roomRowOf, roomSetResultOf, roomTopic,
  ROOM_MSG_BYTES_MAX, ROOM_MSG_PER_SEC, ROOM_PING_TEXT_MAX, ROOM_TITLE_MAX, ROOM_VALUE_BYTES_MAX,
  type RoomEntry, type RoomMember, type RoomRow, type RoomSetResult,
} from "./appRoom.js";

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function createRoom(client: SupabaseClient, appId: string, title: string): Promise<string> {
  const id = await rpc<unknown>(client, "app_room_create", { p_app: appId, p_title: title.slice(0, ROOM_TITLE_MAX) });
  if (typeof id !== "string") throw new Error("房间没建出来");
  return id;
}
export const inviteToRoom = (client: SupabaseClient, roomId: string, uid: string): Promise<void> => rpc<void>(client, "app_room_invite", { p_room: roomId, p_uid: uid });
export const joinRoom = (client: SupabaseClient, roomId: string): Promise<void> => rpc<void>(client, "app_room_join", { p_room: roomId });
export const leaveRoom = (client: SupabaseClient, roomId: string): Promise<void> => rpc<void>(client, "app_room_leave", { p_room: roomId });

export async function fetchRoom(client: SupabaseClient, roomId: string): Promise<RoomRow | null> {
  try {
    const res = await client.from("app_rooms").select("*").eq("id", roomId).maybeSingle();
    return res.error || res.data === null ? null : roomRowOf(res.data);
  } catch {
    return null;
  }
}

export async function fetchMembers(client: SupabaseClient, roomId: string): Promise<RoomMember[] | null> {
  try {
    const res = await client.from("app_room_members").select("uid,status").eq("room_id", roomId);
    if (res.error) return null;
    return ((res.data ?? []) as unknown[]).map(roomMemberOf).filter((m): m is RoomMember => m !== null);
  } catch {
    return null;
  }
}

export async function listRooms(client: SupabaseClient, familyId: string): Promise<RoomRow[] | null> {
  try {
    const res = await client.from("app_rooms").select("*").eq("family_id", familyId).order("updated_at", { ascending: false }).limit(50);
    if (res.error) return null;
    return ((res.data ?? []) as unknown[]).map(roomRowOf).filter((r): r is RoomRow => r !== null);
  } catch {
    return null;
  }
}

const needKey = (k: unknown): string => {
  if (!roomKeyOk(k)) throw new Error("key 要是 1–200 字的字符串");
  return k;
};

export const roomData = {
  async get(client: SupabaseClient, roomId: string, key: unknown): Promise<RoomEntry | null> {
    const k = needKey(key);
    const res = await client.from("app_room_data").select("key,value,rev,updated_by").eq("room_id", roomId).eq("key", k).maybeSingle();
    if (res.error) throw new Error(res.error.message);
    return res.data === null ? null : roomEntryOf(res.data);
  },
  async list(client: SupabaseClient, roomId: string, prefix: unknown): Promise<RoomEntry[]> {
    const p = typeof prefix === "string" ? prefix : "";
    let q = client.from("app_room_data").select("key,value,rev,updated_by").eq("room_id", roomId).order("key").limit(500);
    if (p !== "") q = q.like("key", `${p.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
    const res = await q;
    if (res.error) throw new Error(res.error.message);
    return ((res.data ?? []) as unknown[]).map(roomEntryOf).filter((e): e is RoomEntry => e !== null);
  },
  async set(client: SupabaseClient, roomId: string, key: unknown, value: unknown, opts?: unknown): Promise<RoomSetResult> {
    const k = needKey(key);
    if (value === undefined) throw new Error("value 不能是 undefined（要删用 remove）");
    if (jsonBytes(value) > ROOM_VALUE_BYTES_MAX) throw new Error("这个值太大（单个最多 64 KB）");
    const ifRev = typeof opts === "object" && opts !== null ? (opts as { ifRev?: unknown }).ifRev : undefined;
    if (ifRev !== undefined && (typeof ifRev !== "number" || !Number.isInteger(ifRev) || ifRev < 0)) throw new Error("ifRev 要是不小于 0 的整数");
    const out = roomSetResultOf(await rpc<unknown>(client, "app_room_set", { p_room: roomId, p_key: k, p_value: value, p_if_rev: ifRev ?? null }));
    if (out === null) throw new Error("写入的回执读不出来");
    return out;
  },
  async remove(client: SupabaseClient, roomId: string, key: unknown): Promise<void> {
    await rpc<void>(client, "app_room_remove", { p_room: roomId, p_key: needKey(key) });
  },
};

export async function pingRoom(client: SupabaseClient, roomId: string, text: unknown): Promise<boolean> {
  const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, ROOM_PING_TEXT_MAX) : "";
  if (t === "") throw new Error("要说点什么");
  return (await rpc<unknown>(client, "app_room_ping", { p_room: roomId, p_text: t })) === true;
}

export interface RoomLinkHandlers {
  change(e: RoomEntry | { key: string; removed: true }): void;
  members(): void;
  message(from: string, msg: unknown): void;
  status?(s: string): void;
}

/** 订一间房：数据变更、名单变化、即时消息。send 过速率闸与 4 KB 上限；自己发的 broadcast 不回送（self: false） */
export function subscribeRoom(client: SupabaseClient, roomId: string, selfUid: string, h: RoomLinkHandlers): { send(msg: unknown): Promise<void>; close(): void } {
  const gate = createRateGate(ROOM_MSG_PER_SEC);
  const filter = `room_id=eq.${roomId}`;
  const channel = client
    .channel(roomTopic(roomId), { config: { private: true, broadcast: { self: false } } })
    .on("postgres_changes", { event: "*", schema: "public", table: "app_room_data", filter }, (p: { eventType?: string; new?: unknown; old?: unknown }) => {
      if (p.eventType === "DELETE") {
        const key = (p.old as { key?: unknown } | undefined)?.key;
        if (typeof key === "string") h.change({ key, removed: true });
        return;
      }
      const e = roomEntryOf(p.new);
      if (e !== null) h.change(e);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "app_room_members", filter }, () => h.members())
    .on("broadcast", { event: "msg" }, (p: { payload?: unknown }) => {
      const o = p.payload as { from?: unknown; msg?: unknown } | undefined;
      if (o !== undefined && typeof o.from === "string") h.message(o.from, o.msg ?? null);
    })
    .subscribe((s: string) => h.status?.(s));
  return {
    async send(msg) {
      if (jsonBytes(msg) > ROOM_MSG_BYTES_MAX) throw new Error("即时消息太大（最多 4 KB）");
      if (!gate()) throw new Error("发得太快了（每秒最多 20 条）");
      await channel.send({ type: "broadcast", event: "msg", payload: { from: selfUid, msg } });
    },
    close() {
      void client.removeChannel(channel);
    },
  };
}
```

（supabase-js 的 `.on("postgres_changes", …)` 重载类型严格：若 tsc 对回调参数类型报错，回调参数按 `RealtimePostgresChangesPayload<Record<string, unknown>>` 标注、在函数体里再收窄；不要 `as any`。私有频道要求客户端已带用户 JWT：手机端 `supabase` 客户端登录后自动 `realtime.setAuth`；若 Task 11 发现收不到 broadcast，在 `subscribeRoom` 前 `await client.realtime.setAuth()`——那时再改并补测试。）

- [ ] **Step 4: 跑，确认绿 + tsc**

Run: `npx vitest run tests/shared/appRoomApi.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/appRoomApi.ts tests/shared/appRoomApi.test.ts
git commit -m "feat(apps): appRoomApi——房间 RPC 包装、读、订阅（数据变更 + 名单 + 私有 broadcast）（#1675）"
```

---

### Task 4: 桥 `otto.room` + 事件管线 + 能力 `room`

**Files:**
- Modify: `src/shared/apps.ts:19`（`APP_CAPABILITIES`）
- Modify: `src/shared/appBridge.ts`
- Test: `tests/shared/appBridge.test.ts`（追加）；`grep -rn "APP_CAPABILITIES\|capabilities" tests/shared/apps.test.ts`，有把清单写死的断言就跟着改

**Interfaces:**
- Produces:
  - `AppCapability` 多 `"room"`
  - `BridgeMethod` 多 `"room.current" | "room.create" | "room.invite" | "room.rooms" | "room.open" | "room.leave" | "room.get" | "room.list" | "room.set" | "room.remove" | "room.send" | "room.ping"`
  - `capabilityOf("room.*") === "room"`
  - `export function bridgeEventJs(name: string, payload: unknown): string` → `window.__ottoEvent(<name>, <json>); true;`
  - `APP_BRIDGE_JS` 里 `otto.room.{current,create,invite,rooms,open,leave,get,list,set,remove,send,ping}`、`otto.on(name, cb)` / `otto.off(name, cb)`、`window.__ottoEvent`

- [ ] **Step 1: 追加测试（先红）**

```ts
// tests/shared/appBridge.test.ts 末尾追加（bridgeEventJs、APP_CAPABILITIES 并进文件顶部的 import，别重复 import）
describe("房间（#1675）", () => {
  it("能力清单有 room；room.* 归 room；没声明就拒", () => {
    expect(APP_CAPABILITIES).toContain("room");
    expect(capabilityOf("room.set")).toBe("room");
    expect(capabilityOf("room.rooms")).toBe("room");
    expect(bridgeDenied("room.send", ["storage"])).toMatch("room");
    expect(bridgeDenied("room.send", ["room"])).toBeNull();
  });
  it("请求白名单认 room.*", () => {
    for (const m of ["room.current", "room.create", "room.invite", "room.rooms", "room.open", "room.leave", "room.get", "room.list", "room.set", "room.remove", "room.send", "room.ping"]) {
      expect(parseBridgeRequest(JSON.stringify({ id: "c1", method: m, args: [] }))?.method).toBe(m);
    }
  });
  it("注进去的 JS：otto.room 十二件 + on/off + __ottoEvent；事件分发到注册的回调、off 之后不再收", () => {
    const posted: string[] = [];
    const w: Record<string, unknown> = { ReactNativeWebView: { postMessage: (s: string) => posted.push(s) }, addEventListener: () => {} };
    new Function("window", APP_BRIDGE_JS)(w);
    const otto = w.otto as { room: Record<string, unknown>; on(n: string, cb: (p: unknown) => void): void; off(n: string, cb: (p: unknown) => void): void };
    for (const k of ["current", "create", "invite", "rooms", "open", "leave", "get", "list", "set", "remove", "send", "ping"]) expect(typeof otto.room[k]).toBe("function");
    const got: unknown[] = [];
    const cb = (p: unknown): void => { got.push(p); };
    otto.on("room.change", cb);
    (w.__ottoEvent as (n: string, p: unknown) => void)("room.change", { key: "b" });
    otto.off("room.change", cb);
    (w.__ottoEvent as (n: string, p: unknown) => void)("room.change", { key: "c" });
    expect(got).toEqual([{ key: "b" }]);
    void (otto.room.set as (k: string, v: unknown, o: unknown) => Promise<unknown>)("board", { x: 1 }, { ifRev: 2 });
    expect(JSON.parse(posted.at(-1)!)).toMatchObject({ method: "room.set", args: ["board", { x: 1 }, { ifRev: 2 }] });
  });
  it("bridgeEventJs：名字与载荷都过 JSON", () => {
    expect(bridgeEventJs("room.message", { from: "u", msg: "hi" })).toBe(`window.__ottoEvent("room.message", {"from":"u","msg":"hi"}); true;`);
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/appBridge.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/shared/apps.ts:19`：

```ts
export const APP_CAPABILITIES = ["storage", "ask", "share", "nav", "notify", "remind", "camera", "haptic", "room"] as const;
```

`src/shared/appBridge.ts` 的 `APP_BRIDGE_JS`：在 `window.otto = {` 之前插入事件管线：

```js
  // 宿主推下来的事件（#1675 房间）：宿主 injectJavaScript("window.__ottoEvent(name, payload)")，按名字分发给 otto.on 注册的回调
  var handlers = {};
  window.__ottoEvent = function (name, payload) {
    var hs = handlers[name];
    if (!hs) return;
    hs.slice().forEach(function (h) { try { h(payload); } catch (e) { report((e && e.message) || e); } });
  };
```

`window.otto = { … }` 里，原来的 `haptic: function () { return call("haptic", []); }`（末尾没逗号）改成下面整段：

```js
    haptic: function () { return call("haptic", []); },
    on: function (name, cb) { (handlers[name] = handlers[name] || []).push(cb); },
    off: function (name, cb) { var hs = handlers[name]; if (hs) handlers[name] = hs.filter(function (x) { return x !== cb; }); },
    room: {
      current: function () { return call("room.current", []); },
      create: function (o) { return call("room.create", [o || {}]); },
      invite: function () { return call("room.invite", []); },
      rooms: function () { return call("room.rooms", []); },
      open: function (id) { return call("room.open", [id]); },
      leave: function () { return call("room.leave", []); },
      get: function (k) { return call("room.get", [k]); },
      list: function (p) { return call("room.list", [p || ""]); },
      set: function (k, v, o) { return call("room.set", [k, v, o || {}]); },
      remove: function (k) { return call("room.remove", [k]); },
      send: function (m) { return call("room.send", [m]); },
      ping: function (t) { return call("room.ping", [t]); }
    }
```

类型与判据：

```ts
export type BridgeMethod =
  | "storage.get" | "storage.set" | "storage.list" | "storage.remove" | "ask" | "share" | "nav" | "back" | "haptic"
  | "room.current" | "room.create" | "room.invite" | "room.rooms" | "room.open" | "room.leave"
  | "room.get" | "room.list" | "room.set" | "room.remove" | "room.send" | "room.ping";
const METHODS: ReadonlySet<string> = new Set<BridgeMethod>([
  "storage.get", "storage.set", "storage.list", "storage.remove", "ask", "share", "nav", "back", "haptic",
  "room.current", "room.create", "room.invite", "room.rooms", "room.open", "room.leave",
  "room.get", "room.list", "room.set", "room.remove", "room.send", "room.ping",
]);

export function capabilityOf(method: BridgeMethod): AppCapability {
  if (method.startsWith("storage.")) return "storage";
  if (method.startsWith("room.")) return "room";
  if (method === "nav" || method === "back") return "nav";
  if (method === "ask") return "ask";
  if (method === "share") return "share";
  return "haptic";
}

/** 宿主推一个事件给应用（#1675）：名字与载荷都过 JSON；序列化不了的载荷推 null */
export function bridgeEventJs(name: string, payload: unknown): string {
  let v: string;
  try {
    v = JSON.stringify(payload === undefined ? null : payload) ?? "null";
  } catch {
    v = "null";
  }
  return `window.__ottoEvent(${JSON.stringify(name)}, ${v}); true;`;
}
```

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/shared/appBridge.test.ts tests/shared/apps.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/apps.ts src/shared/appBridge.ts tests/shared/appBridge.test.ts tests/shared/apps.test.ts
git commit -m "feat(apps): 桥多 otto.room 与 otto.on/off——新能力 room、宿主事件管线 __ottoEvent（#1675）"
```

---

### Task 5: build_app 的假桥与工具说明 + 两段提示词

**Files:**
- Modify: `services/runtime/src/buildAppTool.ts`（`APP_CHECK_JS` 的假回执、`description`）
- Modify: `src/shared/tierPrompt.ts`（L0 一句、appsLine 一句）
- Test: `tests/runtime/buildAppTool.test.ts`（追加）、`tests/shared/agentTier.test.ts`、`tests/runtime/l1Strength.test.ts`（追加断言）

**Interfaces:**
- Consumes: Task 4 的 `APP_BRIDGE_JS`（假桥原样 eval 它，`otto.room` 自动就有）

- [ ] **Step 1: 追加测试（先红）**

```ts
// tests/runtime/buildAppTool.test.ts 末尾追加（APP_CHECK_JS / createBuildAppTool / createInMemoryAppStore 若顶部已 import 就别重复）
describe("房间（#1675）", () => {
  it("jsdom 假桥：room.list / room.rooms 与 storage.list 一样回 []（用了房间的应用试开不因 null.map 报错）", () => {
    expect(APP_CHECK_JS).toContain(`["storage.list", "room.list", "room.rooms"].includes(m.method) ? [] : null`);
  });
  it("工具说明写了房间 API", () => {
    const def = createBuildAppTool({ agentId: "a", workspaceId: "w", ownerUid: "u", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), upload: async () => {}, store: createInMemoryAppStore(), card: () => {} }).def;
    for (const s of ["otto.room", "ifRev", "room.change", "ping"]) expect(def.description).toContain(s);
  });
});
```

`tests/shared/agentTier.test.ts` 的 L0 用例追加 `expect(p).toContain("和好友一起玩"); // #1675`；`tests/runtime/l1Strength.test.ts` 专员用例追加 `expect(withAdmin).toContain("otto.room"); // #1675`。

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/runtime/buildAppTool.test.ts tests/shared/agentTier.test.ts tests/runtime/l1Strength.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`buildAppTool.ts` 的 `APP_CHECK_JS` 里 `postMessage` 那一行回执换成：

```js
        w.ReactNativeWebView = { postMessage(raw) { try { const m = JSON.parse(raw); if (m && m.id) setTimeout(() => w.__ottoReply && w.__ottoReply(m.id, true, ["storage.list", "room.list", "room.rooms"].includes(m.method) ? [] : null), 5); } catch (_) {} } };
```

`description` 末尾（「打完主人聊天里会出一张卡，点开就能用。」之后）追加：

```ts
        `要和好友一起玩 / 一起记的，清单 capabilities 加 room，用 otto.room：current()（不在房间回 null）/ create({title}) / invite()（弹好友选择）/ rooms() / open(id) / leave()；` +
        `共享数据 get(key) / list(prefix) / set(key, value, {ifRev}) → {ok, rev} 或 {ok:false, rev, value}（回合制落子带 ifRev 防抢写，0 = 只在还没有时写）/ remove(key)；` +
        `即时消息 send(msg)（≤ 4 KB、每秒 ≤ 20 条）；ping(text) 推给其他成员（轮到谁了）；事件 otto.on('room.change' | 'room.message' | 'room.members', cb)。个人的东西仍放 otto.storage。`,
```

（原 description 是一串 `+` 拼接、最后一段以 `` ` `` 收尾带逗号；把最后那段的逗号去掉、接 `+` 再接上面三段。）

`tierPrompt.ts`：L0 那句「做应用（小工具…你自己不写页面。」之后插入：

```ts
      `和好友一起玩 / 一起记（对战、AA 账本、默契测试）也是应用域的活：应用有「房间」能邀好友进来，照常派。` +
```

appsLine 里「需求要联网」之前插入：

```
要和好友一起玩 / 一起记的，清单加 room、用 otto.room（建房 / 邀请 / 共享数据 set 带 ifRev / 即时消息 send / ping 叫人，API 见 build_app 的说明）；
```

- [ ] **Step 4: 跑，确认绿**

Run: `npx vitest run tests/runtime/buildAppTool.test.ts tests/shared/agentTier.test.ts tests/runtime/l1Strength.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/runtime/src/buildAppTool.ts src/shared/tierPrompt.ts tests/runtime/buildAppTool.test.ts tests/shared/agentTier.test.ts tests/runtime/l1Strength.test.ts
git commit -m "feat(apps): build_app 假桥认房间、工具说明写房间 API；管理员与应用专员知道房间（#1675）"
```

---

### Task 6: 手机宿主的房间模式（`MiniAppScreen`）

**Files:**
- Modify: `mobile/src/nav/types.ts:70`
- Modify: `mobile/src/apps/MiniAppScreen.tsx`
- Test: `tests/mobile/miniAppWiring.test.ts`（追加；同文件既有的「读源码钉住」口径）

**Interfaces:**
- Consumes: Task 2（`RoomRow` / `RoomMember` / `familyOf` / `encodeRoomInvite`）、Task 3（`fetchRoom` / `fetchMembers` / `listRooms` / `createRoom` / `inviteToRoom` / `leaveRoom` / `roomData` / `pingRoom` / `subscribeRoom`）、Task 4（`bridgeEventJs`）
- Produces: 路由 `MiniApp: { appId: string; share?: boolean; roomId?: string }`（Task 7、9 用）

- [ ] **Step 1: 追加接线测试（先红）**

```ts
// tests/mobile/miniAppWiring.test.ts 末尾追加
describe("房间模式（#1675）", () => {
  const src = read("mobile/src/apps/MiniAppScreen.tsx");
  it("路由多 roomId；有 roomId 时跑房主钉住的那一版", () => {
    expect(read("mobile/src/nav/types.ts")).toMatch(/MiniApp: \{ appId: string; share\?: boolean; roomId\?: string \};/);
    expect(src).toMatch(/const room = roomId === undefined \? null : await fetchRoom\(supabase, roomId\);/);
    expect(src).toMatch(/fetchAppVersion\(supabase, room\.hostAppId, room\.hostVersion\)/);
    expect(src).toMatch(/ensureAppFiles\(room\.hostUid, room\.hostAppId, room\.hostVersion, version\.files\)/);
  });
  it("个人 storage 仍落在我自己那份应用；room.* 走 appRoomApi；不在房间的数据操作拒", () => {
    expect(src).toMatch(/case "storage\.get": return appData\.get\(supabase, l\.app\.id, l\.uid, a0\);/);
    expect(src).toMatch(/case "room\.set": return roomData\.set\(supabase, needRoom\(l\)\.id, a0, a1, req\.args\[2\]\);/);
    expect(src).toMatch(/case "room\.ping": return pingRoom\(supabase, needRoom\(l\)\.id, a0\);/);
    expect(src).toMatch(/case "room\.rooms": return \(await listRooms\(supabase, familyOf\(l\.app\)\)\) \?\? \[\];/);
  });
  it("订阅推成 otto 事件；离开页面退订", () => {
    expect(src).toMatch(/subscribeRoom\(supabase, loaded\.room\.id, loaded\.uid, \{/);
    expect(src).toMatch(/bridgeEventJs\("room\.change", e\)/);
    expect(src).toMatch(/bridgeEventJs\("room\.message", \{ from, msg \}\)/);
    expect(src).toMatch(/return \(\) => link\.close\(\);/);
  });
  it("邀请：先 inviteToRoom 再发邀请信封", () => {
    expect(src).toMatch(/await inviteToRoom\(supabase, room\.id, p\.uid\);\s*await sendToFriend\(p\.uid, encodeRoomInvite\(/);
  });
});
```

（若该文件既有断言写死了 `MiniApp: \{ appId: string; share\?: boolean \};`，同一提交里改成带 `roomId?` 的新形状——那是跟着产品代码改的测试，不是删测试。）

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/mobile/miniAppWiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`mobile/src/nav/types.ts:70`：

```ts
  MiniApp: { appId: string; share?: boolean; roomId?: string };
```

`MiniAppScreen.tsx`（按下列顺序；文件其余行为不变）：

1. import：

```ts
import { encodeRoomInvite, familyOf, type RoomMember, type RoomRow } from "../../../src/shared/appRoom.js";
import { createRoom, fetchMembers, fetchRoom, inviteToRoom, leaveRoom, listRooms, pingRoom, roomData, subscribeRoom } from "../../../src/shared/appRoomApi.js";
import { APP_BRIDGE_JS, appAskText, appFixText, bridgeDenied, bridgeEventJs, bridgeReplyJs, parseBridgeError, parseBridgeRequest, type BridgeRequest } from "../../../src/shared/appBridge.js";
```

（替换原 appBridge 那一行。）

2. `Loaded` 与取房间的小函数：

```ts
type Loaded = { app: AppRow; version: AppVersionRow; dirUri: string; uid: string; room: RoomRow | null; members: RoomMember[] };

/** 数据类的 room.* 要在房间里才能调 */
function needRoom(l: Loaded): RoomRow {
  if (l.room === null) throw new Error("还没进房间——先 otto.room.create() 或从邀请进来");
  return l.room;
}
```

3. 加载 effect：`const { appId } = route.params;` → `const { appId, roomId } = route.params;`；取到 `app`、判完 `currentVersion` 之后，原来的取版本 / 落文件 / setLoaded 换成：

```ts
        const room = roomId === undefined ? null : await fetchRoom(supabase, roomId);
        if (roomId !== undefined && room === null) throw new Error("进不了这一局（你不在里面，或它已经没了）");
        const version = room === null
          ? await fetchAppVersion(supabase, app.id, app.currentVersion)
          : await fetchAppVersion(supabase, room.hostAppId, room.hostVersion);
        if (version === null) throw new Error("这一版的清单读不出来");
        const dir = room === null
          ? await ensureAppFiles(uid, app.id, version.version, version.files)
          : await ensureAppFiles(room.hostUid, room.hostAppId, room.hostVersion, version.files);
        const members = room === null ? [] : ((await fetchMembers(supabase, room.id)) ?? []);
        if (!alive) return;
        const l: Loaded = { app, version, dirUri: dir.uri, uid, room, members };
        setLoaded(l);
        loadedRef.current = l;
```

依赖数组 `[appId]` → `[appId, roomId]`。（`ensureAppFiles(uid, …)` 的第一个参数是**对象路径里的属主**——房间模式传房主 uid；本地目录按 `appVersionDir(hostAppId, hostVersion)` 落，和我自己那份不冲突。）

4. 选人框状态加 `mode` 与邀请回执：

```ts
  const [sharing, setSharing] = useState<{ key: number; visible: boolean; mode: "share" | "invite" } | null>(null);
  /** room.invite() 的回执在选人框关掉时给（选了谁 / 取消 = 空） */
  const inviteDone = useRef<((uids: string[]) => void) | null>(null);
  const roomLink = useRef<ReturnType<typeof subscribeRoom> | null>(null);
```

原有两处 `setSharing({ key: Date.now(), visible: true })` 补 `mode: "share"`。

5. `handle` 的 switch 里 `haptic` 之后追加：

```ts
      case "room.current": {
        const r = l.room;
        if (r === null) return null;
        const names = new Map((friends.rows ?? []).map((f) => [f.profile.id, friendName(f.profile)] as const));
        names.set(l.uid, me.name);
        return {
          id: r.id, title: r.title, hostUid: r.hostUid, version: r.hostVersion, closed: r.closed,
          me: { uid: l.uid, name: me.name },
          members: l.members.map((m) => ({ uid: m.uid, name: names.get(m.uid) ?? m.uid.slice(0, 8), status: m.status })),
        };
      }
      case "room.create": {
        const title = typeof (a0 as { title?: unknown })?.title === "string" ? (a0 as { title: string }).title : `${l.app.name} · 一局`;
        const id = await createRoom(supabase, l.app.id, title);
        navigation.replace("MiniApp", { appId: l.app.id, roomId: id });
        return { id };
      }
      case "room.open": {
        if (typeof a0 !== "string") throw new Error("要给房间 id");
        const rooms = (await listRooms(supabase, familyOf(l.app))) ?? [];
        if (!rooms.some((r) => r.id === a0)) throw new Error("没有这一间（或你不在里面）");
        navigation.replace("MiniApp", { appId: l.app.id, roomId: a0 });
        return true;
      }
      case "room.rooms": return (await listRooms(supabase, familyOf(l.app))) ?? [];
      case "room.invite": {
        const r = needRoom(l);
        if (r.hostUid !== l.uid) throw new Error("只有房主能邀请");
        return await new Promise<string[]>((resolve) => {
          inviteDone.current = resolve;
          setSharing({ key: Date.now(), visible: true, mode: "invite" });
        });
      }
      case "room.leave": {
        await leaveRoom(supabase, needRoom(l).id);
        navigation.replace("MiniApp", { appId: l.app.id });
        return true;
      }
      case "room.get": return roomData.get(supabase, needRoom(l).id, a0);
      case "room.list": return roomData.list(supabase, needRoom(l).id, a0);
      case "room.set": return roomData.set(supabase, needRoom(l).id, a0, a1, req.args[2]);
      case "room.remove": await roomData.remove(supabase, needRoom(l).id, a0); return true;
      case "room.send": {
        const link = roomLink.current;
        if (link === null) throw new Error("还没连上房间");
        await link.send(a0);
        return true;
      }
      case "room.ping": return pingRoom(supabase, needRoom(l).id, a0);
```

`handle` 的 `useCallback` 依赖补 `friends, me`。

6. 订阅 effect（放在 `onMessage` 之前）：

```ts
  useEffect(() => {
    if (loaded === null || loaded.room === null) return;
    const roomId = loaded.room.id;
    const push = (js: string): void => { web.current?.injectJavaScript(js); };
    const link = subscribeRoom(supabase, loaded.room.id, loaded.uid, {
      change: (e) => push(bridgeEventJs("room.change", e)),
      members: () => {
        void fetchMembers(supabase, roomId).then((m) => {
          const cur = loadedRef.current;
          if (m === null || cur === null) return;
          const next = { ...cur, members: m };
          loadedRef.current = next;
          setLoaded(next);
          push(bridgeEventJs("room.members", { members: m }));
        });
      },
      message: (from, msg) => push(bridgeEventJs("room.message", { from, msg })),
    });
    roomLink.current = link;
    return () => link.close();
  }, [loaded?.room?.id]);
```

7. 选人框：`onOk` 开头按 `sharing.mode` 分路。`invite` 一路：

```ts
          if (sharing.mode === "invite") {
            void (async () => {
              setShareBusy(true);
              setShareError(null);
              try {
                const room = needRoom(loaded);
                const card = {
                  appId: loaded.app.id, version: room.hostVersion, name: loaded.app.name, icon: loaded.app.icon, slug: loaded.app.slug,
                  description: loaded.app.description, from: { uid: loaded.uid, name: me.name },
                };
                for (const p of people) {
                  await inviteToRoom(supabase, room.id, p.uid);
                  await sendToFriend(p.uid, encodeRoomInvite(card, { id: room.id, title: room.title }));
                }
                inviteDone.current?.(people.map((p) => p.uid));
                inviteDone.current = null;
                setSharing((d) => (d === null ? d : { ...d, visible: false }));
                toast(people.length === 1 ? "邀请发出去了" : `邀请了 ${people.length} 位朋友`);
              } catch (e) {
                setShareError(e instanceof Error ? e.message : String(e));
              } finally {
                setShareBusy(false);
              }
            })();
            return;
          }
```

原分享逻辑保留为另一路。`onClose`：先 `inviteDone.current?.([]); inviteDone.current = null;` 再收框。`title`：`sharing.mode === "invite" ? \`邀请朋友进「${loaded.room?.title ?? ""}」\` : \`分享「${loaded.app.name}」\``；`lead`：invite 时「挑要一起玩的朋友。TA 点开邀请就能进来，没有这个应用会自动装上。」，`okLabel`：invite 时「邀请」。

8. 顶栏：`useLayoutEffect` 里 `title: loaded?.room?.title ?? name`；房主在房间里时「分享」之前多一个 `<HeaderTextButton label="邀请" disabled={false} onPress={() => setSharing({ key: Date.now(), visible: true, mode: "invite" })} />`。

- [ ] **Step 4: 跑测试 + 手机 tsc**

Run: `npx vitest run tests/mobile/miniAppWiring.test.ts && npx tsc --noEmit -p mobile`
Expected: PASS、tsc 无错

- [ ] **Step 5: Commit**

```bash
git add mobile/src/nav/types.ts mobile/src/apps/MiniAppScreen.tsx tests/mobile/miniAppWiring.test.ts
git commit -m "feat(mobile): 应用宿主的房间模式——跑房主那一版、otto.room 落到 appRoomApi、订阅推成事件、邀请发卡（#1675）"
```

---

### Task 7: 邀请卡气泡 + 列表第二行

**Files:**
- Modify: `mobile/src/apps/AppShareBubble.tsx`
- Modify: `mobile/src/friends/FriendChatScreen.tsx:159-165`
- Modify: `src/shared/wechatInbox.ts:631-632`
- Test: `tests/mobile/miniAppWiring.test.ts`（追加）、`tests/shared/wechatInbox.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2（`decodeRoomInvite` / `roomInvitePreview` / `RoomInvite`）、Task 3（`joinRoom`）、Task 6（路由 `roomId`）

- [ ] **Step 1: 追加测试（先红）**

```ts
// tests/shared/wechatInbox.test.ts 追加（dmPreview 的既有 describe 里；encodeRoomInvite 并进顶部 import）
  it("邀请卡（#1675）：列表第二行是 [邀请]，不是 [应用]", () => {
    const card = { appId: "0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b", version: 1, name: "五子棋", icon: "⚫", slug: "gomoku", description: "", from: { uid: "2819d0bb-933b-499d-be44-2bb51b5a8391", name: "S" } };
    expect(dmPreview(encodeRoomInvite(card, { id: "11111111-2222-4333-8444-555555555555", title: "局" }))).toBe("[邀请] ⚫ 五子棋");
  });
```

```ts
// tests/mobile/miniAppWiring.test.ts 追加
describe("邀请卡（#1675）", () => {
  it("私聊页把 room 一格传给应用卡气泡", () => {
    const chat = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(chat).toMatch(/const invite = appCard !== null \? decodeRoomInvite\(m\.body\) : null;/);
    expect(chat).toMatch(/<AppShareBubble card=\{appCard\} mine=\{mine\} messageId=\{m\.id\} room=\{invite\?\.room \?\? null\} \/>/);
  });
  it("加入：没有就先 appAccept 复制，再 joinRoom，进房间模式", () => {
    const b = read("mobile/src/apps/AppShareBubble.tsx");
    expect(b).toMatch(/await joinRoom\(supabase, room\.id\);/);
    expect(b).toMatch(/navigation\.navigate\("MiniApp", \{ appId: myAppId, roomId: room\.id \}\)/);
  });
});
```

（若 `dmPreview` 在测试文件里不是现成 import，从 `../../src/shared/wechatInbox.js` 补。）

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/mobile/miniAppWiring.test.ts tests/shared/wechatInbox.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`wechatInbox.ts` 在 `const app = decodeAppCard(body);` 之前：

```ts
  // 房间邀请（#1675）：应用卡信封多一格 room，先认它
  const invite = decodeRoomInvite(body);
  if (invite !== null) return roomInvitePreview(invite.card);
```

import 加 `import { decodeRoomInvite, roomInvitePreview } from "./appRoom.js";`。

`FriendChatScreen.tsx`：

```ts
  const appCard = card === null ? decodeAppCard(m.body) : null;
  // 房间邀请（#1675）：应用卡信封多一格 room
  const invite = appCard !== null ? decodeRoomInvite(m.body) : null;
```

渲染改成 `<AppShareBubble card={appCard} mine={mine} messageId={m.id} room={invite?.room ?? null} />`，import `decodeRoomInvite`（`../../../src/shared/appRoom.js`）。

`AppShareBubble.tsx`：

- props：`{ card, mine, messageId, room }: { card: AppShareCard; mine: boolean; messageId: number; room: RoomInvite | null }`；import `type RoomInvite`（appRoom.js）、`joinRoom`（appRoomApi.js）、`supabase`（`../supabase.js`）。
- `add` 之后加：

```ts
  const join = async (): Promise<void> => {
    if (room === null) return;
    setBusy(true);
    setError(null);
    try {
      let myAppId: string;
      if (mine) myAppId = card.appId;
      else if (added !== null) myAppId = added.id;
      else {
        const r = await cloudClient.appAccept(messageId);
        if (!r.ok) throw new Error(r.message);
        myAppId = r.value.appId;
        await refreshApps();
      }
      if (!mine) await joinRoom(supabase, room.id);
      navigation.navigate("MiniApp", { appId: myAppId, roomId: room.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
```

- `open` 第一行：`if (room !== null) { if (!busy) void join(); return; }`
- 文案：首行 `room !== null ? (mine ? \`你邀请了朋友一起玩「${room.title}」\` : \`${card.from.name} 邀请你一起玩「${room.title}」\`) : (原文案)`；按钮文字 `room !== null ? (busy ? "…" : mine ? "进入" : "加入") : (原文案)`；按钮底色 `room !== null && !mine ? c.brand : (原判断)`。

- [ ] **Step 4: 跑测试 + 手机 tsc**

Run: `npx vitest run tests/mobile/miniAppWiring.test.ts tests/shared/wechatInbox.test.ts && npx tsc --noEmit -p mobile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/apps/AppShareBubble.tsx mobile/src/friends/FriendChatScreen.tsx src/shared/wechatInbox.ts tests/mobile/miniAppWiring.test.ts tests/shared/wechatInbox.test.ts
git commit -m "feat(mobile): 私聊里的房间邀请卡——没有就先装、加入、进房间模式；列表显示 [邀请]（#1675）"
```

---

### Task 8: 推送——`AlertTarget` 加 room + runtime `roomPush`

**Files:**
- Modify: `src/shared/notifyPrefs.ts`（`AlertTarget`、`alertKey`、`alertTargetFromPayload`）
- Create: `services/runtime/src/roomPush.ts`
- Modify: `services/runtime/src/daemon.ts:210-211`（装配）
- Test: `tests/shared/notifyPrefs.test.ts`（追加）、`tests/runtime/roomPush.test.ts`（新建）

**Interfaces:**
- Consumes: `Notifier`（`notifier.send(uid, kind, push)`；kind 复用 `"friend"`——好友互动归朋友那个开关）、`createProfileNames`（`friendPush.ts`）
- Produces:
  ```ts
  // notifyPrefs.ts
  export type AlertTarget = … | { kind: "room"; roomId: string; hostAppId: string };
  // roomPush.ts
  export interface RoomPingRow { id: number; roomId: string; fromUid: string; text: string }
  export function roomPingOf(raw: unknown): RoomPingRow | null
  export interface RoomPushDeps { notifier: Notifier; nameOf(uid: string): Promise<string>; audience(roomId: string, exceptUid: string): Promise<{ uids: string[]; appName: string; hostAppId: string } | null>; log(m: string): void }
  export function createRoomPush(d: RoomPushDeps): { onInsert(raw: unknown): Promise<void> }
  export function createRoomAudience(client: SupabaseClient): RoomPushDeps["audience"]
  export function subscribeRoomPings(client: SupabaseClient, onInsert: (raw: unknown) => void, log: (m: string) => void): () => void
  ```

- [ ] **Step 1: 测试（先红）**

```ts
// tests/shared/notifyPrefs.test.ts 追加（alertKey / alertTargetFromPayload 若未 import 就补）
  it("room 推送目标（#1675）：往返、列表键 r:<roomId>、缺格回 null", () => {
    const t = { kind: "room" as const, roomId: "11111111-2222-4333-8444-555555555555", hostAppId: "0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b" };
    expect(alertTargetFromPayload({ otto: t })).toEqual(t);
    expect(alertKey(t)).toBe(`r:${t.roomId}`);
    expect(alertTargetFromPayload({ otto: { kind: "room", roomId: t.roomId } })).toBeNull();
  });
```

```ts
// tests/runtime/roomPush.test.ts
import { describe, expect, it } from "vitest";
import { createRoomPush, roomPingOf } from "../../services/runtime/src/roomPush.js";

const ROOM = "11111111-2222-4333-8444-555555555555";
const A = "2819d0bb-933b-499d-be44-2bb51b5a8391";
const B = "32c6716a-0000-4000-8000-000000000000";
const APP = "0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b";

describe("roomPush", () => {
  it("行解析：缺格 / 类型不对回 null", () => {
    expect(roomPingOf({ id: "7", room_id: ROOM, from_uid: A, text: "轮到你了" })).toEqual({ id: 7, roomId: ROOM, fromUid: A, text: "轮到你了" });
    expect(roomPingOf({ id: 7, room_id: ROOM })).toBeNull();
  });
  it("推给其他成员：标题「发的人·应用名」，正文 = text，目标 room；kind 走 friend 那个开关", async () => {
    const sent: unknown[] = [];
    const push = createRoomPush({
      notifier: { send: async (uid: string, kind: string, p: unknown) => { sent.push([uid, kind, p]); } } as never,
      nameOf: async () => "Stan",
      audience: async (room, except) => (room === ROOM && except === A ? { uids: [B], appName: "五子棋", hostAppId: APP } : null),
      log: () => {},
    });
    await push.onInsert({ id: 1, room_id: ROOM, from_uid: A, text: "轮到你了" });
    expect(sent).toEqual([[B, "friend", { title: "Stan·五子棋", body: "轮到你了", target: { kind: "room", roomId: ROOM, hostAppId: APP } }]]);
  });
  it("房间没了 / 没别人：不推不抛", async () => {
    const sent: unknown[] = [];
    const push = createRoomPush({ notifier: { send: async () => { sent.push(1); } } as never, nameOf: async () => "S", audience: async () => null, log: () => {} });
    await push.onInsert({ id: 1, room_id: ROOM, from_uid: A, text: "x" });
    expect(sent).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/notifyPrefs.test.ts tests/runtime/roomPush.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`notifyPrefs.ts`：

```ts
export type AlertTarget =
  | { kind: "cloud"; chat: Exclude<RingChatKind, "human">; workspaceId: string; sessionId: string; agentId: string }
  | { kind: "friend"; uid: string }
  | { kind: "room"; roomId: string; hostAppId: string };

export function alertKey(t: AlertTarget): string {
  if (t.kind === "friend") return `f:${t.uid}`;
  if (t.kind === "room") return `r:${t.roomId}`;
  return muteKeyFor(t.chat, t.sessionId, t.agentId) as string;
}
```

`alertTargetFromPayload` 里 `if (o.kind === "friend") {…}` 之后：

```ts
  if (o.kind === "room") {
    const roomId = str("roomId");
    const hostAppId = str("hostAppId");
    return roomId === null || hostAppId === null ? null : { kind: "room", roomId, hostAppId };
  }
```

然后 `grep -rn 'kind === "friend"' src mobile/src services --include=*.ts --include=*.tsx`：凡是「不是 friend 就当 cloud」的二分（除了 Task 9 要改的 `messagePush.ts` `open`），补 room 分支或先排除 room——tsc 会在把 room 当 cloud 读 `.chat` / `.sessionId` 的地方报错，以 tsc 为准逐个修。

`services/runtime/src/roomPush.ts`：

```ts
// roomPush —— 应用房间的「叫人」（#1675，spec §6）。应用调 otto.room.ping → 手机直连 app_room_ping RPC 往 app_room_pings 写一行
// （限速在 RPC 里）。runtime 用 service key 订这张表的 INSERT，推给这间房其他 joined 成员。推不推交 notifier（朋友那个开关 / 免打扰）。
// 形状同 friendPush.ts，同样的已知代价：realtime 断线期间写进来的不补推。
import type { SupabaseClient } from "@supabase/supabase-js";
import { alertBody, type AlertPush } from "../../../src/shared/notifyPrefs.js";
import type { Notifier } from "./notifier.js";

export interface RoomPingRow { id: number; roomId: string; fromUid: string; text: string }

export function roomPingOf(raw: unknown): RoomPingRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "number" ? o.id : typeof o.id === "string" && /^\d+$/.test(o.id) ? Number(o.id) : null;
  if (id === null || typeof o.room_id !== "string" || typeof o.from_uid !== "string" || typeof o.text !== "string" || o.text === "") return null;
  return { id, roomId: o.room_id, fromUid: o.from_uid, text: o.text };
}

export interface RoomPushDeps {
  notifier: Notifier;
  nameOf(uid: string): Promise<string>;
  audience(roomId: string, exceptUid: string): Promise<{ uids: string[]; appName: string; hostAppId: string } | null>;
  log(m: string): void;
}

export function createRoomPush(d: RoomPushDeps): { onInsert(raw: unknown): Promise<void> } {
  return {
    async onInsert(raw) {
      const p = roomPingOf(raw);
      if (p === null) return;
      try {
        const aud = await d.audience(p.roomId, p.fromUid);
        if (aud === null || aud.uids.length === 0) return;
        let name: string;
        try {
          name = await d.nameOf(p.fromUid);
        } catch {
          name = p.fromUid.slice(0, 8);
        }
        const push: AlertPush = { title: `${name}·${aud.appName}`, body: alertBody(p.text), target: { kind: "room", roomId: p.roomId, hostAppId: aud.hostAppId } };
        for (const uid of aud.uids) await d.notifier.send(uid, "friend", push);
      } catch (err) {
        d.log(`[otto-runtime] 房间叫人推送失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** 其他 joined 成员 + 房主那一版清单里的应用名 */
export function createRoomAudience(client: SupabaseClient): RoomPushDeps["audience"] {
  return async (roomId, exceptUid) => {
    const room = await client.from("app_rooms").select("host_app_id, host_version, closed").eq("id", roomId).maybeSingle();
    if (room.error || room.data === null) return null;
    const r = room.data as { host_app_id: string; host_version: number; closed: boolean };
    if (r.closed) return null;
    const mem = await client.from("app_room_members").select("uid").eq("room_id", roomId).eq("status", "joined");
    if (mem.error) return null;
    const uids = ((mem.data ?? []) as { uid: string }[]).map((m) => m.uid).filter((u) => u !== exceptUid);
    const ver = await client.from("app_versions").select("manifest").eq("app_id", r.host_app_id).eq("version", r.host_version).maybeSingle();
    const name = (ver.data as { manifest?: { name?: unknown } } | null)?.manifest?.name;
    return { uids, appName: typeof name === "string" && name !== "" ? name : "应用", hostAppId: r.host_app_id };
  };
}

export function subscribeRoomPings(client: SupabaseClient, onInsert: (raw: unknown) => void, log: (m: string) => void): () => void {
  const channel = client
    .channel("otto-runtime-room-pings")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "app_room_pings" }, (payload) => onInsert(payload.new))
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") log("[otto-runtime] 房间叫人推送：已订上 app_room_pings");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") log(`[otto-runtime] 房间叫人推送：订阅 ${status}${err ? `：${err.message}` : ""}（supabase-js 会自己重连）`);
    });
  return () => {
    void client.removeChannel(channel);
  };
}
```

`daemon.ts` 第 211 行 `subscribeFriendMessages(...)` 之后：

```ts
    // 应用房间的叫人（#1675）：同 friendPush，订 app_room_pings 的 INSERT
    const roomPush = createRoomPush({ notifier, nameOf: createProfileNames(supabase), audience: createRoomAudience(supabase), log: (m) => console.warn(m) });
    subscribeRoomPings(supabase, (raw) => void roomPush.onInsert(raw), (m) => console.log(m));
```

import：`import { createRoomAudience, createRoomPush, subscribeRoomPings } from "./roomPush.js";`

- [ ] **Step 4: 跑，确认绿 + tsc（两边）**

Run: `npx vitest run tests/shared/notifyPrefs.test.ts tests/runtime/roomPush.test.ts && npx tsc --noEmit && npx tsc --noEmit -p mobile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/notifyPrefs.ts services/runtime/src/roomPush.ts services/runtime/src/daemon.ts tests/shared/notifyPrefs.test.ts tests/runtime/roomPush.test.ts
git commit -m "feat(apps): 房间叫人推送——runtime 订 app_room_pings 推给其他成员，推送目标多 room（#1675）"
```

（tsc 逼出来的其他 `kind === "friend"` 二分修补也进这个提交，并在提交说明里列出改了哪几处。）

---

### Task 9: 点开房间推送进房间模式

**Files:**
- Modify: `mobile/src/push/messagePush.ts`（`open`）
- Test: `tests/mobile/miniAppWiring.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 `myAppForHost`、`fetchApps`（`src/shared/appsApi.ts`；冷启动时应用 store 可能还空，所以直接取）、Task 6 路由、Task 8 的 `AlertTarget` room

- [ ] **Step 1: 追加测试（先红）**

```ts
describe("房间推送点开（#1675）", () => {
  it("room 目标：找我名下对应房主应用的那一份，进 MiniApp 房间模式；找不到回首页", () => {
    const src = read("mobile/src/push/messagePush.ts");
    expect(src).toMatch(/if \(t\.kind === "room"\) \{/);
    expect(src).toMatch(/myAppForHost\(apps \?\? \[\], t\.hostAppId\)/);
    expect(src).toMatch(/\{ name: "MiniApp" as const, params: \{ appId: mine\.id, roomId: t\.roomId \} \}/);
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/mobile/miniAppWiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**——`open` 开头加 room 分支：

```ts
function open(t: AlertTarget): void {
  // 房间叫人（#1675）：先找我名下对应房主应用的那一份（我是房主 = 同一个 id；否则是它的副本），再进房间模式
  if (t.kind === "room") {
    void (async () => {
      const apps = await fetchApps(supabase);
      const mine = myAppForHost(apps ?? [], t.hostAppId);
      const go = (): void => {
        navRef.dispatch(CommonActions.reset(mine === null
          ? { index: 0, routes: [{ name: "Home" }] }
          : { index: 1, routes: [{ name: "Home" }, { name: "MiniApp" as const, params: { appId: mine.id, roomId: t.roomId } }] }));
      };
      if (navRef.isReady()) go();
      else pendingNav = go;
    })();
    return;
  }
  // 以下原样
```

（测试正则要求出现 `{ name: "MiniApp" as const, params: { appId: mine.id, roomId: t.roomId } }` 这一段字面量——照上面写即可。）import：`fetchApps`（`../../../src/shared/appsApi.js`）、`myAppForHost`（`../../../src/shared/appRoom.js`）、`supabase`（`../supabase.js`，若未 import）。

- [ ] **Step 4: 跑测试 + 手机 tsc**

Run: `npx vitest run tests/mobile/miniAppWiring.test.ts && npx tsc --noEmit -p mobile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/push/messagePush.ts tests/mobile/miniAppWiring.test.ts
git commit -m "feat(mobile): 点开房间叫人推送进那一局（#1675）"
```

---

### Task 10: ADR + 术语 + 代码地图

**Files:**
- Create: `docs/adr/0374-应用的房间建在Supabase上-写只走RPC-进局跑房主那一版-邀请卡复用应用卡信封不进位协议.md`
- Modify: `CONTEXT.md`（产品 / 技术术语段加「房间（应用）」）
- Modify: `docs/where-to-find-things.md`（加一条）
- Test: `tests/docs/adrNumbers.test.ts`（既有）

- [ ] **Step 1: 写 ADR**

```markdown
# ADR-0374 应用的房间建在 Supabase 上：写只走 RPC、进局跑房主那一版、邀请卡复用应用卡信封不进位协议

- 日期：2026-10-05 · Issue：#1675 · Spec：docs/superpowers/specs/2026-10-05-otto-app-rooms-design.md · Plan：docs/superpowers/plans/2026-10-05-otto-app-rooms.md

## 背景
维护者要「能和好友互动的应用和游戏」（回合制、共享数据、一次性挑战、实时四类都要）。Otto 应用（#1591）的 app_data 按人隔离，分享 = 复制副本，桥上没有往好友那边写的口子。

## 决定
1. 房间（一局 / 一本共享的账）建在 Supabase：表 + RLS + Realtime（postgres_changes 给持久同步，私有 broadcast 给实时），不经 runtime 中继（中继 DO 钉在欧洲，悉尼往返 ~350 ms）。
2. 写只走 security definer RPC：比较后再写（if_rev）、人数 ≤ 8、好友判据、ping 限速要在一个事务里判。
3. 一局钉住房主建局时的版本；成员读得到的只有那一版（app_versions 与 otto-apps 桶各一条按成员放行的策略）。
4. 邀请卡 = 应用卡信封多一格 room；加入走 RPC 直连——cs 协议严格相等握手，加帧就要 runtime 与所有手机同时换版。
5. 叫人推送照 friendPush：runtime 订 app_room_pings 的 INSERT；推送开关复用「朋友」那一档。
6. 第一版只人和人；智能体不进房间。

## 推翻它的前提
见 spec §9：Supabase Realtime 在悉尼撑不住实时对战 / 要智能体进房 / cs 协议改成最低兼容版本。
```

- [ ] **Step 2: CONTEXT.md**（产品 / 技术段，按既有顺序插入一行；表格列数照该段表头）

```markdown
| 房间（应用） | Otto 应用的一局 / 一本共享的账：房主开、邀好友进来；成员共读写的键值（app_room_data，写走 RPC、带 if_rev）+ 即时消息（私有 broadcast `room:<id>`）；一局钉住房主那一版 | ADR-0374 |
```

- [ ] **Step 3: where-to-find-things.md**（Otto 应用那几条之后加一条）

```markdown
- `supabase/migrations/0067_app_rooms.sql`（+ `supabase/checks/0067_app_rooms.{check,behavior}.sql`）/ `src/shared/appRoom.ts` / `appRoomApi.ts` / `appBridge.ts` 的 `otto.room` 与 `otto.on` / `mobile/src/apps/MiniAppScreen.tsx` 房间模式 / `AppShareBubble.tsx` 邀请卡 / `services/runtime/src/roomPush.ts` — **应用的房间**（ADR-0374，#1675）：好友一起玩 / 一起记。写只走七个 RPC；成员只读得到房主钉住的那一版；邀请卡是应用卡信封多一格 room（老手机当普通应用卡）；叫人推送订 app_room_pings。behavior.sql 是扮人跑一遍、结尾 raise 整笔回滚。
```

- [ ] **Step 4: 跑 ADR 编号测试**

Run: `npx vitest run tests/docs/adrNumbers.test.ts`
Expected: PASS（撞号：re-fetch，改 max+1，文件头加「原为 ADR-0374」，全仓改引用——逐向核，别全局替换）

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0374-*.md CONTEXT.md docs/where-to-find-things.md
git commit -m "docs: ADR-0374 应用的房间 + 术语 + 代码地图（#1675）"
```

---

### Task 11: 门禁、PR、上线前验收（主线程做，不派子 agent）

- [ ] **Step 1:** `npm test` 全绿（判据只认日志里的 `GATE_EXIT`，不认后台通知的退出码）。
- [ ] **Step 2:** push、开 PR（正文：做了什么 / 上线顺序 migration → runtime → OTA / 「GUI 未验」如实写）。CI 绿后先**不合**。
- [ ] **Step 3:** 维护者在会话里点头后，在生产跑 0067（Management API 逐条发，切分器尊重 `$$`）→ 逐条跑 `0067_app_rooms.check.sql` 全 PASS → 填好 `:B` / `:C` 跑 `0067_app_rooms.behavior.sql`，报错文本应为 `ALL PASS（整笔回滚）`；任何 `FAIL:` 先修（新 migration 号，不改已跑的）。
- [ ] **Step 4:** 合并（merge commit）→ `RUNTIME_SSH=otto-runtime npm run runtime:deploy` → OTA（手机改动：MiniAppScreen / AppShareBubble / FriendChatScreen / messagePush）。
- [ ] **Step 5:** 第 3 期端到端（#1661 续）：两个号建房、邀请、同步、冲突、broadcast、ping 落表与推送。
