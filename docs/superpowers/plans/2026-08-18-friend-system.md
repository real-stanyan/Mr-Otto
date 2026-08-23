# 好友系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 真人用户（Supabase 账号）互加好友：关系链 + 在线状态 + 一对一实时 DM，一个 PR 全量交付。

**Architecture:** Supabase 直连（自托管实例 `otto-auth.stan.damianslife.com`，见 `src/main/authConfig.ts`）。三张表 + RLS + Realtime；主进程 `FriendsManager` 经窄接口 `FriendsApi` 依赖注入（照 `account.ts` 的 `SupabaseLike` 模式），渲染进程只走 `ShellBridge`。真 supabase client 与 `AccountManager` 共用一个实例。

**Tech Stack:** Electron 主进程 + `@supabase/supabase-js@^2`（已在依赖里）+ React/Zustand + Tailwind/shadcn-ui + vitest。

**Spec:** `docs/superpowers/specs/2026-08-18-friend-system-design.md`

## Global Constraints

- 渲染进程只通过 `ShellBridge` 通信，组件不直接摸 `window.otter`（一律经 store）——AGENTS.md 硬规则
- token/session 对象永不过 IPC（既有安全硬约束，`shellBridge.ts` 注释）
- 测试统一放 `tests/`，镜像 `src/` 结构；门禁 = `npm test`（vitest run），收工必须全绿
- TypeScript strict；新 UI 用 Tailwind + shadcn/ui
- 单测不实例化真 supabase client、不发网络请求（`account.ts` 既有模式：真 client 组装隔离进 factory，单测注入假实现）
- commit 小步走，message 写 why；PR 走 merge commit
- bridge 好友方法错误形态：`FriendsResult<T> = { ok: true; value: T } | { ok: false; message: string }`（spec 裁定，网络/RLS 拒绝不 throw）

---

### Task 1: Supabase migration SQL + Task issue

**Files:**
- Create: `supabase/migrations/0001_friends.sql`
- Create: `supabase/README.md`

**Interfaces:**
- Produces: 三张表 `public.profiles` / `public.friendships` / `public.messages` 及 RLS；后续所有任务的行形状（ProfileRow/FriendshipRow/MessageRow，见 Task 2）与这里的列一一对应

- [ ] **Step 1: 开 GitHub Task issue**

```bash
gh issue create --title "Task: 好友系统(关系链+在线状态+DM,Supabase 直连)" --body "Spec: docs/superpowers/specs/2026-08-18-friend-system-design.md
Plan: docs/superpowers/plans/2026-08-18-friend-system.md
实现分支 claude/friend-system-d5440e,PR 合并时关闭本 issue。"
```

记下 issue 号，PR body 里写 `Closes #N`。

- [ ] **Step 2: 写 migration SQL**

`supabase/migrations/0001_friends.sql`（整文件）：

```sql
-- 好友系统三表 + RLS + Realtime(spec: docs/superpowers/specs/2026-08-18-friend-system-design.md)
-- 在 Supabase SQL editor 手动执行一次。重复执行安全(if not exists / or replace)。

-- ── profiles:auth.users 的公开投影(邮箱精确搜索找人) ──────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text not null default '',
  avatar_url text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- 意图:任何登录用户可读(支撑邮箱精确搜索);只有本人可改自己的行
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- auth.users → profiles 自动同步(注册/改资料)。security definer:触发器跑在
-- auth schema 的上下文里,普通用户无权直写 profiles 之外的行
create or replace function public.handle_auth_user_upsert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, avatar_url, updated_at)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'user_name',
             split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', ''),
    now()
  )
  on conflict (id) do update
    set email = excluded.email, name = excluded.name,
        avatar_url = excluded.avatar_url, updated_at = now();
  return new;
end $$;
drop trigger if exists on_auth_user_upsert on auth.users;
create trigger on_auth_user_upsert
  after insert or update on auth.users
  for each row execute function public.handle_auth_user_upsert();

-- 存量用户回填(触发器只管今后)
insert into public.profiles (id, email, name, avatar_url)
select id, coalesce(email, ''),
       coalesce(raw_user_meta_data->>'name', raw_user_meta_data->>'user_name',
                split_part(coalesce(email, ''), '@', 1)),
       coalesce(raw_user_meta_data->>'avatar_url', raw_user_meta_data->>'picture', '')
from auth.users
on conflict (id) do nothing;

-- ── friendships:关系链(pending=请求中,accepted=好友;拒绝/删好友=删行) ──
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references public.profiles(id) on delete cascade,
  addressee uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester <> addressee)  -- 不能加自己
);
-- 无序对唯一:A→B 与 B→A 视为同一关系,防双向重复请求
create unique index if not exists friendships_pair_unique
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
alter table public.friendships enable row level security;

-- 意图:仅当事双方可见;发起方只能插 pending 且 requester 必须是自己;
-- 被请求方接受 = pending→accepted(只有这一条 update 路径);双方都可删行
drop policy if exists "friendships_select_parties" on public.friendships;
create policy "friendships_select_parties" on public.friendships
  for select to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);
drop policy if exists "friendships_insert_requester" on public.friendships;
create policy "friendships_insert_requester" on public.friendships
  for insert to authenticated
  with check (auth.uid() = requester and status = 'pending');
drop policy if exists "friendships_accept_addressee" on public.friendships;
create policy "friendships_accept_addressee" on public.friendships
  for update to authenticated
  using (auth.uid() = addressee and status = 'pending')
  with check (status = 'accepted');
drop policy if exists "friendships_delete_parties" on public.friendships;
create policy "friendships_delete_parties" on public.friendships
  for delete to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

-- ── messages:好友间一对一 DM ──────────────────────────────────────
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  sender uuid not null references public.profiles(id) on delete cascade,
  recipient uuid not null references public.profiles(id) on delete cascade,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
alter table public.messages enable row level security;

-- 意图:仅收发双方可读;只能以自己名义发,且必须已是 accepted 好友
drop policy if exists "messages_select_parties" on public.messages;
create policy "messages_select_parties" on public.messages
  for select to authenticated
  using (auth.uid() = sender or auth.uid() = recipient);
drop policy if exists "messages_insert_accepted_friend" on public.messages;
create policy "messages_insert_accepted_friend" on public.messages
  for insert to authenticated
  with check (
    auth.uid() = sender
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and least(f.requester, f.addressee) = least(sender, recipient)
        and greatest(f.requester, f.addressee) = greatest(sender, recipient)
    )
  );

-- Realtime:两张表进 publication,postgres_changes 才有得推(RLS 照常生效)
alter publication supabase_realtime add table public.friendships;
alter publication supabase_realtime add table public.messages;
```

注意最后两行 `alter publication` 重复执行会报 "already member"——重跑时把这两行单独跳过。

- [ ] **Step 3: 写 supabase/README.md**

```markdown
# Supabase migrations

自托管实例:https://otto-auth.stan.damianslife.com(配置见 src/main/authConfig.ts)。

执行方式:Supabase Studio → SQL editor 粘贴整个 migration 文件运行(按文件名顺序)。
无 CLI 管线——本目录是唯一事实来源,改 schema 必须新增编号 migration 文件,不改旧文件。

前置检查:实例必须开着 Realtime 服务(presence + postgres_changes),
且 publication `supabase_realtime` 存在——docker-compose 自托管默认有。
```

- [ ] **Step 4: Commit**

```bash
git add supabase/
git commit -m "feat(friends): 好友系统三表 migration——profiles 触发器同步/friendships 无序对唯一/messages RLS 限 accepted 好友"
```

- [ ] **Step 5: 在 Supabase SQL editor 执行 migration**（stanyan 手动，或授权 supabase MCP 后 agent 执行）。没跑也不阻塞后续任务——全部代码任务离线可测，只有最终手动验收需要它。

---

### Task 2: 共享类型 + ShellBridge 扩口 + preload 桥接

**Files:**
- Create: `src/shared/friends.ts`
- Modify: `src/shared/shellBridge.ts`（ShellBridge 接口 + CHANNELS）
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces（后续所有任务的类型词汇表）:
  - `FriendProfile { id: string; email: string; name: string; avatarUrl: string }`
  - `FriendshipEntry { friendshipId: string; profile: FriendProfile; status: "pending" | "accepted"; direction: "incoming" | "outgoing" }`
  - `FriendsSnapshot { friends: FriendshipEntry[]; incoming: FriendshipEntry[]; outgoing: FriendshipEntry[] }`
  - `DirectMessage { id: number; sender: string; recipient: string; body: string; createdAt: string }`
  - `FriendsResult<T> = { ok: true; value: T } | { ok: false; message: string }`
  - ShellBridge 方法 8 个 + 订阅 3 个（下方全文）

- [ ] **Step 1: 写 `src/shared/friends.ts`**（整文件）

```typescript
// friends — 好友系统的共享类型(三边共 import:main/preload/renderer)。
// 纯类型 + 零运行时依赖,遵守 shellBridge.ts 的"共享世界"约定。
// 行形状与 supabase/migrations/0001_friends.sql 的列一一对应。

/** profiles 表一行的渲染层形态(snake_case 列名在主进程归一成 camelCase) */
export interface FriendProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
}

/** 一条好友关系,从"我"的视角展开:profile 是对方,direction 是请求方向 */
export interface FriendshipEntry {
  friendshipId: string;
  profile: FriendProfile;
  status: "pending" | "accepted";
  /** incoming = 对方发给我的请求;outgoing = 我发出的请求。accepted 后无所谓方向,保留事实 */
  direction: "incoming" | "outgoing";
}

/** listFriends / onFriendsChanged 的全量快照(量小,快照比增量简单) */
export interface FriendsSnapshot {
  friends: FriendshipEntry[];
  incoming: FriendshipEntry[];
  outgoing: FriendshipEntry[];
}

export interface DirectMessage {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  /** ISO 8601(supabase timestamptz 原样传) */
  createdAt: string;
}

/** 好友 bridge 方法的错误形态(spec 裁定):网络/RLS 拒绝不 throw,结构化回流,
    渲染层拿 message 做内联提示。throw 只留给"渲染层送来非法参数"这类编程错误 */
export type FriendsResult<T> = { ok: true; value: T } | { ok: false; message: string };
```

- [ ] **Step 2: 扩 `src/shared/shellBridge.ts`**

顶部 import 区加：

```typescript
import type { DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot } from "./friends.js";
```

`ShellBridge` 接口 `onAccountChanged` 之后加：

```typescript
  /** 邮箱精确匹配搜用户。value null = 查无此人(不是错误) */
  friendsSearch(email: string): Promise<FriendsResult<FriendProfile | null>>;
  /** 发好友请求。重复请求/已是好友 → ok:false 带人话理由 */
  friendsSendRequest(userId: string): Promise<FriendsResult<null>>;
  /** 接受(accept=true,pending→accepted)或拒绝(accept=false,删行) */
  friendsRespond(friendshipId: string, accept: boolean): Promise<FriendsResult<null>>;
  /** 删好友 = 删行(与拒绝同一条 DB 路径,语义由调用方 UI 区分) */
  friendsRemove(friendshipId: string): Promise<FriendsResult<null>>;
  /** 全量快照(好友/收到的请求/发出的请求)。变化推送走 onFriendsChanged */
  friendsList(): Promise<FriendsResult<FriendsSnapshot>>;
  friendsSendMessage(friendId: string, body: string): Promise<FriendsResult<null>>;
  /** 拉历史,新→旧;beforeId 翻旧页(取 id < beforeId 的一页,每页 50) */
  friendsListMessages(friendId: string, beforeId?: number): Promise<FriendsResult<DirectMessage[]>>;
  /** 关系链任何变化(本端操作或对端 Realtime 推)→ 全量快照 */
  onFriendsChanged(cb: (snapshot: FriendsSnapshot) => void): Unsubscribe;
  /** presence 集合变化 → 当前在线的 userId 全量列表 */
  onPresenceChanged(cb: (onlineUserIds: string[]) => void): Unsubscribe;
  /** 对端发来的新 DM(自己发的不推——bridge 调用返回即成功,渲染层自己落) */
  onDirectMessage(cb: (message: DirectMessage) => void): Unsubscribe;
```

`CHANNELS` 里 `accountChanged` 之后加：

```typescript
  friendsSearch: "otter:friendsSearch",
  friendsSendRequest: "otter:friendsSendRequest",
  friendsRespond: "otter:friendsRespond",
  friendsRemove: "otter:friendsRemove",
  friendsList: "otter:friendsList",
  friendsSendMessage: "otter:friendsSendMessage",
  friendsListMessages: "otter:friendsListMessages",
  friendsChanged: "otter:friendsChanged",
  presenceChanged: "otter:presenceChanged",
  directMessage: "otter:directMessage",
```

- [ ] **Step 3: 扩 `src/preload/index.ts`**

`bridge` 对象 `onAccountChanged` 行之后加（薄转发，零逻辑，照文件既有风格）：

```typescript
  friendsSearch: (email) => ipcRenderer.invoke(CHANNELS.friendsSearch, email),
  friendsSendRequest: (userId) => ipcRenderer.invoke(CHANNELS.friendsSendRequest, userId),
  friendsRespond: (friendshipId, accept) =>
    ipcRenderer.invoke(CHANNELS.friendsRespond, friendshipId, accept),
  friendsRemove: (friendshipId) => ipcRenderer.invoke(CHANNELS.friendsRemove, friendshipId),
  friendsList: () => ipcRenderer.invoke(CHANNELS.friendsList),
  friendsSendMessage: (friendId, body) =>
    ipcRenderer.invoke(CHANNELS.friendsSendMessage, friendId, body),
  friendsListMessages: (friendId, beforeId) =>
    ipcRenderer.invoke(CHANNELS.friendsListMessages, friendId, beforeId),
  onFriendsChanged: subscribe(CHANNELS.friendsChanged),
  onPresenceChanged: subscribe(CHANNELS.presenceChanged),
  onDirectMessage: subscribe(CHANNELS.directMessage),
```

- [ ] **Step 4: 跑门禁确认没破**

Run: `npm test`
Expected: 全绿（本任务纯类型 + 转发，无新测试；TS 编译错误会在 vitest 里炸出来）

- [ ] **Step 5: Commit**

```bash
git add src/shared/friends.ts src/shared/shellBridge.ts src/preload/index.ts
git commit -m "feat(friends): ShellBridge 扩好友口——8 方法 3 订阅,FriendsResult 结构化错误"
```

---

### Task 3: FriendsManager 关系链逻辑（TDD，假 FriendsApi 注入）

**Files:**
- Create: `src/main/friends.ts`
- Test: `tests/main/friends.test.ts`

**Interfaces:**
- Consumes: Task 2 的共享类型
- Produces:
  - `FriendsApi`（窄网关接口，Task 5 的真实现照此组装）：

```typescript
export type ProfileRow = { id: string; email: string; name: string | null; avatar_url: string | null };
export type FriendshipRow = { id: string; requester: string; addressee: string; status: "pending" | "accepted" };
export type MessageRow = { id: number; sender: string; recipient: string; body: string; created_at: string };

export type FriendsApi = {
  /** 当前登录用户 uuid;未登录 null */
  getUserId(): Promise<string | null>;
  findProfileByEmail(email: string): Promise<ProfileRow | null>;
  /** 唯一索引冲突时 throw(错误对象带 code "23505") */
  insertFriendship(requester: string, addressee: string): Promise<void>;
  acceptFriendship(id: string): Promise<void>;
  deleteFriendship(id: string): Promise<void>;
  /** 自己参与的全部行(RLS 已保证只回当事行) */
  listFriendships(): Promise<FriendshipRow[]>;
  listProfiles(ids: string[]): Promise<ProfileRow[]>;
  insertMessage(sender: string, recipient: string, body: string): Promise<void>;
  /** 与 friendId 的往来,新→旧,一页 50;beforeId 翻旧页 */
  listMessages(uid: string, friendId: string, beforeId?: number): Promise<MessageRow[]>;
  /** Realtime 订阅(Task 4/5 用)。返回退订函数 */
  subscribe(uid: string, handlers: {
    onFriendshipsChange(): void;
    onMessage(row: MessageRow): void;
    onPresence(onlineIds: string[]): void;
  }): () => void;
};
```

  - 纯函数 `toFriendProfile(row: ProfileRow): FriendProfile`、`buildSnapshot(uid: string, rows: FriendshipRow[], profiles: Map<string, ProfileRow>): FriendsSnapshot`
  - `FriendsManager` 类：`constructor(deps: { api: FriendsApi; push: FriendsPush })`，方法 `search(email)` / `sendRequest(userId)` / `respond(friendshipId, accept)` / `remove(friendshipId)` / `list()` / `sendMessage(friendId, body)` / `listMessages(friendId, beforeId?)`——签名与返回类型和 ShellBridge 的 friends* 一一对应
  - `FriendsPush = { friendsChanged(s: FriendsSnapshot): void; presenceChanged(ids: string[]): void; directMessage(m: DirectMessage): void }`

- [ ] **Step 1: 写失败测试**（`tests/main/friends.test.ts`，先覆盖纯函数 + 关系链方法）

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  toFriendProfile, buildSnapshot, FriendsManager,
  type FriendsApi, type FriendshipRow, type ProfileRow,
} from "../../src/main/friends.js";

const P = (id: string, email = `${id}@x.com`): ProfileRow =>
  ({ id, email, name: id.toUpperCase(), avatar_url: null });

describe("toFriendProfile", () => {
  it("snake_case 归一 camelCase,null 补空串", () => {
    expect(toFriendProfile({ id: "u1", email: "a@x.com", name: null, avatar_url: null }))
      .toEqual({ id: "u1", email: "a@x.com", name: "", avatarUrl: "" });
  });
});

describe("buildSnapshot", () => {
  const me = "me";
  const rows: FriendshipRow[] = [
    { id: "f1", requester: "me", addressee: "a", status: "accepted" },
    { id: "f2", requester: "b", addressee: "me", status: "accepted" },
    { id: "f3", requester: "me", addressee: "c", status: "pending" },
    { id: "f4", requester: "d", addressee: "me", status: "pending" },
  ];
  const profiles = new Map(["a", "b", "c", "d"].map((id) => [id, P(id)]));

  it("按 status+方向分三组,profile 取对方", () => {
    const s = buildSnapshot(me, rows, profiles);
    expect(s.friends.map((e) => e.profile.id).sort()).toEqual(["a", "b"]);
    expect(s.outgoing).toHaveLength(1);
    expect(s.outgoing[0]).toMatchObject({ friendshipId: "f3", direction: "outgoing", profile: { id: "c" } });
    expect(s.incoming[0]).toMatchObject({ friendshipId: "f4", direction: "incoming", profile: { id: "d" } });
  });

  it("profile 缺席的行丢弃(数据不完整别渲染幽灵)", () => {
    const s = buildSnapshot(me, rows, new Map([["a", P("a")]]));
    expect(s.friends).toHaveLength(1);
    expect(s.incoming).toHaveLength(0);
  });
});

function fakeApi(over: Partial<FriendsApi> = {}): FriendsApi {
  return {
    getUserId: vi.fn(async () => "me"),
    findProfileByEmail: vi.fn(async () => null),
    insertFriendship: vi.fn(async () => {}),
    acceptFriendship: vi.fn(async () => {}),
    deleteFriendship: vi.fn(async () => {}),
    listFriendships: vi.fn(async () => []),
    listProfiles: vi.fn(async () => []),
    insertMessage: vi.fn(async () => {}),
    listMessages: vi.fn(async () => []),
    subscribe: vi.fn(() => () => {}),
    ...over,
  };
}
const noPush = { friendsChanged: vi.fn(), presenceChanged: vi.fn(), directMessage: vi.fn() };

describe("FriendsManager 关系链", () => {
  it("search:邮箱命中回 FriendProfile", async () => {
    const api = fakeApi({ findProfileByEmail: vi.fn(async () => P("u2", "hit@x.com")) });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.search("hit@x.com")).toEqual({
      ok: true, value: { id: "u2", email: "hit@x.com", name: "U2", avatarUrl: "" },
    });
  });

  it("search:查无此人 = ok:true value:null(不是错误)", async () => {
    const m = new FriendsManager({ api: fakeApi(), push: noPush });
    expect(await m.search("none@x.com")).toEqual({ ok: true, value: null });
  });

  it("未登录:一律 ok:false", async () => {
    const api = fakeApi({ getUserId: vi.fn(async () => null) });
    const m = new FriendsManager({ api, push: noPush });
    const r = await m.search("a@x.com");
    expect(r.ok).toBe(false);
  });

  it("sendRequest 成功后推新快照", async () => {
    const api = fakeApi({
      listFriendships: vi.fn(async () => [
        { id: "f9", requester: "me", addressee: "u2", status: "pending" } as FriendshipRow,
      ]),
      listProfiles: vi.fn(async () => [P("u2")]),
    });
    const push = { ...noPush, friendsChanged: vi.fn() };
    const m = new FriendsManager({ api, push });
    expect(await m.sendRequest("u2")).toEqual({ ok: true, value: null });
    expect(api.insertFriendship).toHaveBeenCalledWith("me", "u2");
    expect(push.friendsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ outgoing: [expect.objectContaining({ friendshipId: "f9" })] })
    );
  });

  it("sendRequest:唯一索引冲突映射成人话", async () => {
    const api = fakeApi({
      insertFriendship: vi.fn(async () => { throw Object.assign(new Error("dup"), { code: "23505" }); }),
    });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.sendRequest("u2")).toEqual({ ok: false, message: "已发过请求或已是好友" });
  });

  it("respond accept=true 走 acceptFriendship,false 走 deleteFriendship", async () => {
    const api = fakeApi();
    const m = new FriendsManager({ api, push: noPush });
    await m.respond("f1", true);
    expect(api.acceptFriendship).toHaveBeenCalledWith("f1");
    await m.respond("f2", false);
    expect(api.deleteFriendship).toHaveBeenCalledWith("f2");
  });

  it("api throw 普通错误 → ok:false 带 message,不向上炸", async () => {
    const api = fakeApi({ listFriendships: vi.fn(async () => { throw new Error("网断了"); }) });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.list()).toEqual({ ok: false, message: "网断了" });
  });

  it("sendMessage 委托 insertMessage(sender=自己)", async () => {
    const api = fakeApi();
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.sendMessage("u2", "hi")).toEqual({ ok: true, value: null });
    expect(api.insertMessage).toHaveBeenCalledWith("me", "u2", "hi");
  });

  it("listMessages 行归一成 DirectMessage", async () => {
    const api = fakeApi({
      listMessages: vi.fn(async () => [
        { id: 7, sender: "u2", recipient: "me", body: "yo", created_at: "2026-08-18T00:00:00Z" },
      ]),
    });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.listMessages("u2")).toEqual({
      ok: true,
      value: [{ id: 7, sender: "u2", recipient: "me", body: "yo", createdAt: "2026-08-18T00:00:00Z" }],
    });
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/main/friends.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/friends.js'`

- [ ] **Step 3: 写 `src/main/friends.ts` 实现**

```typescript
// friends — 好友系统主进程编排层。
// FriendsManager 只依赖窄接口 FriendsApi(真 supabase 组装隔离在
// supabaseFriendsApi.ts,同 account.ts 的 SupabaseLike 模式);单测注入假实现。
// 错误哲学:业务/网络失败 → FriendsResult ok:false(渲染层内联提示),不 throw。

import type {
  DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot, FriendshipEntry,
} from "../shared/friends.js";

export type ProfileRow = { id: string; email: string; name: string | null; avatar_url: string | null };
export type FriendshipRow = { id: string; requester: string; addressee: string; status: "pending" | "accepted" };
export type MessageRow = { id: number; sender: string; recipient: string; body: string; created_at: string };

export type FriendsApi = {
  getUserId(): Promise<string | null>;
  findProfileByEmail(email: string): Promise<ProfileRow | null>;
  insertFriendship(requester: string, addressee: string): Promise<void>;
  acceptFriendship(id: string): Promise<void>;
  deleteFriendship(id: string): Promise<void>;
  listFriendships(): Promise<FriendshipRow[]>;
  listProfiles(ids: string[]): Promise<ProfileRow[]>;
  insertMessage(sender: string, recipient: string, body: string): Promise<void>;
  listMessages(uid: string, friendId: string, beforeId?: number): Promise<MessageRow[]>;
  subscribe(uid: string, handlers: {
    onFriendshipsChange(): void;
    onMessage(row: MessageRow): void;
    onPresence(onlineIds: string[]): void;
  }): () => void;
};

export type FriendsPush = {
  friendsChanged(snapshot: FriendsSnapshot): void;
  presenceChanged(onlineUserIds: string[]): void;
  directMessage(message: DirectMessage): void;
};

export function toFriendProfile(row: ProfileRow): FriendProfile {
  return { id: row.id, email: row.email, name: row.name ?? "", avatarUrl: row.avatar_url ?? "" };
}

export function toDirectMessage(row: MessageRow): DirectMessage {
  return { id: row.id, sender: row.sender, recipient: row.recipient, body: row.body, createdAt: row.created_at };
}

/** 关系行 + 对方 profile → 三组快照。profile 缺席的行丢弃(别渲染幽灵) */
export function buildSnapshot(
  uid: string, rows: FriendshipRow[], profiles: Map<string, ProfileRow>
): FriendsSnapshot {
  const friends: FriendshipEntry[] = [];
  const incoming: FriendshipEntry[] = [];
  const outgoing: FriendshipEntry[] = [];
  for (const row of rows) {
    const otherId = row.requester === uid ? row.addressee : row.requester;
    const other = profiles.get(otherId);
    if (!other) continue;
    const entry: FriendshipEntry = {
      friendshipId: row.id,
      profile: toFriendProfile(other),
      status: row.status,
      direction: row.requester === uid ? "outgoing" : "incoming",
    };
    if (row.status === "accepted") friends.push(entry);
    else (entry.direction === "incoming" ? incoming : outgoing).push(entry);
  }
  return { friends, incoming, outgoing };
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const NOT_SIGNED_IN = "未登录,登录后才能用好友功能";

export class FriendsManager {
  private readonly api: FriendsApi;
  private readonly push: FriendsPush;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: { api: FriendsApi; push: FriendsPush }) {
    this.api = deps.api;
    this.push = deps.push;
  }

  /** 所有方法共用的前置:拿 uid,没登录统一 ok:false */
  private async withUid<T>(fn: (uid: string) => Promise<T>): Promise<FriendsResult<T>> {
    try {
      const uid = await this.api.getUserId();
      if (!uid) return { ok: false, message: NOT_SIGNED_IN };
      return { ok: true, value: await fn(uid) };
    } catch (e) {
      return { ok: false, message: message(e) };
    }
  }

  private async snapshot(uid: string): Promise<FriendsSnapshot> {
    const rows = await this.api.listFriendships();
    const ids = [...new Set(rows.map((r) => (r.requester === uid ? r.addressee : r.requester)))];
    const profiles = new Map((await this.api.listProfiles(ids)).map((p) => [p.id, p]));
    return buildSnapshot(uid, rows, profiles);
  }

  /** 变更后重拉快照推给渲染层(本端操作与对端 Realtime 同一条出口) */
  private async pushSnapshot(uid: string): Promise<void> {
    this.push.friendsChanged(await this.snapshot(uid));
  }

  async search(email: string): Promise<FriendsResult<FriendProfile | null>> {
    return this.withUid(async () => {
      const row = await this.api.findProfileByEmail(email);
      return row ? toFriendProfile(row) : null;
    });
  }

  async sendRequest(userId: string): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      try {
        await this.api.insertFriendship(uid, userId);
      } catch (e) {
        // 无序对唯一索引冲突 = 重复请求/已是好友,给人话不给 SQL 报错
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
          throw new Error("已发过请求或已是好友");
        }
        throw e;
      }
      await this.pushSnapshot(uid);
      return null;
    });
  }

  async respond(friendshipId: string, accept: boolean): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      if (accept) await this.api.acceptFriendship(friendshipId);
      else await this.api.deleteFriendship(friendshipId);
      await this.pushSnapshot(uid);
      return null;
    });
  }

  async remove(friendshipId: string): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      await this.api.deleteFriendship(friendshipId);
      await this.pushSnapshot(uid);
      return null;
    });
  }

  async list(): Promise<FriendsResult<FriendsSnapshot>> {
    return this.withUid((uid) => this.snapshot(uid));
  }

  async sendMessage(friendId: string, body: string): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      await this.api.insertMessage(uid, friendId, body);
      return null;
    });
  }

  async listMessages(friendId: string, beforeId?: number): Promise<FriendsResult<DirectMessage[]>> {
    return this.withUid(async (uid) =>
      (await this.api.listMessages(uid, friendId, beforeId)).map(toDirectMessage)
    );
  }

  /** 登录后调:起 Realtime 订阅 + 推一次初始快照。幂等(重复 start 先 stop) */
  async start(): Promise<void> {
    this.stop();
    const uid = await this.api.getUserId();
    if (!uid) return;
    this.unsubscribe = this.api.subscribe(uid, {
      onFriendshipsChange: () => { void this.pushSnapshot(uid).catch(() => {}); },
      onMessage: (row) => this.push.directMessage(toDirectMessage(row)),
      onPresence: (ids) => this.push.presenceChanged(ids),
    });
    await this.pushSnapshot(uid).catch(() => {});
  }

  /** 登出时调:退订 + 推空快照/空在线集(UI 立即清) */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.push.friendsChanged({ friends: [], incoming: [], outgoing: [] });
    this.push.presenceChanged([]);
  }
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run tests/main/friends.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add src/main/friends.ts tests/main/friends.test.ts
git commit -m "feat(friends): FriendsManager 关系链——窄接口 FriendsApi 注入,错误结构化回流"
```

---

### Task 4: FriendsManager 生命周期/Realtime 推送测试补全（TDD）

**Files:**
- Modify: `tests/main/friends.test.ts`（追加 describe 块；`src/main/friends.ts` 的 start/stop 已在 Task 3 落地，本任务用测试钉住行为，测出问题就地修实现）

**Interfaces:**
- Consumes: Task 3 的 `FriendsManager.start()/stop()`、`FriendsApi.subscribe`

- [ ] **Step 1: 追加失败/钉行为测试**（追加到 `tests/main/friends.test.ts` 末尾）

```typescript
describe("FriendsManager 生命周期", () => {
  it("start:订阅 + 推初始快照;handlers 触发时转推", async () => {
    let captured: Parameters<FriendsApi["subscribe"]>[1] | null = null;
    const api = fakeApi({
      subscribe: vi.fn((_uid, handlers) => { captured = handlers; return () => {}; }),
    });
    const push = { friendsChanged: vi.fn(), presenceChanged: vi.fn(), directMessage: vi.fn() };
    const m = new FriendsManager({ api, push });
    await m.start();
    expect(push.friendsChanged).toHaveBeenCalledTimes(1); // 初始快照
    captured!.onPresence(["u2"]);
    expect(push.presenceChanged).toHaveBeenCalledWith(["u2"]);
    captured!.onMessage({ id: 1, sender: "u2", recipient: "me", body: "hi", created_at: "t" });
    expect(push.directMessage).toHaveBeenCalledWith(
      { id: 1, sender: "u2", recipient: "me", body: "hi", createdAt: "t" });
  });

  it("start 时未登录:不订阅不推", async () => {
    const api = fakeApi({ getUserId: vi.fn(async () => null) });
    const push = { friendsChanged: vi.fn(), presenceChanged: vi.fn(), directMessage: vi.fn() };
    await new FriendsManager({ api, push }).start();
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(push.friendsChanged).not.toHaveBeenCalled();
  });

  it("stop:退订 + 推空快照清 UI", async () => {
    const unsub = vi.fn();
    const api = fakeApi({ subscribe: vi.fn(() => unsub) });
    const push = { friendsChanged: vi.fn(), presenceChanged: vi.fn(), directMessage: vi.fn() };
    const m = new FriendsManager({ api, push });
    await m.start();
    m.stop();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(push.friendsChanged).toHaveBeenLastCalledWith({ friends: [], incoming: [], outgoing: [] });
    expect(push.presenceChanged).toHaveBeenLastCalledWith([]);
  });

  it("重复 start 幂等:旧订阅先退", async () => {
    const unsub = vi.fn();
    const api = fakeApi({ subscribe: vi.fn(() => unsub) });
    const m = new FriendsManager({ api, push: { friendsChanged: vi.fn(), presenceChanged: vi.fn(), directMessage: vi.fn() } });
    await m.start();
    await m.start();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(api.subscribe).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 跑测**

Run: `npx vitest run tests/main/friends.test.ts`
Expected: 若 Task 3 实现正确则 PASS；FAIL 则修 `src/main/friends.ts` 直到绿（注意重复 start 幂等靠 `start()` 开头的 `this.stop()`——但 stop 会推空快照，若测试因此多一次 friendsChanged 计数，把 `stop()` 拆成内部 `teardown()`（只退订不推空）+ 公开 `stop()`（teardown + 推空），`start()` 开头改调 `teardown()`）

- [ ] **Step 3: Commit**

```bash
git add tests/main/friends.test.ts src/main/friends.ts
git commit -m "test(friends): 生命周期钉死——start 订阅/stop 清场/重复 start 幂等"
```

---

### Task 5: 真 supabase 网关 + 主进程接线

**Files:**
- Create: `src/main/supabaseFriendsApi.ts`
- Modify: `src/main/account.ts`（factory 返回值补 raw client 出口）
- Modify: `src/main/index.ts`
- Test: `tests/main/supabaseFriendsApi.test.ts`（薄网关只测纯逻辑段：presence state 聚合）

**Interfaces:**
- Consumes: Task 3 的 `FriendsApi` 形状；`account.ts` 的 `createSupabaseAuthClient`
- Produces: `createSupabaseFriendsApi(client: SupabaseClient): FriendsApi`；`presenceStateToIds(state: Record<string, unknown[]>): string[]`

- [ ] **Step 1: 改 `src/main/account.ts` 的 factory——真 client 双出口**

`createSupabaseAuthClient` 现在把真 client cast 成 `SupabaseLike` 后丢掉了原对象，好友网关需要完整 client（`from`/`channel`）。改返回形状（唯一调用点在 `index.ts`，同 PR 内一起改，不算破坏接口）：

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

/** 真 client 工厂——auth 视角(SupabaseLike)给 AccountManager,raw 完整 client
    给好友网关(from/channel)。同一个实例双出口:同一登录态,别建两个 client */
export function createSupabaseAuthClient(filePath: string): { auth: SupabaseLike; raw: SupabaseClient } {
  const storage = createAuthStorage(filePath);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage,
    },
  });
  return { auth: client as unknown as SupabaseLike, raw: client };
}
```

`index.ts` 原调用处 `client: createSupabaseAuthClient(...)` 相应改为解构（Step 3 一并做）。

- [ ] **Step 2: 写 `src/main/supabaseFriendsApi.ts`**

```typescript
// supabaseFriendsApi — FriendsApi 的真 supabase 实现(唯一碰 supabase-js
// 查询构造器/Realtime 的地方,对应 account.ts 的 createSupabaseAuthClient 层)。
// 单测只测纯逻辑段(presenceStateToIds);查询链本身薄到无逻辑,错误原样上抛
// 由 FriendsManager 收敛成 FriendsResult。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FriendsApi, FriendshipRow, MessageRow, ProfileRow } from "./friends.js";

const PAGE = 50;

/** presenceState() 的形状 {key: metas[]} → 在线 userId 列表(key 即 uid) */
export function presenceStateToIds(state: Record<string, unknown[]>): string[] {
  return Object.keys(state).sort();
}

/** supabase-js 的 {data,error} 归一:error 转 throw(带 pg code,上层认 23505) */
function unwrap<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    throw Object.assign(new Error(res.error.message), { code: res.error.code });
  }
  return res.data;
}

export function createSupabaseFriendsApi(client: SupabaseClient): FriendsApi {
  return {
    async getUserId() {
      const { data } = await client.auth.getUser();
      return data.user?.id ?? null;
    },

    async findProfileByEmail(email) {
      const res = await client.from("profiles").select("id,email,name,avatar_url")
        .eq("email", email).maybeSingle();
      return unwrap(res) as ProfileRow | null;
    },

    async insertFriendship(requester, addressee) {
      unwrap(await client.from("friendships").insert({ requester, addressee, status: "pending" }));
    },

    async acceptFriendship(id) {
      unwrap(await client.from("friendships")
        .update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", id));
    },

    async deleteFriendship(id) {
      unwrap(await client.from("friendships").delete().eq("id", id));
    },

    async listFriendships() {
      // RLS 已把可见范围钉在"自己参与的行",不用再拼 or 条件
      const res = await client.from("friendships").select("id,requester,addressee,status");
      return (unwrap(res) ?? []) as FriendshipRow[];
    },

    async listProfiles(ids) {
      if (ids.length === 0) return [];
      const res = await client.from("profiles").select("id,email,name,avatar_url").in("id", ids);
      return (unwrap(res) ?? []) as ProfileRow[];
    },

    async insertMessage(sender, recipient, body) {
      unwrap(await client.from("messages").insert({ sender, recipient, body }));
    },

    async listMessages(uid, friendId, beforeId) {
      let q = client.from("messages").select("id,sender,recipient,body,created_at")
        .or(`and(sender.eq.${uid},recipient.eq.${friendId}),and(sender.eq.${friendId},recipient.eq.${uid})`)
        .order("id", { ascending: false }).limit(PAGE);
      if (beforeId !== undefined) q = q.lt("id", beforeId);
      return (unwrap(await q) ?? []) as MessageRow[];
    },

    subscribe(uid, handlers) {
      // friendships:自己两个方向的行任何变化都重拉快照(粗粒度,量小)
      const fsChannel = client.channel(`friendships-${uid}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "friendships", filter: `requester=eq.${uid}` },
          () => handlers.onFriendshipsChange())
        .on("postgres_changes",
          { event: "*", schema: "public", table: "friendships", filter: `addressee=eq.${uid}` },
          () => handlers.onFriendshipsChange())
        .subscribe();

      // messages:只订"发给我的" insert(自己发的不推,bridge 调用返回即成功)
      const msgChannel = client.channel(`messages-${uid}`)
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "messages", filter: `recipient=eq.${uid}` },
          (payload) => handlers.onMessage(payload.new as MessageRow))
        .subscribe();

      // presence:track key = 自己 uid,sync 时把整个 state 的 key 集推出去
      const presenceChannel = client.channel("online-users", {
        config: { presence: { key: uid } },
      });
      presenceChannel
        .on("presence", { event: "sync" }, () =>
          handlers.onPresence(presenceStateToIds(presenceChannel.presenceState())))
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void presenceChannel.track({ at: Date.now() });
        });

      return () => {
        void client.removeChannel(fsChannel);
        void client.removeChannel(msgChannel);
        void client.removeChannel(presenceChannel);
      };
    },
  };
}
```

- [ ] **Step 3: 接线 `src/main/index.ts`**

import 区加：

```typescript
import { FriendsManager } from "./friends.js";
import { createSupabaseFriendsApi } from "./supabaseFriendsApi.js";
```

创建 AccountManager 的段落改成（factory 新返回形状 + FriendsManager 挂账号生命周期）：

```typescript
  const supabase = createSupabaseAuthClient(join(app.getPath("userData"), "auth.json"));
  const friends = new FriendsManager({
    api: createSupabaseFriendsApi(supabase.raw),
    push: {
      friendsChanged: (s) => win.webContents.send(CHANNELS.friendsChanged, s),
      presenceChanged: (ids) => win.webContents.send(CHANNELS.presenceChanged, ids),
      directMessage: (m) => win.webContents.send(CHANNELS.directMessage, m),
    },
  });
  accountManager = new AccountManager({
    openExternal: (url) => shell.openExternal(url),
    onChange: (info) => {
      win.webContents.send(CHANNELS.accountChanged, info);
      // 好友子系统跟着登录态起落:登录起订阅,登出清场。start 内部自查 uid,
      // 不 await——推送式子系统,失败静默(下次 friendsList 调用还有机会报错)
      if (info.signedIn) void friends.start();
      else friends.stop();
    },
    client: supabase.auth,
  });
```

冷启动 restore 成功也会走 onChange → friends.start()，无需另接。

IPC handler 区（`signOut` handle 之后）加：

```typescript
  // 好友系统:全部结构化回流(FriendsResult),渲染层按 ok 分支,不靠 invoke reject
  ipcMain.handle(CHANNELS.friendsSearch, (_e, email: string) => friends.search(email));
  ipcMain.handle(CHANNELS.friendsSendRequest, (_e, userId: string) => friends.sendRequest(userId));
  ipcMain.handle(CHANNELS.friendsRespond, (_e, id: string, accept: boolean) => friends.respond(id, accept));
  ipcMain.handle(CHANNELS.friendsRemove, (_e, id: string) => friends.remove(id));
  ipcMain.handle(CHANNELS.friendsList, () => friends.list());
  ipcMain.handle(CHANNELS.friendsSendMessage, (_e, friendId: string, body: string) =>
    friends.sendMessage(friendId, body));
  ipcMain.handle(CHANNELS.friendsListMessages, (_e, friendId: string, beforeId?: number) =>
    friends.listMessages(friendId, beforeId));
```

- [ ] **Step 4: 网关纯逻辑测试** `tests/main/supabaseFriendsApi.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { presenceStateToIds } from "../../src/main/supabaseFriendsApi.js";

describe("presenceStateToIds", () => {
  it("state 的 key 即在线 uid,排序输出", () => {
    expect(presenceStateToIds({ b: [{}], a: [{}, {}] })).toEqual(["a", "b"]);
  });
  it("空 state → 空数组", () => {
    expect(presenceStateToIds({})).toEqual([]);
  });
});
```

- [ ] **Step 5: 跑全量门禁**（account.test.ts 可能因 factory 返回形状改动需要同步——该测试文件只测 AccountManager 注入假 client，不调 factory，预期不受影响；若有编译错就地修）

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/main/supabaseFriendsApi.ts src/main/account.ts src/main/index.ts tests/main/supabaseFriendsApi.test.ts
git commit -m "feat(friends): 真 supabase 网关 + 主进程接线——client 双出口共用登录态,好友子系统挂账号生命周期"
```

---

### Task 6: 渲染层 store slice + 纯函数 helpers（TDD helpers）

**Files:**
- Create: `src/renderer/src/lib/friendsState.ts`
- Modify: `src/renderer/src/store.ts`
- Test: `tests/renderer/friendsState.test.ts`

**Interfaces:**
- Consumes: Task 2 类型 + bridge 方法
- Produces（组件任务用的 store 词汇表）:
  - state: `friendsSnapshot: FriendsSnapshot`、`onlineIds: string[]`、`friendChat: FriendProfile | null`（非 null = DM 面板开着，对应 protocolOpen/gitGraphOpen 的槽位）、`dmByFriend: Record<string, DirectMessage[]>`（旧→新）、`unreadByFriend: Record<string, number>`、`friendError: string | null`
  - actions: `refreshFriends()`、`searchFriend(email): Promise<FriendProfile | null>`、`addFriend(userId)`、`respondFriend(friendshipId, accept)`、`removeFriend(friendshipId)`、`openFriendChat(profile)`、`closeFriendChat()`、`sendDm(body)`、`loadOlderDms()`
  - helpers: `mergeDm(list: DirectMessage[], msg: DirectMessage): DirectMessage[]`（按 id 去重升序插入）、`prependOlder(list: DirectMessage[], older: DirectMessage[]): DirectMessage[]`（older 是新→旧一页，翻转后拼头部去重）

- [ ] **Step 1: helpers 失败测试** `tests/renderer/friendsState.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { mergeDm, prependOlder } from "../../src/renderer/src/lib/friendsState.js";
import type { DirectMessage } from "../../src/shared/friends.js";

const M = (id: number): DirectMessage =>
  ({ id, sender: "a", recipient: "b", body: `m${id}`, createdAt: "t" });

describe("mergeDm", () => {
  it("升序插入", () => {
    expect(mergeDm([M(1), M(3)], M(2)).map((m) => m.id)).toEqual([1, 2, 3]);
  });
  it("重复 id 去重(Realtime 推送与本地回显撞车)", () => {
    expect(mergeDm([M(1), M(2)], M(2)).map((m) => m.id)).toEqual([1, 2]);
  });
});

describe("prependOlder", () => {
  it("新→旧的一页翻转拼头部", () => {
    expect(prependOlder([M(5), M(6)], [M(4), M(3)]).map((m) => m.id)).toEqual([3, 4, 5, 6]);
  });
  it("与现有重叠的去重", () => {
    expect(prependOlder([M(4), M(5)], [M(4), M(3)]).map((m) => m.id)).toEqual([3, 4, 5]);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/renderer/friendsState.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写 `src/renderer/src/lib/friendsState.ts`**

```typescript
// friendsState — DM 列表的纯函数投影(store 里只调,不摊逻辑,好测)。
// 列表恒定旧→新升序、按 id 唯一。

import type { DirectMessage } from "../../../shared/friends.js";

/** 单条消息按 id 去重升序插入(Realtime 推送 / 发送回显共用) */
export function mergeDm(list: DirectMessage[], msg: DirectMessage): DirectMessage[] {
  if (list.some((m) => m.id === msg.id)) return list;
  return [...list, msg].sort((a, b) => a.id - b.id);
}

/** 翻旧页:bridge 回的一页是新→旧,翻转拼到头部,与现有重叠去重 */
export function prependOlder(list: DirectMessage[], older: DirectMessage[]): DirectMessage[] {
  const have = new Set(list.map((m) => m.id));
  const fresh = [...older].reverse().filter((m) => !have.has(m.id));
  return [...fresh, ...list];
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run tests/renderer/friendsState.test.ts`
Expected: PASS

- [ ] **Step 5: 扩 `src/renderer/src/store.ts`**

import 加：

```typescript
import type { DirectMessage, FriendProfile, FriendsSnapshot } from "../../shared/friends.js";
import { mergeDm, prependOlder } from "./lib/friendsState.js";
```

`ChatState` 接口 `attachError` 之后加 state 字段：

```typescript
  /** 好友快照(主进程推送镜像;未登录/登出 = 三空数组) */
  friendsSnapshot: FriendsSnapshot;
  /** 当前在线的 userId(presence 推送镜像) */
  onlineIds: string[];
  /** 非 null = DM 面板开着(右侧叠加槽位,与 protocolOpen/gitGraphOpen 互斥) */
  friendChat: FriendProfile | null;
  /** friendId → 消息列表(旧→新)。只留打开过的会话,登出全清 */
  dmByFriend: Record<string, DirectMessage[]>;
  /** friendId → 未读数(面板开着的好友不计,打开即清零) */
  unreadByFriend: Record<string, number>;
  /** 好友区/DM 面板的内联错误(FriendsResult ok:false 的 message 落这) */
  friendError: string | null;
```

方法声明区（`decide` 之前）加：

```typescript
  refreshFriends(): Promise<void>;
  /** 邮箱精确搜索。null = 查无此人;错误落 friendError 并回 null */
  searchFriend(email: string): Promise<FriendProfile | null>;
  addFriend(userId: string): Promise<void>;
  respondFriend(friendshipId: string, accept: boolean): Promise<void>;
  removeFriend(friendshipId: string): Promise<void>;
  /** 打开与该好友的 DM 面板(互斥收口其他面板),没历史就拉一页 */
  openFriendChat(profile: FriendProfile): Promise<void>;
  closeFriendChat(): void;
  sendDm(body: string): Promise<void>;
  /** DM 面板顶部"加载更早"——按当前最旧 id 往前翻一页 */
  loadOlderDms(): Promise<void>;
```

初始值区（`attachError: null,` 之后）加：

```typescript
  friendsSnapshot: { friends: [], incoming: [], outgoing: [] },
  onlineIds: [],
  friendChat: null,
  dmByFriend: {},
  unreadByFriend: {},
  friendError: null,
```

实现（放 `signOut` 实现之后）：

```typescript
  async refreshFriends() {
    const r = await window.otter.friendsList();
    if (r.ok) set({ friendsSnapshot: r.value, friendError: null });
    else set({ friendError: r.message });
  },

  async searchFriend(email) {
    const r = await window.otter.friendsSearch(email);
    if (!r.ok) {
      set({ friendError: r.message });
      return null;
    }
    set({ friendError: null });
    return r.value;
  },

  async addFriend(userId) {
    const r = await window.otter.friendsSendRequest(userId);
    set({ friendError: r.ok ? null : r.message }); // 成功后的快照由主进程推,不本地猜
  },

  async respondFriend(friendshipId, accept) {
    const r = await window.otter.friendsRespond(friendshipId, accept);
    set({ friendError: r.ok ? null : r.message });
  },

  async removeFriend(friendshipId) {
    const r = await window.otter.friendsRemove(friendshipId);
    set({ friendError: r.ok ? null : r.message });
  },

  async openFriendChat(profile) {
    set((s) => ({
      friendChat: profile,
      protocolOpen: false, gitGraphOpen: false, settingsSection: null, // 互斥:同一右侧槽位
      unreadByFriend: without(s.unreadByFriend, profile.id), // 打开即已读
      friendError: null,
    }));
    if ((get().dmByFriend[profile.id] ?? []).length === 0) {
      const r = await window.otter.friendsListMessages(profile.id);
      if (r.ok) {
        const list = [...r.value].reverse(); // bridge 回新→旧,存旧→新
        set((s) => ({ dmByFriend: { ...s.dmByFriend, [profile.id]: list } }));
      } else set({ friendError: r.message });
    }
  },

  closeFriendChat: () => set({ friendChat: null }),

  async sendDm(body) {
    const friend = get().friendChat;
    if (!friend || !body.trim()) return;
    const r = await window.otter.friendsSendMessage(friend.id, body.trim());
    if (!r.ok) {
      set({ friendError: r.message });
      return;
    }
    // 自己发的消息主进程不推(onDirectMessage 只推对端来信),重拉最新一页回显——
    // 拿真 id/时间戳,不本地造假消息(与"快照由主进程推"同一哲学)
    const page = await window.otter.friendsListMessages(friend.id);
    if (page.ok) {
      const list = [...page.value].reverse();
      set((s) => ({
        dmByFriend: { ...s.dmByFriend, [friend.id]: list },
        friendError: null,
      }));
    }
  },

  async loadOlderDms() {
    const friend = get().friendChat;
    if (!friend) return;
    const current = get().dmByFriend[friend.id] ?? [];
    const oldest = current[0];
    if (!oldest) return;
    const r = await window.otter.friendsListMessages(friend.id, oldest.id);
    if (r.ok) {
      set((s) => ({
        dmByFriend: {
          ...s.dmByFriend,
          [friend.id]: prependOlder(s.dmByFriend[friend.id] ?? [], r.value),
        },
      }));
    } else set({ friendError: r.message });
  },
```

`boot()` 里 `window.otter.onAccountChanged(...)` 之后加订阅：

```typescript
    window.otter.onFriendsChanged((friendsSnapshot) => set({ friendsSnapshot }));
    window.otter.onPresenceChanged((onlineIds) => set({ onlineIds }));
    window.otter.onDirectMessage((msg) =>
      set((s) => {
        const open = s.friendChat?.id === msg.sender;
        return {
          // 只并入已打开过的会话缓冲;没打开过的等 openFriendChat 拉历史
          dmByFriend: s.dmByFriend[msg.sender]
            ? { ...s.dmByFriend, [msg.sender]: mergeDm(s.dmByFriend[msg.sender]!, msg) }
            : s.dmByFriend,
          // 面板正对着这个人 = 已读;否则未读 +1
          unreadByFriend: open
            ? s.unreadByFriend
            : { ...s.unreadByFriend, [msg.sender]: (s.unreadByFriend[msg.sender] ?? 0) + 1 },
        };
      })
    );
```

`onAccountChanged` 回调改为登出时顺带清好友态（原回调是 `(account) => set({ account })`）：

```typescript
    window.otter.onAccountChanged((account) =>
      set(
        account.signedIn
          ? { account }
          : {
              account,
              // 登出清场:快照/在线/DM 缓冲/未读全回初始(主进程也会推空快照,双保险)
              friendsSnapshot: { friends: [], incoming: [], outgoing: [] },
              onlineIds: [], friendChat: null, dmByFriend: {}, unreadByFriend: {},
            }
      )
    );
```

boot 末尾的并发取数不加 friendsList——登录时主进程 `friends.start()` 自会推快照。

互斥收口（对齐既有做法，逐处补 `friendChat: null`）：
- `enterChat`（`gitGraphOpen: false,` 之后）
- `newSession`（同上）
- `openSettings` 三个分支的 set
- `openProtocol` / `openGitGraph` 的 set

- [ ] **Step 6: 全量门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/friendsState.ts src/renderer/src/store.ts tests/renderer/friendsState.test.ts
git commit -m "feat(friends): 渲染层 friends slice——快照/presence/DM 镜像,互斥收口补 friendChat"
```

---

### Task 7: 侧边栏好友区组件

**Files:**
- Create: `src/renderer/src/components/FriendsSection.tsx`
- Modify: `src/renderer/src/App.tsx`（AppSidebar 里挂载）

**Interfaces:**
- Consumes: Task 6 的 store 字段/actions；shadcn 侧栏组件（`@/components/ui/sidebar.js` 的 `SidebarMenu/SidebarMenuItem/SidebarMenuButton/SidebarMenuAction`，App.tsx 既有 import）
- Produces: `<FriendsSection />`（自闭合，无 props——全部状态走 store）

- [ ] **Step 1: 写 `src/renderer/src/components/FriendsSection.tsx`**

```tsx
// FriendsSection — 侧边栏常驻好友区:添加好友(邮箱精确搜索)/待处理请求/好友列表+在线点。
// 全部状态走 store,不直接摸 window.otter(硬规则)。未登录显示占位。

import { useState } from "react";
import { useChat } from "../store.js";
import type { FriendProfile } from "../../../shared/friends.js";
import {
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction,
} from "@/components/ui/sidebar.js";
import { Button } from "@/components/ui/button.js";

const SECTION_LABEL = "text-[11px] text-muted-foreground tracking-[0.04em] pt-[10px] px-[10px] pb-[2px]";

export function FriendsSection() {
  const account = useChat((s) => s.account);
  const snapshot = useChat((s) => s.friendsSnapshot);
  const onlineIds = useChat((s) => s.onlineIds);
  const unread = useChat((s) => s.unreadByFriend);
  const friendError = useChat((s) => s.friendError);
  const searchFriend = useChat((s) => s.searchFriend);
  const addFriend = useChat((s) => s.addFriend);
  const respondFriend = useChat((s) => s.respondFriend);
  const removeFriend = useChat((s) => s.removeFriend);
  const openFriendChat = useChat((s) => s.openFriendChat);
  const friendChat = useChat((s) => s.friendChat);

  const [query, setQuery] = useState("");
  const [hit, setHit] = useState<FriendProfile | null | "none">(null); // "none" = 搜过没命中

  if (!account.signedIn) {
    return <div className={SECTION_LABEL}>好友 · 登录后可用</div>;
  }

  const online = new Set(onlineIds);
  const doSearch = async () => {
    const email = query.trim();
    if (!email) return;
    const found = await searchFriend(email);
    setHit(found ?? "none");
  };

  return (
    <>
      <div className={SECTION_LABEL}>好友</div>
      {/* 添加好友:邮箱精确搜索 → 命中卡片一键发请求 */}
      <div className="px-[10px] pb-1 flex gap-1">
        <input
          className="flex-1 min-w-0 bg-transparent border border-border rounded px-2 py-1 text-xs"
          placeholder="按邮箱加好友"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHit(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }}
        />
        <Button variant="ghost" size="sm" className="px-2 text-xs" onClick={() => void doSearch()}>
          搜
        </Button>
      </div>
      {hit === "none" && <p className="px-[10px] text-xs text-muted-foreground">没有这个邮箱的用户。</p>}
      {hit !== null && hit !== "none" && (
        <div className="mx-[10px] mb-1 px-2 py-1 border border-border rounded text-xs flex items-center gap-1">
          <span className="flex-1 min-w-0 truncate">{hit.name || hit.email}</span>
          {hit.id === account.email ? null : (
            <Button variant="ghost" size="sm" className="px-2 text-xs"
              onClick={() => { void addFriend(hit.id); setHit(null); setQuery(""); }}>
              发请求
            </Button>
          )}
        </div>
      )}
      {friendError && <p className="px-[10px] text-xs text-err">{friendError}</p>}

      {/* 收到的请求:就地 接受/拒绝 */}
      {snapshot.incoming.length > 0 && (
        <>
          <div className={SECTION_LABEL}>好友请求 · {snapshot.incoming.length}</div>
          <SidebarMenu>
            {snapshot.incoming.map((e) => (
              <SidebarMenuItem key={e.friendshipId}>
                <SidebarMenuButton className="h-auto py-[5px] cursor-default hover:bg-transparent">
                  <span className="flex-1 min-w-0 truncate text-xs">{e.profile.name || e.profile.email}</span>
                  <span className="flex gap-1">
                    <Button variant="ghost" size="sm" className="px-[6px] text-xs text-brand"
                      onClick={(ev) => { ev.stopPropagation(); void respondFriend(e.friendshipId, true); }}>
                      接受
                    </Button>
                    <Button variant="ghost" size="sm" className="px-[6px] text-xs text-muted-foreground"
                      onClick={(ev) => { ev.stopPropagation(); void respondFriend(e.friendshipId, false); }}>
                      拒绝
                    </Button>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </>
      )}

      {/* 好友列表:在线点 + 未读角标,点开 DM 面板;发出未回应的请求灰显尾缀 */}
      <SidebarMenu>
        {snapshot.friends.map((e) => (
          <SidebarMenuItem key={e.friendshipId}>
            <SidebarMenuButton
              className="h-auto py-[5px]"
              isActive={friendChat?.id === e.profile.id}
              onClick={() => void openFriendChat(e.profile)}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${online.has(e.profile.id) ? "bg-brand" : "bg-border"}`} />
              <span className="flex-1 min-w-0 truncate text-xs">{e.profile.name || e.profile.email}</span>
              {(unread[e.profile.id] ?? 0) > 0 && (
                <span className="text-[10px] font-semibold text-brand">{unread[e.profile.id]}</span>
              )}
            </SidebarMenuButton>
            <SidebarMenuAction
              showOnHover
              title="删除好友"
              onClick={(ev) => {
                ev.stopPropagation();
                if (confirm(`删除好友 ${e.profile.name || e.profile.email}?`)) {
                  void removeFriend(e.friendshipId);
                }
              }}
            >
              ✕
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
        {snapshot.outgoing.map((e) => (
          <SidebarMenuItem key={e.friendshipId}>
            <SidebarMenuButton disabled className="h-auto py-[5px] opacity-55 cursor-default hover:bg-transparent">
              <span className="flex-1 min-w-0 truncate text-xs">{e.profile.name || e.profile.email}</span>
              <span className="text-[10px] text-muted-foreground">等对方接受</span>
            </SidebarMenuButton>
            <SidebarMenuAction showOnHover title="撤回请求"
              onClick={(ev) => { ev.stopPropagation(); void removeFriend(e.friendshipId); }}>
              ✕
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </>
  );
}
```

注意 `hit.id === account.email` 是 bug 味的比较（id 是 uuid、email 是邮箱，永不相等）——正确写法：搜到自己时不给发请求按钮，需要比对邮箱：`hit.email === account.email`。实现时用后者。

- [ ] **Step 2: 挂进 `AppSidebar`**

`App.tsx` import 区加 `import { FriendsSection } from "./components/FriendsSection.js";`
`<SidebarContent>` 里非设置模式分支（会话 `SidebarMenu` 之后、`</SidebarContent>` 之前）加：

```tsx
          <FriendsSection />
```

- [ ] **Step 3: 门禁 + 手动烟测**

Run: `npm test`（组件不上单测——repo 既有惯例,组件层靠手动验收）
Expected: 全绿

手动:`npm run dev`（先杀旧 Electron 实例）,侧栏出现好友区;未登录显示「登录后可用」。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/FriendsSection.tsx src/renderer/src/App.tsx
git commit -m "feat(friends): 侧边栏好友区——搜索加友/请求收发/在线点/未读角标"
```

---

### Task 8: DM 聊天面板 + App 接线

**Files:**
- Create: `src/renderer/src/components/FriendChatView.tsx`
- Modify: `src/renderer/src/App.tsx`（panel 分发）

**Interfaces:**
- Consumes: Task 6 store（`friendChat`/`dmByFriend`/`onlineIds`/`sendDm`/`loadOlderDms`/`closeFriendChat`/`panelWide`/`togglePanelWide`）；面板壳样式抄 `GitGraphView.tsx` 的容器写法（右侧叠加、半屏/全屏切换）
- Produces: `<FriendChatView />`

- [ ] **Step 1: 看一眼 `GitGraphView.tsx` 顶层容器的 className**（半屏叠加 + panelWide 全屏的既有写法,面板壳照抄保持一致——执行时以它为准,下面骨架里的容器类名是当前读到的近似）

- [ ] **Step 2: 写 `src/renderer/src/components/FriendChatView.tsx`**

```tsx
// FriendChatView — 好友 DM 右侧叠加面板(同 Protocol/GitGraph 槽位):
// 消息列表(旧→新,顶部可翻更早) + 输入框。自己的消息靠右,对方靠左。

import { useEffect, useRef, useState } from "react";
import { useChat } from "../store.js";
import { Button } from "@/components/ui/button.js";
import { X, Maximize2, Minimize2 } from "lucide-react";

export function FriendChatView() {
  const friend = useChat((s) => s.friendChat);
  const messages = useChat((s) => (friend ? (s.dmByFriend[friend.id] ?? []) : []));
  const onlineIds = useChat((s) => s.onlineIds);
  const friendError = useChat((s) => s.friendError);
  const sendDm = useChat((s) => s.sendDm);
  const loadOlderDms = useChat((s) => s.loadOlderDms);
  const closeFriendChat = useChat((s) => s.closeFriendChat);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);
  const account = useChat((s) => s.account);

  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [messages.length, friend?.id]);

  if (!friend) return null;
  const online = onlineIds.includes(friend.id);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendDm(text);
  };

  return (
    <aside className={`${panelWide ? "w-full" : "w-1/2"} shrink-0 border-l border-border bg-background flex flex-col min-w-0`}>
      <header className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <span className={`w-2 h-2 rounded-full ${online ? "bg-brand" : "bg-border"}`} />
        <span className="font-[650] text-sm flex-1 min-w-0 truncate">{friend.name || friend.email}</span>
        <Button variant="ghost" size="sm" onClick={togglePanelWide}
          title={panelWide ? "半屏" : "全屏"}>
          {panelWide ? <Minimize2 className="w-[14px] h-[14px]" /> : <Maximize2 className="w-[14px] h-[14px]" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={closeFriendChat} title="关闭">
          <X className="w-[14px] h-[14px]" />
        </Button>
      </header>
      <section className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 flex flex-col gap-[6px] scrollbar-thin">
        {messages.length >= 50 && (
          <button
            className="self-center text-xs text-muted-foreground hover:text-foreground py-1"
            onClick={() => void loadOlderDms()}
          >
            加载更早的消息
          </button>
        )}
        {messages.map((m) => {
          const mine = m.sender !== friend.id; // 面板只有两人,非对方即自己
          return (
            <div key={m.id}
              className={`max-w-[80%] px-3 py-[6px] rounded-lg text-[13px] whitespace-pre-wrap break-words ${
                mine ? "self-end bg-brand/15" : "self-start bg-foreground/[0.06]"}`}
              title={new Date(m.createdAt).toLocaleString()}
            >
              {m.body}
            </div>
          );
        })}
        {messages.length === 0 && (
          <p className="text-muted-foreground text-xs">还没有消息,和 {friend.name || friend.email} 说点什么。</p>
        )}
        <div ref={bottomRef} />
      </section>
      {friendError && <p className="px-4 text-xs text-err">{friendError}</p>}
      <footer className="px-4 py-3 border-t border-border flex gap-2">
        <input
          className="flex-1 min-w-0 bg-transparent border border-border rounded px-3 py-[6px] text-[13px]"
          placeholder={`发给 ${friend.name || friend.email}(${account.name})`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }}
        />
        <Button size="sm" onClick={submit}>发送</Button>
      </footer>
    </aside>
  );
}
```

（`isComposing` 判断：中文输入法选字回车不误发。）

- [ ] **Step 3: App.tsx panel 分发接线**

import 加 `import { FriendChatView } from "./components/FriendChatView.js";`

`App()` 里取 `const friendChat = useChat((s) => s.friendChat);`，panel 一行改为：

```tsx
  const panel = friendChat ? <FriendChatView /> : gitGraphOpen ? <GitGraphView /> : protocolOpen ? <ProtocolView /> : null;
```

侧栏会话高亮判断（`isActive={phase === "chat" && ... && !gitGraphOpen && ...}`）同步补 `&& !friendChat`——DM 面板开着时会话列表不该高亮为"正看会话"。（welcome phase 下 panel 槽位是否渲染：跟 GitGraphView 同一渲染路径，若 panel 只在 chat phase 渲染，DM 面板也只在 chat phase 可见——保持既有行为，不为好友单开路径。）

- [ ] **Step 4: 门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/FriendChatView.tsx src/renderer/src/App.tsx
git commit -m "feat(friends): DM 聊天面板——右侧叠加槽位,气泡列表+翻旧页+输入法安全回车"
```

---

### Task 9: ADR + 收口验收

**Files:**
- Create: `docs/adr/0071-friend-system-supabase.md`（落盘时是 0014，撞号后改号，见 issue #230）（编号执行时以 `ls docs/adr/` 最大号 +1 为准）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 写 ADR**

```markdown
# 0014. 好友系统走 Supabase 直连(表 + RLS + Realtime,无自建服务器)

日期:2026-08-18
状态:已采纳

## 背景

Mr Otto 已有 Supabase OAuth 账号体系(ADR 前置:account.ts,自托管实例)。
需要真人用户互加好友:关系链 + 在线状态 + 一对一 DM。

## 决策

1. **无自建服务器**:三张表(profiles/friendships/messages) + RLS 承担全部授权;
   presence/消息推送走 Supabase Realtime。备选"自建后端"因部署运维成本否决,
   "纯轮询"因在线状态/消息延迟差否决。
2. **窄接口注入**:FriendsManager 依赖 FriendsApi(照 account.ts 的 SupabaseLike
   模式),真 supabase 查询链隔离在 supabaseFriendsApi.ts;单测零网络。
3. **真 client 单实例双出口**:createSupabaseAuthClient 返回 {auth, raw},
   AccountManager 与好友网关共用同一登录态——两个 client 会各自持 session,拒绝。
4. **错误结构化回流**:好友 bridge 方法回 FriendsResult(ok:false 带人话),
   不走 invoke reject——网络/RLS 拒绝是常态分支,不是异常。
5. **DB 变更走 supabase/migrations/ 编号文件**,手动在 SQL editor 执行,
   不改旧文件。前提失效点:若将来接 supabase CLI 管线,本条重议。

## 后果

- 客户端逻辑全部可离线测;RLS 是唯一授权层,migration 里每条 policy 带意图注释,
  人工在 Supabase 后台验证。
- Realtime 依赖自托管实例开着 realtime 服务;掉线重连由 supabase-js 兜,
  重连后重拉快照。
```

- [ ] **Step 2: 全量门禁 + 手动验收**

Run: `npm test`
Expected: 全绿

手动验收清单（需要 migration 已执行 + 两个账号）：
1. 账号 A 搜账号 B 邮箱 → 发请求 → B 端侧栏出现「好友请求」→ 接受 → 双方好友列表互见
2. 双方各自登录时在线点亮起；一方退出登录，另一方在线点熄灭
3. A 开 B 的 DM 面板发消息 → B 未读角标 +1 → B 点开面板看到消息、角标清零
4. 拒绝请求/删好友后双方列表即时同步
5. 未登录状态:好友区显示「登录后可用」，DM 面板不可达

- [ ] **Step 3: Commit + push + PR**

```bash
git add docs/adr/
git commit -m "docs(adr): 0014 好友系统 Supabase 直连——四决策(无服务器/窄接口/单 client/结构化错误)"
git push -u origin claude/friend-system-d5440e
gh pr create --title "feat: 好友系统——关系链+在线状态+DM(Supabase 直连)" --body "Closes #<Task issue 号>

Spec: docs/superpowers/specs/2026-08-18-friend-system-design.md
Plan: docs/superpowers/plans/2026-08-18-friend-system.md

- supabase/migrations/0001_friends.sql:三表+RLS+Realtime publication
- FriendsManager(窄接口注入,零网络单测)+真网关+主进程接线
- 侧边栏好友区 + DM 右侧叠加面板
- ADR 0014

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

CI 绿后自行 merge（merge commit，协议 ADR-0007）。

---

## Self-Review 记录

- **Spec coverage**:关系链(Task 1/3/5/7)、在线状态(Task 1 presence 频道/4/5/6/7)、DM(Task 1 messages/3/5/6/8)、错误处理(FriendsResult 贯穿)、测试(3/4/5/6)、ADR(9)——全覆盖。
- **Placeholder scan**:无 TBD/TODO;Task 7 Step 1 内嵌代码里自带一处已标注的修正(hit.email 比较);Task 8 Step 1 明示容器类名以 GitGraphView 现文件为准。
- **Type consistency**:FriendsApi/FriendsResult/FriendsSnapshot/DirectMessage 各任务引用一致;bridge 方法名 friends* 前缀贯穿 shellBridge/preload/index.ts/store。
```
