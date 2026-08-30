# 工作区一期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作区（成员名单 + 连接器授权池 + 发布制共享会话）——escrow 授权的群组化 + session-package 机制的群组化。

**Architecture:** EscrowGrant 加 `{ workspaceId }` 变体，edge 三道闸的关系闸对该变体改查 Supabase `workspace_members` 在籍（fromUid 与 hostUid 都得在籍）；A 侧 proxyStore 加 `workspaceGrants` 一栏，escrowSync 上传编排零改动；B 侧 workspace host 走既有 cloud-only 借用路（routedBorrowMcp 无通道即打云端）；会话共享复用 session-packages Storage 桶 + `workspace_sessions` 行指向包。

**Tech Stack:** TypeScript strict / Electron 主进程 / Supabase（PostgREST + Storage + RLS）/ Cloudflare Worker + Durable Object / vitest。

**Spec:** `docs/superpowers/specs/2026-08-30-workspace-phase1-design.md`（Task 1 对它有一处修订）

## Global Constraints

- Gate = `npm test`（tsc --noEmit + vitest run），每个 task 收尾必须全绿。
- 主 checkout 只读：全部工作在 `npm run lane -- <任务名>` 开出的 worktree 里做；合并走 merge commit（不 squash 不 rebase）。
- 渲染进程只经 ShellBridge；工具/主进程核心不 import electron 之外还要过 `tests/architecture.test.ts`。
- `src/shared/remote/pxEscrow.ts` 与 `services/edge/src/px.ts` 是**两方共用一份**纪律：形状只改 pxEscrow.ts，px.ts 只 re-export。
- **部署顺序：edge 先上**（旧 edge 收到 workspaceId 变体会 400 bad_doc）。edge 部署 = `services/edge` 的 wrangler deploy，由维护者操作；本 plan 只保证代码就绪 + `checks/relay.mjs` 真 workerd 验通过。
- Supabase migration 按惯例在 Cloud 项目 SQL editor 手动执行一次（幂等写法）；**真库是 Cloud 项目 `kpeemypbhkynapkjzewr`，不是退役的 otto-db-1**。
- 所有 deny 话术用中文人话，口径与现有 px.ts 一致。
- 查询失败语义：**「拿不到」≠「被清空」**——B 侧保留旧缓存；关系闸失败关闭。

---

### Task 1: ADR + spec 修订

**Files:**
- Create: `docs/adr/0198-工作区连接器池与发布制会话.md`（编号 merge 时按 ADR-0074 规则再核）
- Modify: `docs/superpowers/specs/2026-08-30-workspace-phase1-design.md`（§1.2）

**Interfaces:** 无代码。后续任务引用本 ADR 编号。

- [ ] **Step 1: 写 ADR**

内容要点（各一段）：① 决策：工作区 = escrow 群组化（EscrowGrant 加 workspaceId 变体）+ session-package 群组化（workspace_sessions 行指包），不新造执行面、不新造分享机制；② 关系闸改查在籍且**不复制成员名单到 DO**（复制品陈旧 vs 踢人立即生效，选后者，代价是每次 call 多一跳 PostgREST，60s 缓存兜底）；③ 任何成员可贡献连接器（各写各的箱，edge 编排零改动）；④ 会话发布复用 session-packages 桶而非 jsonb 快照（推翻 spec §1.2 初稿——包机制已有隐私闸/上传/导入全链路，jsonb 要重造一遍且 2 MiB 顶不住附件）；⑤ 被否掉的路：workspace 专用 Escrow DO（一份凭据两处密封，撤销要清两处）、自动全授（ADR-0177 判断在群组场景更成立）。

- [ ] **Step 2: 修订 spec §1.2**

把 `workspace_sessions` 的 `doc jsonb` 字段换成 `pkg_id text`（指向 session-packages 桶里 `{publisher_uid}/{pkg_id}/` 的包），删去 2 MiB jsonb 上限句，补一句「复用 0014 的包机制，下载权限见 migration 0015 的 storage policy」。

- [ ] **Step 3: 跑 gate 确认没碰坏（`npm test`），commit**

```bash
git add docs/adr/0198-*.md docs/superpowers/specs/2026-08-30-workspace-phase1-design.md
git commit -m "docs: ADR-0198 工作区连接器池；spec 会话发布改用 session-packages 包"
```

---

### Task 2: Supabase migration 0015

**Files:**
- Create: `supabase/migrations/0015_workspaces.sql`

**Interfaces:**
- Produces: 表 `workspaces` / `workspace_members` / `workspace_connectors` / `workspace_sessions`，storage 桶 `session-packages` 的 workspace 下载策略。后续任务的 PostgREST 路径按这些表名。

- [ ] **Step 1: 写 migration（幂等，SQL editor 手动执行）**

```sql
-- 0015_workspaces.sql —— 工作区（ADR-0198，issue #811）。幂等，重跑不炸。
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner_uid uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uid uuid not null references auth.users(id),
  role text not null default 'member' check (role in ('owner','member')),
  added_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, uid)
);
-- 连接器目录（展示元数据；执行真相在 escrow 箱 + 关系闸，这张表撒谎也越不过闸）
create table if not exists public.workspace_connectors (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  host_uid uuid not null references auth.users(id),
  server_id text not null,
  label text not null default '',
  tools jsonb not null default '[]'::jsonb,   -- [] = 整服务放行（proxyProtocol 口径）
  updated_at timestamptz not null default now(),
  primary key (workspace_id, host_uid, server_id)
);
create table if not exists public.workspace_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  publisher_uid uuid not null references auth.users(id),
  pkg_id text not null,
  title text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_connectors enable row level security;
alter table public.workspace_sessions enable row level security;

-- 在籍判断给 policy 用。security definer：RLS 下 workspace_members 自查会递归
create or replace function public.is_ws_member(ws uuid, u uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from workspace_members where workspace_id = ws and uid = u) $$;

drop policy if exists ws_select_member on public.workspaces;
create policy ws_select_member on public.workspaces for select to authenticated
  using (public.is_ws_member(id, auth.uid()));
drop policy if exists ws_insert_self on public.workspaces;
create policy ws_insert_self on public.workspaces for insert to authenticated
  with check (owner_uid = auth.uid());
drop policy if exists ws_delete_owner on public.workspaces;
create policy ws_delete_owner on public.workspaces for delete to authenticated
  using (owner_uid = auth.uid());

drop policy if exists wsm_select_member on public.workspace_members;
create policy wsm_select_member on public.workspace_members for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
-- owner 拉人（只能拉进自己 own 的群）；建群第一行（owner 自己）也走这条
drop policy if exists wsm_insert_owner on public.workspace_members;
create policy wsm_insert_owner on public.workspace_members for insert to authenticated
  with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()));
-- owner 踢人，或成员删自己那行（退群）。owner 行由 ws_delete_owner 级联走
drop policy if exists wsm_delete on public.workspace_members;
create policy wsm_delete on public.workspace_members for delete to authenticated
  using (uid = auth.uid()
     or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()));

drop policy if exists wsc_select_member on public.workspace_connectors;
create policy wsc_select_member on public.workspace_connectors for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
drop policy if exists wsc_upsert_host on public.workspace_connectors;
create policy wsc_upsert_host on public.workspace_connectors for insert to authenticated
  with check (host_uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));
drop policy if exists wsc_update_host on public.workspace_connectors;
create policy wsc_update_host on public.workspace_connectors for update to authenticated
  using (host_uid = auth.uid());
drop policy if exists wsc_delete_host_or_owner on public.workspace_connectors;
create policy wsc_delete_host_or_owner on public.workspace_connectors for delete to authenticated
  using (host_uid = auth.uid()
     or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()));

drop policy if exists wss_select_member on public.workspace_sessions;
create policy wss_select_member on public.workspace_sessions for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
drop policy if exists wss_insert_publisher on public.workspace_sessions;
create policy wss_insert_publisher on public.workspace_sessions for insert to authenticated
  with check (publisher_uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));
drop policy if exists wss_update_publisher on public.workspace_sessions;
create policy wss_update_publisher on public.workspace_sessions for update to authenticated
  using (publisher_uid = auth.uid());
drop policy if exists wss_delete_publisher on public.workspace_sessions;
create policy wss_delete_publisher on public.workspace_sessions for delete to authenticated
  using (publisher_uid = auth.uid());

-- 包下载：0014 只对好友开；发布进工作区的包，同群成员也要能下——只对
-- workspace_sessions 里**指名**的那个包放行（不是发布者的全部包）
drop policy if exists session_packages_select_ws on storage.objects;
create policy session_packages_select_ws on storage.objects for select to authenticated
  using (
    bucket_id = 'session-packages'
    and exists (
      select 1 from public.workspace_sessions ws
      where ws.publisher_uid::text = (storage.foldername(name))[1]
        and ws.pkg_id = (storage.foldername(name))[2]
        and public.is_ws_member(ws.workspace_id, auth.uid())
    )
  );
```

- [ ] **Step 2: commit（migration 由维护者在 Cloud SQL editor 执行，PR 描述里提醒）**

```bash
git add supabase/migrations/0015_workspaces.sql
git commit -m "feat(ws): migration 0015——工作区四表 + RLS + 包下载的同群策略（ADR-0198）"
```

---

### Task 3: pxEscrow —— EscrowGrant 加 workspaceId 变体

**Files:**
- Modify: `src/shared/remote/pxEscrow.ts`
- Test: `tests/shared/remote/pxEscrow.test.ts`

**Interfaces:**
- Produces（后续任务全用这些名字）:

```ts
export interface AllowEntry { serverId: string; tools: string[] }
export type EscrowGrant =
  | { friendUid: string; allow: AllowEntry[] }
  | { workspaceId: string; allow: AllowEntry[] };
export type WorkspaceGrant = Extract<EscrowGrant, { workspaceId: string }>;
export function isFriendGrant(g: EscrowGrant): g is Extract<EscrowGrant, { friendUid: string }>;
// EscrowSources 加一个字段：
//   workspaceGrants: readonly WorkspaceGrant[];
// buildEscrowDoc：两组都空回 null；wanted 集合并两组的 serverId；doc.grants 两组拼接
```

- [ ] **Step 1: 写失败测试（追加进现有 describe）**

```ts
it("parseEscrowDoc 认 workspaceId 变体，两个键都有/都没有的拒", () => {
  const base = { v: 1, hostUid: "h", services: [], updatedTs: 1 };
  expect(parseEscrowDoc({ ...base, grants: [{ workspaceId: "w1", allow: [] }] })).not.toBeNull();
  expect(parseEscrowDoc({ ...base, grants: [{ allow: [] }] })).toBeNull();
  expect(parseEscrowDoc({ ...base, grants: [{ friendUid: "f", workspaceId: "w", allow: [] }] })).toBeNull();
});
it("buildEscrowDoc 把 workspaceGrants 并进箱（服务准入三条不变）", () => {
  const doc = buildEscrowDoc({ ...srcWithOneLiveHttpsServer, grants: [], workspaceGrants: [{ workspaceId: "w1", allow: [{ serverId: "srv", tools: [] }] }] });
  expect(doc?.services.map(s => s.serverId)).toEqual(["srv"]);
  expect(doc?.grants).toEqual([{ workspaceId: "w1", allow: [{ serverId: "srv", tools: [] }] }]);
});
it("buildEscrowDoc 两组授权都空才回 null", () => {
  expect(buildEscrowDoc({ ...srcWithOneLiveHttpsServer, grants: [], workspaceGrants: [] })).toBeNull();
});
```

（`srcWithOneLiveHttpsServer` 用该测试文件里已有的 EscrowSources 假货工厂；没有就照 buildEscrowDoc 现有测试的造法起一个。）

- [ ] **Step 2: 跑 `npx vitest run tests/shared/remote/pxEscrow.test.ts`，确认新增三条 FAIL（tsc 也会红——EscrowSources 还没有 workspaceGrants）**

- [ ] **Step 3: 实现**

parseEscrowDoc 的 grants 校验换成：

```ts
for (const g of raw.grants) {
  if (!isObj(g) || !Array.isArray(g.allow)) return null;
  const hasFriend = typeof g.friendUid === "string" && g.friendUid !== "";
  const hasWs = typeof g.workspaceId === "string" && g.workspaceId !== "";
  if (hasFriend === hasWs) return null; // 恰好一个
}
```

`EscrowSources` 加 `workspaceGrants: readonly WorkspaceGrant[];`。buildEscrowDoc：

```ts
if (src.grants.length === 0 && src.workspaceGrants.length === 0) return null;
const wanted = new Set([
  ...src.grants.flatMap((g) => g.allow.map((a) => a.serverId)),
  ...src.workspaceGrants.flatMap((g) => g.allow.map((a) => a.serverId)),
]);
// …services 准入不变…
grants: [
  ...src.grants.map((g) => ({ friendUid: g.friendUid, allow: g.allow.map((a) => ({ serverId: a.serverId, tools: [...a.tools] })) })),
  ...src.workspaceGrants.map((g) => ({ workspaceId: g.workspaceId, allow: g.allow.map((a) => ({ serverId: a.serverId, tools: [...a.tools] })) })),
],
```

**此步会把 px.ts / worker.ts / index.ts 编译弄红**（`grant.friendUid` 不再无条件存在、EscrowSources 少字段）——本 task 内先把 index.ts 的 buildEscrowDoc 调用点补上 `workspaceGrants: readProxyStore(proxyStorePath).workspaceGrants ?? []`（Task 6 之前先用 `?? []` 顶住，Task 6 落字段后去掉 `?? []`）；px.ts 的红留给 Task 4 立即接手，**Task 3+4 必须进同一个 PR**。

- [ ] **Step 4: 跑该测试文件确认 PASS；Task 4 完成后再跑全量 gate**

- [ ] **Step 5: commit**

```bash
git add src/shared/remote/pxEscrow.ts tests/shared/remote/pxEscrow.test.ts src/main/index.ts
git commit -m "feat(ws): EscrowGrant 加 workspaceId 变体（ADR-0198 切片 1）"
```

---

### Task 4: px.ts —— 关系闸群组化（与 Task 3 同 PR）

**Files:**
- Modify: `services/edge/src/px.ts`
- Test: `tests/edge/px.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `EscrowGrant` union / `isFriendGrant`。
- Produces:

```ts
export interface PxRelations {
  friendAccepted: boolean;
  /** fromUid 与 hostUid **都在籍**的 workspaceId 集合 */
  workspaceOk: ReadonlySet<string>;
}
export function pxGate(doc: EscrowDoc | null, req: {...同现状}, rel: PxRelations): PxPass | PxDeny;
export function grantedView(doc: EscrowDoc | null, fromUid: string, rel: PxRelations):
  { servers: { serverId: string; toolDefs: EscrowService["toolDefs"]; workspaceId?: string }[] };
export function membershipQuery(workspaceIds: readonly string[], a: string, b: string): string;
export function parseMembershipRows(raw: unknown, a: string, b: string): Set<string>;
export function workspaceIdsOf(doc: EscrowDoc | null): string[];
```

- [ ] **Step 1: 写失败测试**

```ts
const rel = (f: boolean, ...ws: string[]): PxRelations => ({ friendAccepted: f, workspaceOk: new Set(ws) });
const doc: EscrowDoc = { v: 1, hostUid: "host", updatedTs: 1,
  services: [{ serverId: "srv", url: "https://x", toolDefs: [{ name: "t1", description: "", inputSchema: {} }] }],
  grants: [{ workspaceId: "w1", allow: [{ serverId: "srv", tools: [] }] }] };

it("workspace grant：在籍放行", () => {
  expect(pxGate(doc, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false, "w1")).ok).toBe(true);
});
it("workspace grant：不在籍拒 not_member（非好友身份不影响）", () => {
  const r = pxGate(doc, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false));
  expect(r).toMatchObject({ ok: false, code: "not_member" });
});
it("friend 与 workspace 并存：任一放行即过", () => {
  const both = { ...doc, grants: [...doc.grants, { friendUid: "b", allow: [] as AllowEntry[] }] };
  expect(pxGate(both, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(true)).ok).toBe(false); // friend 空 allow，ws 不在籍
  expect(pxGate(both, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false, "w1")).ok).toBe(true);
});
it("纯 friend 路老语义不变：非好友拒 not_friends", () => {
  const fdoc = { ...doc, grants: [{ friendUid: "b", allow: [{ serverId: "srv", tools: [] }] }] };
  expect(pxGate(fdoc, { fromUid: "b", serverId: "srv", tool: "t1" }, rel(false))).toMatchObject({ ok: false, code: "not_friends" });
});
it("grantedView：workspace 来的条目带 workspaceId，friend 来的不带；同服务两路都给时 friend 赢", () => {
  const v = grantedView(doc, "b", rel(false, "w1"));
  expect(v.servers).toEqual([{ serverId: "srv", toolDefs: doc.services[0].toolDefs, workspaceId: "w1" }]);
});
it("membershipQuery / parseMembershipRows：双方都在的 workspace 才算", () => {
  const rows = [{ workspace_id: "w1", uid: "a" }, { workspace_id: "w1", uid: "b" }, { workspace_id: "w2", uid: "a" }];
  expect(parseMembershipRows(rows, "a", "b")).toEqual(new Set(["w1"]));
  expect(parseMembershipRows("garbage", "a", "b")).toEqual(new Set()); // 失败关闭
  expect(membershipQuery(["w1"], "a", "b")).toContain("workspace_members");
});
```

现有 pxGate/grantedView 测试全部改传 `rel(true)` / `rel(false)` 替代原布尔（机械替换，语义不动）。

- [ ] **Step 2: 跑 `npx vitest run tests/edge/px.test.ts` 确认 FAIL**

- [ ] **Step 3: 实现**

```ts
export function workspaceIdsOf(doc: EscrowDoc | null): string[] {
  if (!doc) return [];
  return [...new Set(doc.grants.flatMap((g) => (isFriendGrant(g) ? [] : [g.workspaceId])))];
}

export function pxGate(doc, req, rel: PxRelations): PxPass | PxDeny {
  if (!doc) return { ok: false, status: 404, code: "no_escrow", message: "对方没有托管任何服务（或已撤销）" };
  const friendGrants = doc.grants.filter((g) => isFriendGrant(g) && g.friendUid === req.fromUid);
  const wsGrants = doc.grants.filter((g) => !isFriendGrant(g));
  const applicable: EscrowGrant[] = [
    ...(rel.friendAccepted ? friendGrants : []),
    ...wsGrants.filter((g) => !isFriendGrant(g) && rel.workspaceOk.has(g.workspaceId)),
  ];
  if (applicable.length === 0) {
    if (friendGrants.length > 0 && !rel.friendAccepted) {
      return { ok: false, status: 403, code: "not_friends", message: "你们已不是好友，代理授权随之失效" };
    }
    if (wsGrants.length > 0) {
      return { ok: false, status: 403, code: "not_member", message: "你或对方已不在该工作区，授权随之失效" };
    }
    return { ok: false, status: 403, code: "no_grant", message: "对方没有为你开通代理授权" };
  }
  let sawServer = false;
  for (const grant of applicable) {
    const entry = grant.allow.find((a) => a.serverId === req.serverId);
    if (!entry) continue;
    sawServer = true;
    if (entry.tools.length > 0 && !entry.tools.includes(req.tool)) continue;
    const service = doc.services.find((s) => s.serverId === req.serverId);
    if (!service) {
      return { ok: false, status: 404, code: "service_missing", message: `服务「${req.serverId}」的托管资料不在（对方可能已移除）` };
    }
    return { ok: true, service, grant };
  }
  return sawServer
    ? { ok: false, status: 403, code: "tool_not_granted", message: `代理授权里「${req.serverId}」不含工具「${req.tool}」` }
    : { ok: false, status: 403, code: "server_not_granted", message: `代理授权里没有服务「${req.serverId}」` };
}
```

grantedView 同构改写：applicable 同上；按 serverId 聚合，`toolDefs` 取并集（按 name 去重；任一来源 tools 为空 = 全量 toolDefs），来源全是 workspace 时带第一个 `workspaceId`，有 friend 来源则不带。membershipQuery：

```ts
export function membershipQuery(workspaceIds: readonly string[], a: string, b: string): string {
  const enc = encodeURIComponent;
  const ids = workspaceIds.map(enc).join(",");
  return `workspace_members?select=workspace_id,uid&workspace_id=in.(${ids})&uid=in.(${enc(a)},${enc(b)})`;
}
export function parseMembershipRows(raw: unknown, a: string, b: string): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const byWs = new Map<string, Set<string>>();
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const { workspace_id, uid } = r as { workspace_id?: unknown; uid?: unknown };
    if (typeof workspace_id !== "string" || typeof uid !== "string") continue;
    (byWs.get(workspace_id) ?? byWs.set(workspace_id, new Set()).get(workspace_id)!).add(uid);
  }
  return new Set([...byWs].filter(([, uids]) => uids.has(a) && uids.has(b)).map(([id]) => id));
}
```

- [ ] **Step 4: 跑全量 gate（`npm test`）确认绿（Task 3 一起）**

- [ ] **Step 5: commit**

```bash
git add services/edge/src/px.ts tests/edge/px.test.ts
git commit -m "feat(ws): 三道闸关系闸群组化——workspace grant 查在籍（ADR-0198 切片 1）"
```

---

### Task 5: edge 运行时 —— worker.ts / edge.ts 接在籍查询 + workerd 验

**Files:**
- Modify: `services/edge/src/worker.ts`（Escrow DO）
- Modify: `services/edge/src/edge.ts`（/px/v1/grants 不再在门口拒非好友）
- Test: `tests/edge/pxRoutes.test.ts`（edge.ts 纯层）+ `services/edge/checks/relay.mjs`（真 workerd）

**Interfaces:**
- Consumes: Task 4 的 `PxRelations` / `membershipQuery` / `parseMembershipRows` / `workspaceIdsOf`。
- Produces: Escrow DO 内部操作 `grants`/`call` 的 body 均含 `friendAccepted: boolean`（grants 原先没有）。

- [ ] **Step 1: edge.ts——/px/v1/grants 改为转发而不是拒**

```ts
if (pathname === "/px/v1/grants" && req.method === "GET") {
  // 不再在门口拒非好友：同工作区成员不必是好友（ADR-0198）。
  // 关系闸整个下沉进 DO——它读得到 doc，才知道要查哪些 workspace 的在籍
  const friend = await deps.isFriend(who.userId, host);
  return forward(host, "grants", { fromUid: who.userId, friendAccepted: friend });
}
```

`tests/edge/pxRoutes.test.ts` 里「非好友打 grants 被 403」那条改成「转发时带 friendAccepted: false」（照该文件现有的假 escrow stub 断言 forward 载荷）。

- [ ] **Step 2: worker.ts——Escrow DO 补在籍解析**

Escrow 类里加（照 friendChecker 的缓存写法，60s、DO 睡醒即失）：

```ts
private msCache = new Map<string, { v: Set<string>; exp: number }>();
private async workspaceOk(doc: EscrowDoc | null, fromUid: string): Promise<Set<string>> {
  const ids = workspaceIdsOf(doc);
  if (ids.length === 0 || !doc) return new Set();
  const key = `${fromUid}|${ids.join(",")}`;
  const hit = this.msCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  try {
    const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/${membershipQuery(ids, fromUid, doc.hostUid)}`, {
      headers: { apikey: this.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${this.env.SUPABASE_SERVICE_KEY}` },
    });
    const v = res.ok ? parseMembershipRows(await res.json(), fromUid, doc.hostUid) : new Set<string>();
    this.msCache.set(key, { v, exp: Date.now() + 60_000 });
    return v;
  } catch { return new Set(); } // 关系闸失败关闭
}
```

`grants` 操作：`const rel = { friendAccepted: b.friendAccepted === true, workspaceOk: await this.workspaceOk(doc, fromUid) };` → `grantedView(doc, fromUid, rel)`（先 `const doc = await this.doc()`）。`call` 操作同样构造 rel 传给 pxGate（替换原布尔）。import 列表补 `membershipQuery, parseMembershipRows, workspaceIdsOf`。

- [ ] **Step 3: checks/relay.mjs 补一条**：PUT 一份带 `{ workspaceId: "w-check", allow: [{ serverId: "s", tools: [] }] }` grant 的箱，断言 200 且 `grants: 1`（真 workerd 验「新 edge 收 workspaceId 变体」；在籍查询打不到真 Supabase → workspaceOk 空 → grants 端点回空清单，同样断言这一点：**查询失败关闭而不是 500**）。

- [ ] **Step 4: 跑 `npm test` + `node services/edge/checks/relay.mjs` 全绿**

- [ ] **Step 5: commit；PR 描述标注「**edge 先部署**再发客户端」**

```bash
git add services/edge/src/worker.ts services/edge/src/edge.ts tests/edge/pxRoutes.test.ts services/edge/checks/relay.mjs
git commit -m "feat(ws): Escrow DO 查在籍——workspace 关系闸落运行时（ADR-0198 切片 1）"
```

---

### Task 6: proxyStore —— workspaceGrants 一栏 + escrowSync 供料

**Files:**
- Modify: `src/main/proxyStore.ts`、`src/main/index.ts`（buildDoc/everHosted 两处）
- Test: `tests/main/proxyStore.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `WorkspaceGrant`。
- Produces:

```ts
// ProxyStoreData 加：workspaceGrants: WorkspaceGrant[]（parse 缺席按 []，老台账不算坏）
export function setWorkspaceGrant(data, grant: WorkspaceGrant): ProxyStoreData;      // 按 workspaceId 整份替换
export function removeWorkspaceGrant(data, workspaceId: string): ProxyStoreData;
export function workspaceGrantFor(data, workspaceId: string): WorkspaceGrant | null;
```

- [ ] **Step 1: 失败测试**——`parseProxyStore` 老 JSON（无 workspaceGrants）回 `[]`；set 整份替换同 workspaceId；remove 只删指定的；序列化往返保真。照该文件现有 setGrant/revokeGrant 测试的写法各一条。

- [ ] **Step 2: 跑 `npx vitest run tests/main/proxyStore.test.ts` 确认 FAIL**

- [ ] **Step 3: 实现**（emptyProxyStore/parseProxyStore 补字段；三个函数照 setGrant/revokeGrant/grantFor 抄形）。index.ts：buildDoc 里 `workspaceGrants: readProxyStore(proxyStorePath).workspaceGrants`（去掉 Task 3 的 `?? []`）；everHosted 加 `|| s.workspaceGrants.length > 0`。

- [ ] **Step 4: `npm test` 全绿；commit**

```bash
git add src/main/proxyStore.ts src/main/index.ts tests/main/proxyStore.test.ts
git commit -m "feat(ws): 台账加 workspaceGrants 栏，escrowSync 供料含工作区授权（ADR-0198 切片 2）"
```

---

### Task 7: 共享类型 + supabaseWorkspacesApi

**Files:**
- Create: `src/shared/workspaces.ts`
- Create: `src/main/supabaseWorkspacesApi.ts`
- Test: `tests/shared/workspaces.test.ts`

**Interfaces:**
- Produces（IPC 与 UI 全用这些形状）:

```ts
// src/shared/workspaces.ts —— 纯类型 + 纯函数
export interface WorkspaceMemberRow { uid: string; role: "owner" | "member"; label: string }
export interface WorkspaceConnectorRow { workspaceId: string; hostUid: string; serverId: string; label: string; tools: string[] }
export interface WorkspaceSessionRow { id: string; workspaceId: string; publisherUid: string; pkgId: string; title: string; updatedTs: number }
export interface WorkspaceSnapshot {
  id: string; name: string; ownerUid: string;
  members: WorkspaceMemberRow[];
  connectors: WorkspaceConnectorRow[];
  sessions: WorkspaceSessionRow[];
}
/** 行数据 → snapshot（label 由 profiles 表查来，缺席回 uid 前 8 位） */
export function assembleSnapshot(
  ws: { id: string; name: string; owner_uid: string },
  members: readonly { uid: string; role: string }[],
  connectors: readonly { workspace_id: string; host_uid: string; server_id: string; label: string; tools: unknown }[],
  sessions: readonly { id: string; workspace_id: string; publisher_uid: string; pkg_id: string; title: string; updated_at: string }[],
  labelOf: (uid: string) => string | null
): WorkspaceSnapshot;
```

`src/main/supabaseWorkspacesApi.ts`：薄查询层，照 supabaseFriendsApi 的 unwrap 惯例，每函数一条链：`createWorkspace(client, name, selfUid)`（insert workspaces → insert 自己的 owner 行）、`listWorkspaces(client)`、`fetchWorkspace(client, id)`（四表 select + profiles label 批查）、`addMember/removeMember/leave/deleteWorkspace`、`upsertConnectorRow/deleteConnectorRow`、`insertSessionRow/deleteSessionRow`。查询链薄到无逻辑不单测（该文件头惯例）；`assembleSnapshot` 是纯函数，单测钉住：tools 形状不对回 `[]`、label 缺席回 uid 截断、时间戳 ISO→ms。

- [ ] **Step 1: 写 `assembleSnapshot` 失败测试（上述三条断言）**
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现两个文件**
- [ ] **Step 4: `npm test` 绿；commit**

```bash
git add src/shared/workspaces.ts src/main/supabaseWorkspacesApi.ts tests/shared/workspaces.test.ts
git commit -m "feat(ws): 工作区快照形状 + Supabase 薄查询层（ADR-0198 切片 2）"
```

---

### Task 8: workspaceManager —— 主进程编排

**Files:**
- Create: `src/main/workspaceManager.ts`
- Test: `tests/main/workspaceManager.test.ts`

**Interfaces:**
- Consumes: Task 6 的 store 函数、Task 7 的 api、`packSession`/`uploadPackageFiles`/`downloadPackageFiles`/`importSharedSession`（现有）、`escrowResync`（注入为 `resyncEscrow: () => void`）。
- Produces（IPC handler 直接调）:

```ts
export interface WorkspaceManagerDeps {
  api: typeof import("./supabaseWorkspacesApi.js");   // 或逐函数注入，测试给假货
  client: () => SupabaseClient | null;
  selfUid: () => string | null;
  loadStore: () => ProxyStoreData;
  saveStore: (d: ProxyStoreData) => void;
  resyncEscrow: () => void;
  /** 本机已接通 server 的展示名（连接器目录行的 label 用） */
  serverLabel: (serverId: string) => string;
}
export interface WorkspaceManager {
  list(): Promise<FriendsResult<WorkspaceSnapshot[]>>;
  create(name: string): Promise<FriendsResult<{ id: string }>>;
  remove(id: string): Promise<FriendsResult<null>>;                       // owner 删群；本地清 removeWorkspaceGrant + resync
  addMember(id: string, uid: string): Promise<FriendsResult<null>>;
  kickMember(id: string, uid: string): Promise<FriendsResult<null>>;
  leave(id: string): Promise<FriendsResult<null>>;                        // 退群；本地清自己的 grant + resync
  contributeConnector(id: string, serverId: string, tools: string[]): Promise<FriendsResult<null>>;
  withdrawConnector(id: string, serverId: string): Promise<FriendsResult<null>>;
  hostUids(): readonly string[];   // 我在籍工作区里**别人**贡献的 host（proxyManager 借用源）；内存缓存，list() 后更新
}
```

关键编排（测试各钉一条，api/client 全假货）：

- `contributeConnector`：① `setWorkspaceGrant`（在现有 workspaceGrantFor 基础上合并该 serverId 条目）② `saveStore` ③ `resyncEscrow()` ④ `upsertConnectorRow`（label 取 `serverLabel(serverId)`）。**②③在④之前**——箱是真相，目录只是展示；目录写失败回 err 但授权已生效，snapshot 下次自愈。
- `withdrawConnector`：从 grant 的 allow 里删该 serverId（删空则 `removeWorkspaceGrant`）→ save → resync → `deleteConnectorRow`。
- `remove`/`leave`：先 Supabase 动作，成功后 `removeWorkspaceGrant(id)` + resync（本地授权跟着死；边缘闸靠在籍已立即拒，这是清尾）。
- `hostUids`：list() 拿到的 snapshots 里 `connectors[].hostUid` 去重、剔除 `selfUid()`。
- 全部动作在 `client()` 为 null 时回 `{ ok: false, message: "还没登录" }`。

- [ ] **Step 1: 写失败测试（上述五条编排断言 + 未登录早退）**
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现**
- [ ] **Step 4: `npm test` 绿；commit**

```bash
git add src/main/workspaceManager.ts tests/main/workspaceManager.test.ts
git commit -m "feat(ws): workspaceManager 编排——贡献/撤回先动箱再动目录（ADR-0198 切片 2）"
```

---

### Task 9: 会话发布 / 导入

**Files:**
- Create: `src/main/workspaceSessionShare.ts`
- Test: `tests/main/workspaceSessionShare.test.ts`

**Interfaces:**
- Consumes: `packSession`（隐私闸在内）、`uploadPackageFiles(client, prefix, files)`、`downloadPackageFiles`、`importSharedSession` 的 deps 形状（照 `sessionShare.ts`/`sessionShareReceive.ts` 现状抄依赖注入清单——deps 形状以那两个文件为准）、Task 7 的 `insertSessionRow/deleteSessionRow`。
- Produces:

```ts
export async function publishSessionToWorkspace(
  deps: ShareSendDeps,               // sessionShare.ts 既有形状复用
  workspaceId: string, sessionId: string, title: string
): Promise<FriendsResult<{ rowId: string; pkgId: string }>>;
export async function unpublishSession(client, rowId: string, pkgPrefix: string): Promise<FriendsResult<null>>; // 删行 + deletePackage
export async function importWorkspaceSession(
  deps: ShareReceiveDeps, publisherUid: string, pkgId: string
): Promise<ShareReceiveResult>;      // downloadPackageFiles + importSharedSession 的既有路径，只是包路径来自行而不是 DM 信封
```

`publishSessionToWorkspace` = `shareSessionToFriend` 的姊妹函数：同一套 pack + upload（路径 `{selfUid}/{pkgId}/`），**不发 DM 信封**，改 `insertSessionRow(workspaceId, pkgId, title)`。连带借用（spec §4.2）不在这层——UI 在发布确认框里对勾选的服务逐个调 Task 8 的 `contributeConnector`（复用，不再造第二条授权路）。

- [ ] **Step 1: 失败测试**——假 client/假 storage：publish 上传了 manifest+events 且插了行；unpublish 删行删包；import 走到 importSharedSession（断言假 deps 收到的 prefix = `{publisherUid}/{pkgId}`）。
- [ ] **Step 2: FAIL 确认**
- [ ] **Step 3: 实现（对照 sessionShare.ts 的 shareSessionToFriend 逐段搬，DM 段换 insertSessionRow）**
- [ ] **Step 4: `npm test` 绿；commit**

```bash
git add src/main/workspaceSessionShare.ts tests/main/workspaceSessionShare.test.ts
git commit -m "feat(ws): 发布制会话——包复用 session-packages，行落 workspace_sessions（ADR-0198 切片 3）"
```

---

### Task 10: B 侧借用 —— proxyManager 收工作区 host

**Files:**
- Modify: `src/main/proxyManager.ts`
- Test: `tests/main/proxyManager.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `hostUids()`（注入为 deps 的可选函数）。
- Produces: `ProxyManagerDeps` 加 `workspaceHosts?: () => readonly string[];`

- [ ] **Step 1: 失败测试**

```ts
it("activeProxies 并上工作区 host（cloud-only，无通道），与配对借用按 hostUid 去重", () => {
  // 台账里有配对借用 hostA；workspaceHosts 回 [hostA, hostB]
  // 断言 activeProxies() 恰好两条：hostA（配对那条），hostB（label 走 friendLabel，mcp 是 routedBorrowMcp）
});
```

- [ ] **Step 2: FAIL 确认**
- [ ] **Step 3: 实现**——`activeProxies()`：

```ts
const paired = usableBorrows(deps.loadStore());
const pairedUids = new Set(paired.map((b) => b.hostUid));
const wsOnly = (deps.workspaceHosts?.() ?? []).filter((u) => !pairedUids.has(u));
return [
  ...paired.map((b) => ({ friendUid: b.hostUid, label: deps.friendLabel(b.hostUid), mcp: routedBorrowMcp(b.hostUid) })),
  ...wsOnly.map((u) => ({ friendUid: u, label: deps.friendLabel(u), mcp: routedBorrowMcp(u) })),
];
```

`routedBorrowMcp` 对无通道 host 本来就走 cloudView/云 call（issue #798 的路），零改动。index.ts 装配点把 `workspaceHosts: () => workspaceManager.hostUids()` 接进 createProxyManager。

- [ ] **Step 4: `npm test` 绿；commit**

```bash
git add src/main/proxyManager.ts src/main/index.ts tests/main/proxyManager.test.ts
git commit -m "feat(ws): 工作区 host 进借用面——cloud-only 路复用 routedBorrowMcp（ADR-0198 切片 3）"
```

---

### Task 11: IPC —— ShellBridge + preload + handlers

**Files:**
- Modify: `src/shared/shellBridge.ts`（接口 + channel 表）、`src/preload/index.ts`、`src/main/index.ts`

**Interfaces:**
- Consumes: Task 8/9 的 manager 函数。
- Produces（渲染层唯一入口）:

```ts
workspaceList(): Promise<FriendsResult<WorkspaceSnapshot[]>>;
workspaceCreate(name: string): Promise<FriendsResult<{ id: string }>>;
workspaceDelete(id: string): Promise<FriendsResult<null>>;
workspaceAddMember(id: string, uid: string): Promise<FriendsResult<null>>;
workspaceRemoveMember(id: string, uid: string): Promise<FriendsResult<null>>;
workspaceLeave(id: string): Promise<FriendsResult<null>>;
workspaceContributeConnector(id: string, serverId: string, tools: string[]): Promise<FriendsResult<null>>;
workspaceWithdrawConnector(id: string, serverId: string): Promise<FriendsResult<null>>;
workspacePublishSession(id: string, sessionId: string, title: string): Promise<FriendsResult<{ rowId: string; pkgId: string }>>;
workspaceUnpublishSession(id: string, rowId: string): Promise<FriendsResult<null>>;
workspaceImportSession(publisherUid: string, pkgId: string): Promise<FriendsResult<{ sessionId: string }>>;
```

channel 名一律 `otter:workspace*`，照 friends 区块抄登记形（接口注释、channel 表、preload invoke、index.ts `ipcMain.handle` 三处 + 类型对齐）。handler 里 manager 为 null（未登录装配）时回 `{ ok: false, message: "还没登录" }`。

- [ ] **Step 1: 接口 + channel 表 + preload + handlers 一次写全（这层无逻辑，无单测——与 friends IPC 同惯例；architecture 测试会盯越界 import）**
- [ ] **Step 2: `npm test` 绿（tsc 是这层的主要闸）；commit**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts
git commit -m "feat(ws): 工作区 IPC 面——ShellBridge 十一个方法（ADR-0198 切片 3）"
```

---

### Task 12: 渲染层 UI

**Files:**
- Create: `src/renderer/src/components/WorkspacesPanel.tsx`（侧栏区块：列表 + 建群）
- Create: `src/renderer/src/components/WorkspacePage.tsx`（三 tab：会话 / 连接器 / 成员）
- Create: `src/renderer/src/lib/workspaceView.ts`（纯逻辑：snapshot → 各 tab 的行模型；单测）
- Modify: 侧栏装配组件（找现有 Friends 区块挂载点，同层并列挂 WorkspacesPanel）
- Test: `tests/renderer/workspaceView.test.ts`

**Interfaces:**
- Consumes: Task 11 的全部 IPC + `WorkspaceSnapshot`。
- Produces: `workspaceView.ts`：

```ts
export interface ConnectorRowView { serverId: string; hostUid: string; hostLabel: string; mine: boolean; toolsSummary: string; cloudReady: boolean }
export function connectorRows(ws: WorkspaceSnapshot, selfUid: string, hostedServerIds: readonly string[] | null): ConnectorRowView[];
export function memberRows(ws: WorkspaceSnapshot, selfUid: string): { uid: string; label: string; role: string; canKick: boolean }[];
export function sessionRows(ws: WorkspaceSnapshot): { id: string; title: string; publisherLabel: string; updatedTs: number }[];
```

`toolsSummary`：`[]` → 「全部工具」，否则 `「N 个工具」`。`cloudReady`：自己贡献的行 = `hostedServerIds` 含该 serverId（「云端可用」措辞，ADR-0197 口径：断线但箱在说可用）；别人的行恒 true（能看见目录行即闸后可用，B 侧无从探箱）。`canKick`：自己是 owner 且行不是自己。

UI 要点（Tailwind + shadcn，照 McpConnectorPage 的换页惯例不用弹窗）：
- 贡献连接器：按钮开选择列表（本机已接通 http 服务，复用 `proxyShare.ts` 的勾选表换算逻辑），确认文案写明「工作区全体成员（含未来加入者）将以你的身份使用」。
- 发布会话：会话「更多」菜单加「发布到工作区…」，选工作区 + 标题；发布成功后若会话用过 MCP 服务，弹 ShareGrantDialog 同款确认（`serversUsedInSession` 现有函数），勾选项逐个调 `workspaceContributeConnector`。
- 成员 tab：拉人候选 = 好友列表（`friendsList` IPC 现有）；踢人二次确认。
- 会话 tab 行点开 → `workspaceImportSession` → 跳转导入出的本地会话（sessionShareReceive 的既有落地行为）。

- [ ] **Step 1: `workspaceView.ts` 失败测试（cloudReady 三态 / canKick / toolsSummary 各一条）**
- [ ] **Step 2: FAIL 确认**
- [ ] **Step 3: 实现 workspaceView.ts → PASS**
- [ ] **Step 4: 实现两个组件 + 侧栏挂载（无组件单测——渲染层惯例 e2e 兜底）**
- [ ] **Step 5: `npm test` 绿；commit**

```bash
git add src/renderer/src/components/WorkspacesPanel.tsx src/renderer/src/components/WorkspacePage.tsx src/renderer/src/lib/workspaceView.ts tests/renderer/workspaceView.test.ts <侧栏装配文件>
git commit -m "feat(ws): 工作区 UI——侧栏列表 + 三 tab 页（ADR-0198 切片 3）"
```

---

### Task 13: e2e 冒烟（可选，不进 gate）

**Files:**
- Create: `tests/e2e/workspace.spec.ts`

单实例可验的链路（双实例联调走 `docs/dev-two-accounts.md` 手册，不写进自动化）：建群 → 改名出现在侧栏 → 贡献连接器确认框文案含「以你的身份」→ 撤回后连接器 tab 行消失。照 `harness.ts` 的 `launchOtto({ authRecord })` 起法。**跑不跑随你（ADR-0138），不是本 PR 的义务。**

- [ ] **Step 1: 写 spec + 本机 `npm run e2e` 跑通或记录环境性失败**
- [ ] **Step 2: commit**

---

## 依赖与 PR 切分

```
Task 1(docs) ──独立 PR
Task 2(SQL)  ──独立 PR（维护者跑 migration）
Task 3+4+5   ──同一 PR（形状+纯闸+运行时，中间态编译不绿拆不开）；合并后维护者部署 edge
Task 6       ──PR（依赖 3）
Task 7+8+9   ──可同 PR（主进程数据层）
Task 10+11   ──PR（依赖 6/7/8/9）
Task 12      ──PR（依赖 11）
Task 13      ──随 12 或独立
```

执行顺序 = 编号顺序。每个 PR 合并前 re-fetch 核 ADR 编号（项目 ADR-0074）。

## Self-review 已做

- spec 覆盖：§1→Task 2/7，§2→Task 3/4/5/6/8，§3→Task 5(闸)/8(清尾)，§4→Task 9 + Task 12 发布确认框，§5→Task 12，§6→各 task 测试步 + Task 13，§8 部署顺序→Global Constraints + Task 5 Step 5。
- §1.2 与实现的出入（jsonb→包）由 Task 1 修订 spec 并记 ADR。
- 类型一致性：`WorkspaceGrant`（T3）供 T6/T8；`PxRelations`（T4）供 T5；`hostUids`（T8）供 T10；`WorkspaceSnapshot`（T7）供 T11/T12。
