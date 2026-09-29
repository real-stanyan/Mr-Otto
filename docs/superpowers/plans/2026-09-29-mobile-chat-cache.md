# 手机端智能体聊天本地缓存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机点进一条智能体聊天时先画本机缓存的事件，连上后以服务器为准对账。

**Architecture:** 纯逻辑（截断 / 序列化 / 解析 / 对账 / 索引淘汰）放 `src/shared/chatCache.ts` 进 vitest；手机端 `mobile/src/cloud/chatCache.ts` 只做 kv-store 读写与退出登录清理；`mobile/src/cloud/chatStore.ts` 在打开、收事件、状态翻转、离开四处接线。

**Tech Stack:** TypeScript strict、vitest、expo-sqlite/kv-store（AsyncStorage 兼容 API）。

**Spec:** `docs/superpowers/specs/2026-09-29-mobile-chat-cache-design.md`

## Global Constraints

- 常量逐字：`CHAT_CACHE_VERSION = 1`、`CHAT_CACHE_MAX_EVENTS = 200`、`CHAT_CACHE_MAX_CHARS = 300_000`、`CHAT_CACHE_MAX_CHATS = 30`；写盘攒 `1000` ms。
- kv-store 键逐字：`otto.chatCache.<uid>.<sessionId>`、索引 `otto.chatCache.<uid>.index`。
- 缓存读写 / 删除失败一律吞掉，不抛、不改 UI。
- 测试放 `tests/`（镜像 `src/`），不与源码同目录。
- 注释用中文，说「为什么」，匹配周围代码的密度。
- 门禁：`npm test`（含根 tsc、mobile tsc、vitest）。
- `exactOptionalPropertyTypes` 开着：可选字段不许显式赋 `undefined`。
- 每个 commit message 末尾加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（`-m` 多给一段）。

---

### Task 1: shared 纯逻辑 `chatCache.ts`

**Files:**
- Create: `src/shared/chatCache.ts`
- Test: `tests/shared/chatCache.test.ts`

**Interfaces:**
- Produces（Task 2 用）：
  - `CHAT_CACHE_MAX_CHATS: number`
  - `serializeChatCache(events: readonly SessionEvent[]): string | null`
  - `parseChatCache(raw: string | null, sessionId: string): SessionEvent[] | null`
  - `reconcileCachedEvents(events: readonly SessionEvent[], serverMin: number | null): SessionEvent[]`
  - `type ChatCacheIndex = { sessionId: string; ts: number }[]`
  - `parseChatCacheIndex(raw: string | null): ChatCacheIndex`
  - `serializeChatCacheIndex(index: ChatCacheIndex): string`
  - `touchChatCacheIndex(index: ChatCacheIndex, sessionId: string, ts: number, max: number): { index: ChatCacheIndex; evicted: string[] }`
  - `removeFromChatCacheIndex(index: ChatCacheIndex, sessionId: string): ChatCacheIndex`

- [ ] **Step 1: 写失败的测试** `tests/shared/chatCache.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  CHAT_CACHE_MAX_CHARS, CHAT_CACHE_MAX_EVENTS,
  parseChatCache, parseChatCacheIndex, reconcileCachedEvents, removeFromChatCacheIndex,
  serializeChatCache, serializeChatCacheIndex, touchChatCacheIndex,
} from "../../src/shared/chatCache.js";
import type { SessionEvent } from "../../src/session/events.js";

const ev = (seq: number, content = "x", sessionId = "s1"): SessionEvent =>
  ({ type: "chat_message", sessionId, seq, ts: 1000 + seq, fromUid: "u1", label: "alice", content }) as unknown as SessionEvent;
const seqs = (es: readonly SessionEvent[] | null): number[] | null => (es === null ? null : es.map((e) => e.seq));

describe("serializeChatCache / parseChatCache", () => {
  it("来回一遍原样", () => {
    const raw = serializeChatCache([ev(1), ev(2)]);
    expect(seqs(parseChatCache(raw, "s1"))).toEqual([1, 2]);
  });
  it("空的不存", () => {
    expect(serializeChatCache([])).toBeNull();
  });
  it("超过条数上限只留最新的", () => {
    const many = Array.from({ length: CHAT_CACHE_MAX_EVENTS + 5 }, (_, i) => ev(i));
    const back = parseChatCache(serializeChatCache(many), "s1")!;
    expect(back).toHaveLength(CHAT_CACHE_MAX_EVENTS);
    expect(back[0]!.seq).toBe(5);
    expect(back.at(-1)!.seq).toBe(CHAT_CACHE_MAX_EVENTS + 4);
  });
  it("超过字符上限从最旧的丢，最新那条留着", () => {
    const big = "字".repeat(Math.floor(CHAT_CACHE_MAX_CHARS / 3));
    const raw = serializeChatCache([ev(1, big), ev(2, big), ev(3, big), ev(4, "新")]);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBeLessThanOrEqual(CHAT_CACHE_MAX_CHARS);
    const back = seqs(parseChatCache(raw, "s1"))!;
    expect(back.at(-1)).toBe(4);
    expect(back).not.toContain(1);
  });
  it("只剩最新一条仍然超上限：这条聊天不存", () => {
    expect(serializeChatCache([ev(1), ev(2, "字".repeat(CHAT_CACHE_MAX_CHARS + 10))])).toBeNull();
  });
  it("读出来的东西不信：坏 JSON / 版本不对 / 不是数组 / seq 非数字 / sessionId 不符 → null", () => {
    expect(parseChatCache(null, "s1")).toBeNull();
    expect(parseChatCache("{", "s1")).toBeNull();
    expect(parseChatCache(JSON.stringify({ v: 2, events: [ev(1)] }), "s1")).toBeNull();
    expect(parseChatCache(JSON.stringify({ v: 1, events: {} }), "s1")).toBeNull();
    expect(parseChatCache(JSON.stringify({ v: 1, events: [{ ...ev(1), seq: "1" }] }), "s1")).toBeNull();
    expect(parseChatCache(JSON.stringify({ v: 1, events: [ev(1, "x", "other")] }), "s1")).toBeNull();
  });
  it("读出来按 seq 排好、同 seq 去重（insertCloudEvent 的前提是有序无重）", () => {
    const raw = JSON.stringify({ v: 1, events: [ev(3), ev(1), ev(3), ev(2)] });
    expect(seqs(parseChatCache(raw, "s1"))).toEqual([1, 2, 3]);
  });
});

describe("reconcileCachedEvents", () => {
  it("服务器一条都没给（serverMin 为 null）：全扔", () => {
    expect(reconcileCachedEvents([ev(1), ev(2)], null)).toEqual([]);
  });
  it("扔掉比服务器这一屏更早的，不留断档", () => {
    expect(seqs(reconcileCachedEvents([ev(100), ev(150), ev(300), ev(301)], 300))).toEqual([300, 301]);
  });
  it("团队群全量下发（serverMin 是第一条）：什么都不扔", () => {
    expect(seqs(reconcileCachedEvents([ev(0), ev(1), ev(2)], 0))).toEqual([0, 1, 2]);
  });
});

describe("缓存索引", () => {
  it("touch：新的排前面、同一条不重复、ts 更新", () => {
    let { index } = touchChatCacheIndex([], "a", 1, 30);
    ({ index } = touchChatCacheIndex(index, "b", 2, 30));
    ({ index } = touchChatCacheIndex(index, "a", 3, 30));
    expect(index).toEqual([{ sessionId: "a", ts: 3 }, { sessionId: "b", ts: 2 }]);
  });
  it("超过上限淘汰最久没写的", () => {
    const start = [{ sessionId: "old", ts: 1 }, { sessionId: "mid", ts: 5 }];
    const r = touchChatCacheIndex(start, "new", 9, 2);
    expect(r.index.map((x) => x.sessionId)).toEqual(["new", "mid"]);
    expect(r.evicted).toEqual(["old"]);
  });
  it("remove 与 parse/serialize 来回；坏数据回空表、坏条目跳过", () => {
    const idx = [{ sessionId: "a", ts: 2 }, { sessionId: "b", ts: 1 }];
    expect(parseChatCacheIndex(serializeChatCacheIndex(idx))).toEqual(idx);
    expect(removeFromChatCacheIndex(idx, "a")).toEqual([{ sessionId: "b", ts: 1 }]);
    expect(parseChatCacheIndex(null)).toEqual([]);
    expect(parseChatCacheIndex("nope")).toEqual([]);
    expect(parseChatCacheIndex(JSON.stringify([{ sessionId: "a", ts: 1 }, { sessionId: 3 }, null]))).toEqual([{ sessionId: "a", ts: 1 }]);
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `npx vitest run tests/shared/chatCache.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现** `src/shared/chatCache.ts`

```ts
// 手机端智能体聊天的本机缓存（#1426）：纯逻辑，IO 在 mobile/src/cloud/chatCache.ts。
//
// 缓存只是首屏占位，不是事实源——事件日志只增不改（Hard rule），同一个 seq 的内容永远相同，
// 所以存下来的事件不会「过时」，只会「不全」。点进聊天先画这一份，连上之后第一次 ready 时
// 按服务器这一轮最早那条对账（reconcileCachedEvents），之后一切以服务器下发的为准。
import type { SessionEvent } from "../session/events.js";

export const CHAT_CACHE_VERSION = 1;
/** 每条聊天最多存几条 = 服务器第一页的大小（BACKLOG_TAIL_DEFAULT）：再多存，连上时也会在对账里扔掉 */
export const CHAT_CACHE_MAX_EVENTS = 200;
/** 每条聊天序列化后最多多少字符。按 JSON 串的 length 算、不算 UTF-8 字节：量级对就够 */
export const CHAT_CACHE_MAX_CHARS = 300_000;
/** 最多存几条聊天，超了按最久没写的淘汰 */
export const CHAT_CACHE_MAX_CHATS = 30;

/** 截断后序列化。回 null = 这条聊天不存（空的，或只剩最新一条仍然超上限——存一条巨大的事件不如不存） */
export function serializeChatCache(events: readonly SessionEvent[]): string | null {
  const tail = events.slice(-CHAT_CACHE_MAX_EVENTS);
  if (tail.length === 0) return null;
  // 每条只 stringify 一次：从最旧的丢，直到总长不超（外壳与逗号的那几十个字符留在余量里）
  const parts = tail.map((e) => JSON.stringify(e));
  const shell = `{"v":${CHAT_CACHE_VERSION},"events":[]}`.length;
  let total = shell + parts.reduce((n, p) => n + p.length + 1, 0);
  let from = 0;
  while (total > CHAT_CACHE_MAX_CHARS && from < parts.length) {
    total -= parts[from]!.length + 1;
    from += 1;
  }
  if (from >= parts.length) return null;
  return `{"v":${CHAT_CACHE_VERSION},"events":[${parts.slice(from).join(",")}]}`;
}

/** 读出来的东西不信：版本 / 形状 / seq / sessionId 任何一处不对，整份当没有。结果按 seq 升序、同 seq 去重 */
export function parseChatCache(raw: string | null, sessionId: string): SessionEvent[] | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { v, events } = data as { v?: unknown; events?: unknown };
  if (v !== CHAT_CACHE_VERSION || !Array.isArray(events)) return null;
  const bySeq = new Map<number, SessionEvent>();
  for (const e of events) {
    if (typeof e !== "object" || e === null) return null;
    const { seq, sessionId: sid } = e as { seq?: unknown; sessionId?: unknown };
    if (typeof seq !== "number" || !Number.isFinite(seq) || sid !== sessionId) return null;
    bySeq.set(seq, e as SessionEvent);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 第一次 ready 时对账。`serverMin` = 这一轮服务器下发的最小 seq；null = 一条都没给（以服务器为准，全扔）。
    扔掉 seq 比它小的——那只可能是缓存来的，而服务器那一屏从 serverMin 连续到末尾，扔掉就不会留下断档 */
export function reconcileCachedEvents(events: readonly SessionEvent[], serverMin: number | null): SessionEvent[] {
  if (serverMin === null) return [];
  return events.filter((e) => e.seq >= serverMin);
}

export type ChatCacheIndex = { sessionId: string; ts: number }[];

/** kv-store 没有「按前缀列出」，清全部与淘汰都靠这张表。坏数据回空表、坏条目跳过 */
export function parseChatCacheIndex(raw: string | null): ChatCacheIndex {
  if (raw === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: ChatCacheIndex = [];
  for (const x of data) {
    if (typeof x !== "object" || x === null) continue;
    const { sessionId, ts } = x as { sessionId?: unknown; ts?: unknown };
    if (typeof sessionId === "string" && typeof ts === "number") out.push({ sessionId, ts });
  }
  return out;
}

export function serializeChatCacheIndex(index: ChatCacheIndex): string {
  return JSON.stringify(index);
}

/** 记一次写入：这条挪到最前（ts 更新），超过 max 的按最久没写的淘汰，回被淘汰的那几条 */
export function touchChatCacheIndex(
  index: ChatCacheIndex,
  sessionId: string,
  ts: number,
  max: number,
): { index: ChatCacheIndex; evicted: string[] } {
  const next = [{ sessionId, ts }, ...index.filter((x) => x.sessionId !== sessionId)].sort((a, b) => b.ts - a.ts);
  return { index: next.slice(0, max), evicted: next.slice(max).map((x) => x.sessionId) };
}

export function removeFromChatCacheIndex(index: ChatCacheIndex, sessionId: string): ChatCacheIndex {
  return index.filter((x) => x.sessionId !== sessionId);
}
```

- [ ] **Step 4: 跑测试看它通过**

Run: `npx vitest run tests/shared/chatCache.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/chatCache.ts tests/shared/chatCache.test.ts
git commit -m "feat(shared): 聊天本机缓存的纯逻辑——截断、解析、对账、索引淘汰（#1426）"
```

---

### Task 2: 手机端接线 + ADR + 索引

**Files:**
- Create: `mobile/src/cloud/chatCache.ts`
- Modify: `mobile/src/cloud/chatStore.ts`
- Create: `docs/adr/0334-手机本机缓存云会话事件只作首屏占位.md`（编号合并前再核）
- Modify: `AGENTS.md`（Where to find things 末尾加一条）

**Interfaces:**
- Consumes: Task 1 全部导出。
- Produces: `loadChatCache`、`scheduleChatCacheSave`、`flushChatCacheSave`、`removeChatCache`（`mobile/src/cloud/chatCache.ts`）；`ChatSession.provisional: boolean`。

- [ ] **Step 1: 写 IO 模块** `mobile/src/cloud/chatCache.ts`

```ts
// 智能体聊天的本机缓存：kv-store 读写（#1426，spec §2）。判据全在 src/shared/chatCache.ts。
//
// · 按账号分键（ADR-0187 本机数据跟着账号走），退出登录清掉那个账号的全部——消息是私人内容，
//   同一台手机下一个登录的人不该在磁盘上留着它（已读游标不清：它不含内容）。
// · 写盘排成一条串行链：索引是「读-改-写」，两次写交叉会把彼此的更新盖掉。
// · 失败一律吞掉：缓存只是加速，最坏的结局是下次照旧转圈。
import AsyncStorage from "expo-sqlite/kv-store";
import {
  CHAT_CACHE_MAX_CHATS, parseChatCache, parseChatCacheIndex, removeFromChatCacheIndex,
  serializeChatCache, serializeChatCacheIndex, touchChatCacheIndex,
} from "../../../src/shared/chatCache.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { supabase } from "../supabase.js";

const SAVE_DELAY_MS = 1000;
const keyOf = (uid: string, sessionId: string): string => `otto.chatCache.${uid}.${sessionId}`;
const indexKeyOf = (uid: string): string => `otto.chatCache.${uid}.index`;

let chain: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<void>): Promise<void> {
  chain = chain.then(job).catch(() => undefined);
  return chain;
}

export async function loadChatCache(uid: string, sessionId: string): Promise<SessionEvent[] | null> {
  try {
    return parseChatCache(await AsyncStorage.getItem(keyOf(uid, sessionId)), sessionId);
  } catch {
    return null;
  }
}

async function readIndex(uid: string) {
  return parseChatCacheIndex(await AsyncStorage.getItem(indexKeyOf(uid)));
}

async function write(uid: string, sessionId: string, events: readonly SessionEvent[]): Promise<void> {
  const raw = serializeChatCache(events);
  if (raw === null) return drop(uid, sessionId);
  await AsyncStorage.setItem(keyOf(uid, sessionId), raw);
  const { index, evicted } = touchChatCacheIndex(await readIndex(uid), sessionId, Date.now(), CHAT_CACHE_MAX_CHATS);
  for (const sid of evicted) await AsyncStorage.removeItem(keyOf(uid, sid));
  await AsyncStorage.setItem(indexKeyOf(uid), serializeChatCacheIndex(index));
}

async function drop(uid: string, sessionId: string): Promise<void> {
  await AsyncStorage.removeItem(keyOf(uid, sessionId));
  await AsyncStorage.setItem(indexKeyOf(uid), serializeChatCacheIndex(removeFromChatCacheIndex(await readIndex(uid), sessionId)));
}

let pending: { uid: string; sessionId: string; events: readonly SessionEvent[] } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 攒 1 秒写一次：聊天开着时每来一条事件都会调到这里 */
export function scheduleChatCacheSave(uid: string, sessionId: string, events: readonly SessionEvent[]): void {
  pending = { uid, sessionId, events };
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flushChatCacheSave();
  }, SAVE_DELAY_MS);
}

/** 离开这一页时立刻写掉攒着的那份 */
export function flushChatCacheSave(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const p = pending;
  pending = null;
  if (p === null) return chain;
  return enqueue(() => write(p.uid, p.sessionId, p.events));
}

/** 这条会话进不去了（denied）：删掉它的缓存，攒着没写的那份也作废 */
export function removeChatCache(uid: string, sessionId: string): Promise<void> {
  if (pending !== null && pending.uid === uid && pending.sessionId === sessionId) pending = null;
  return enqueue(() => drop(uid, sessionId));
}

function clearChatCaches(uid: string): Promise<void> {
  if (pending !== null && pending.uid === uid) pending = null;
  return enqueue(async () => {
    for (const { sessionId } of await readIndex(uid)) await AsyncStorage.removeItem(keyOf(uid, sessionId));
    await AsyncStorage.removeItem(indexKeyOf(uid));
  });
}

// 退出登录：SIGNED_OUT 那一刻 session 已经是 null，所以要自己记着上一个是谁
let owner: string | null = null;
void supabase.auth.getSession().then(({ data }) => {
  owner = data.session?.user.id ?? null;
});
supabase.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT" && owner !== null) void clearChatCaches(owner);
  owner = session?.user.id ?? null;
});
```

- [ ] **Step 2: 接进 `mobile/src/cloud/chatStore.ts`**

2a. import（放在 `import { cloudClient, … } from "./cloudClient.js";` 之后）：

```ts
import { reconcileCachedEvents } from "../../../src/shared/chatCache.js";
import { flushChatCacheSave, loadChatCache, removeChatCache, scheduleChatCacheSave } from "./chatCache.js";
```

2b. `ChatSession` 加一格（`events: SessionEvent[];` 之后）：

```ts
  /** 此刻 events 里还混着本机缓存来的（#1426）：第一次 ready 时对账，之后为假。为真时不写回缓存 */
  provisional: boolean;
```

2c. `let gen = 0;` 之后加：

```ts
/** 本机缓存（#1426）：这条聊天是替谁开的（缓存按账号分键）；对账之前服务器这一轮下发的最小 seq */
let cacheOwner: string | null = null;
let serverMin: number | null = null;
```

2d. `onEvent` 换成：

```ts
function onEvent(event: SessionEvent): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== event.sessionId) return;
  // 对账之前记下服务器这一轮给到哪儿——排在去重之前：与缓存同 seq 的那几条也是服务器给的
  if (s.session.provisional) serverMin = serverMin === null ? event.seq : Math.min(serverMin, event.seq);
  const events = insertCloudEvent(s.session.events, event);
  if (events === null) return;
  const streaming = clearCloudStreamingOn(s.streaming, event);
  store.set({ session: { ...s.session, events }, ...(streaming !== s.streaming ? { streaming } : {}) });
  if (!s.session.provisional && cacheOwner !== null) scheduleChatCacheSave(cacheOwner, event.sessionId, events);
  activity?.event(event);
}
```

2e. `onStatus` 换成：

```ts
function onStatus(status: CloudSessionStatus): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== status.sessionId) return;
  const prev = s.session.state;
  let session: ChatSession = { ...s.session, ...applyCloudStatus(s.session, status) };
  // 第一次 ready：服务器这一轮的历史已经全部进来了（客户端在 backlog 最后一片之后才翻 ready），
  // 扔掉缓存里比它更早的，从此以服务器为准（spec §3）
  if (session.provisional && session.state === "ready") {
    session = { ...session, provisional: false, events: reconcileCachedEvents(session.events, serverMin) };
    serverMin = null;
    if (cacheOwner !== null) scheduleChatCacheSave(cacheOwner, session.sessionId, session.events);
  }
  if (session.state === "denied" && cacheOwner !== null) void removeChatCache(cacheOwner, session.sessionId);
  store.set({ session, ...(status.notice === undefined ? {} : { notice: status.notice }) });
  if (prev !== session.state) activity?.room(session.sessionId, prev, session.state);
  if (session.state === "ready") void flushPendingFirst(session.sessionId);
}
```

2f. `openChat` 里，把

```ts
  const g = gen;
  const uid = await ensureUid();
  if (g !== gen) return;
  if (store.get().session?.sessionId === sessionId) return;
  store.set({
    session: {
      workspaceId, sessionId, state: "connecting",
      initiatorUid: null, ownerUid: "", selfUid: uid ?? "",
      modelRoute: null, gapNote: null, chat: seed, hasOlder: false,
      older: "idle", events: [],
    },
```

换成

```ts
  const g = gen;
  const uid = await ensureUid();
  if (g !== gen) return;
  if (store.get().session?.sessionId === sessionId) return;
  // 先画本机存着的（#1426）：本地 sqlite，毫秒级；读不到就是空的，照旧转圈
  const cached = uid === null ? null : await loadChatCache(uid, sessionId);
  if (g !== gen) return;
  if (store.get().session?.sessionId === sessionId) return;
  cacheOwner = uid;
  serverMin = null;
  store.set({
    session: {
      workspaceId, sessionId, state: "connecting",
      initiatorUid: null, ownerUid: "", selfUid: uid ?? "",
      modelRoute: null, gapNote: null, chat: seed, hasOlder: false,
      older: "idle", events: cached ?? [], provisional: true,
    },
```

2g. `closeChat` 换成：

```ts
export function closeChat(): void {
  activity?.closed();
  // 对过账的才写回：没连上就离开的，手上那份是「缓存 + 半截 backlog」，写回去没有新信息
  const s = store.get().session;
  if (s !== null && !s.provisional && cacheOwner !== null) scheduleChatCacheSave(cacheOwner, s.sessionId, s.events);
  void flushChatCacheSave();
  gen += 1;
  cacheOwner = null;
  serverMin = null;
  void cloudClient.leave();
  store.set(EMPTY);
}
```

同时把文件头注释的「三件手机自己的事」列表后面补一条：

```ts
// · **本机缓存**（#1426）：点进来先画上次存下的那一段（provisional），第一次 ready 时按服务器
//   这一轮最早那条对账；之后每来一条事件攒 1 秒写回。判据在 shared 的 chatCache.ts。
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p mobile`
Expected: 无输出（通过）

- [ ] **Step 4: 写 ADR** `docs/adr/0334-手机本机缓存云会话事件只作首屏占位.md`

```markdown
# ADR-0334：手机本机缓存云会话事件，只作首屏占位、连上以服务器为准

- 状态：已采纳（2026-09-29）
- Issue：#1426；spec：`docs/superpowers/specs/2026-09-29-mobile-chat-cache-design.md`

## 背景

维护者：「加载 agent 会话有点慢，可以做本地保存加快加载速度」。查过：慢的是连中继、进房验籍、拉历史
这段握手（真机那条群服务器上才 4 条事件），期间屏幕只有转圈。

## 决定

1. 手机把每条智能体聊天最近 200 条事件（≤30 万字符）存在本机 kv-store，按账号分键，最多 30 条聊天，
   退出登录清掉那个账号的全部。
2. 点进去先画缓存（`provisional`），照常连接；**第一次 ready 时对账**：扔掉 seq 小于服务器这一轮
   最小 seq 的缓存事件，服务器一条都没给就全扔。之后以服务器为准，每来一条事件攒 1 秒写回。
3. 事件日志仍是唯一事实源：日志只增不改，缓存是它的一段前缀副本，只会「不全」不会「过时」；
   对账保证不留断档。
4. 维护者拍板不做：提前连接、连接中先发、朋友私聊的缓存。

## 代价

- 缓存比服务器那屏长时，顶上那截在连上时消失（人停在底部，看不见）。
- App 在攒写的那 1 秒里被杀，最新几条没进缓存，下次由服务器补上。
- 被删 / 没权限的会话要等打开时 denied 才清缓存。
- 磁盘上多一份聊天内容（最多约 30 × 30 万字符），靠退出登录清。
- 真机一次没跑过。
```

- [ ] **Step 5: AGENTS.md 索引** —— 在 Where to find things 最后一条（`src/shared/speakCache.ts` 那条）之后加一行：

```markdown
- `src/shared/chatCache.ts` / `mobile/src/cloud/chatCache.ts` / `chatStore.ts` 的 `provisional` — **手机点进智能体聊天先画本机缓存**（ADR-0334，#1426）：慢的是握手不是历史；每条聊天存最近 200 条、按账号分键、退出即清。第一次 ready 时按服务器这一轮最小 seq 对账（扔掉更早的缓存事件，不留断档），之后以服务器为准。只改手机 JS
```

- [ ] **Step 6: 门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add mobile/src/cloud/chatCache.ts mobile/src/cloud/chatStore.ts docs/adr/0334-手机本机缓存云会话事件只作首屏占位.md AGENTS.md
git commit -m "feat(mobile): 点进智能体聊天先画本机缓存，连上按服务器对账（#1426）"
```
