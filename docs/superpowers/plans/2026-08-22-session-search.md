# 跨会话回忆（FTS5 + session_search）实施计划 — issue #177

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给模型一把 `session_search` 工具（零 LLM 调用），用 SQLite FTS5 全文检索历史会话；UI 用 retrieval-chunks / document-reference 两个 element 渲染结果。

**Architecture:** `EventStore` 加 `events_fts` 虚表（trigram，insert 触发器同步，启动回填）+ 四个查询方法。查询能力经新的 `ExecutionWorld.history` 可选能力注入（同 `withBrowser`/`withMcp` 手法）——工具只认 `world.history`，不碰 store（硬规则）。工具 `src/tools/sessionSearch.ts` 按参数推断 DISCOVERY / SCROLL / READ / BROWSE 四形态。

**Tech Stack:** better-sqlite3（SQLite 3.53，FTS5 + trigram 可用，已验证）/ TypeScript strict / vitest / assistant-ui elements

**Spec:** `docs/superpowers/specs/2026-08-22-memory-design.md` 第二节

## Global Constraints

- Hard rules：工具只依赖 `ExecutionWorld`（不 import store / fs）；渲染进程只走 ShellBridge；事件表 append-only（FTS 表是派生索引，可重建，不是事实）；schema 只加不改。
- trigram tokenizer 要求查询 ≥3 个字符；**<3 字符的查询走 `LIKE` 扫描兜底**（hermes 的 CJK-LIKE fallback 同款；中文双字词常见）。
- 索引的事件类型只有 `user_message`（`content`）/ `assistant_message`（`content`）/ `tool_result`（`output`）。
- 排除：`spawnedBy` 子会话（ADR-0047）、当前会话、`sys-memory-edits`（已归档，`session_archived` 的会话一律排除）。
- DISCOVERY：BM25 前 300 行 → 按 session 去重 → 最多 8 个 session；第一名 ±5 条事件 + 首尾各 3 条，其余只给命中那条。每条事件文本截 300 字符。
- READ 用 `deriveMessages(events, COMPACT_COMPRESSION)` 投影，总输出截 12,000 字符（尾部保留）。
- BROWSE：最近 20 个 session：id、标题（`sessions()` 的 title）、workspace、startedTs、turn 数（user_message 计数）。
- 测试放 `tests/`；分支 `claude/session-search`；commit 写 why。

---

### Task 1: EventStore 加 FTS5 索引（触发器 + 回填 + purge 清理）

**Files:**
- Modify: `src/session/store.ts`
- Test: `tests/session/store.fts.test.ts`

**Interfaces:**
- Produces（`EventStore` 新方法）：
  ```ts
  export interface FtsHit { sessionId: string; seq: number; type: "user_message" | "assistant_message" | "tool_result"; text: string; score: number }
  searchText(query: string, opts?: { limit?: number; excludeSessions?: string[] }): FtsHit[]
  ```
  `score` = `-bm25`（越大越相关）；LIKE 兜底时 score = 0。`excludeSessions` 之外，方法内部始终排除归档会话与 `spawnedBy` 子会话。

- [ ] **Step 1: 写失败测试**

```ts
// tests/session/store.fts.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { EventStore } from "../../src/session/store.js";

function seed(store: EventStore, sessionId: string, msgs: string[], opts: { spawnedBy?: boolean; archived?: boolean } = {}) {
  store.append({ sessionId, ts: 1, type: "session_created", workspace: "/w",
    ...(opts.spawnedBy ? { spawnedBy: { sessionId: "parent", toolCallId: "t", agent: "x" } } : {}) });
  for (const m of msgs) store.append({ sessionId, ts: 2, type: "user_message", content: m });
  if (opts.archived) store.append({ sessionId, ts: 3, type: "session_archived" });
}

describe("EventStore FTS", () => {
  let store: EventStore;
  beforeEach(() => { store = new EventStore(":memory:"); });

  it("trigram：≥3 字符命中，中文英文都行，按 BM25 排序", () => {
    seed(store, "a", ["用户住在悉尼北区", "今天改了 vitest 配置"]);
    seed(store, "b", ["悉尼北区 悉尼北区 悉尼北区 的房价"]);
    const hits = store.searchText("悉尼北区");
    expect(hits.map((h) => h.sessionId)).toEqual(["b", "a"]);
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(store.searchText("vitest")[0]).toMatchObject({ sessionId: "a", type: "user_message" });
  });

  it("<3 字符走 LIKE 兜底，score=0", () => {
    seed(store, "a", ["用户住在悉尼"]);
    expect(store.searchText("悉尼")).toMatchObject([{ sessionId: "a", score: 0 }]);
  });

  it("只索引三种事件；tool_result 按 output", () => {
    store.append({ sessionId: "a", ts: 1, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "a", ts: 2, type: "tool_result", toolCallId: "c1", status: "ok", output: "pnpm install 完成" });
    store.append({ sessionId: "a", ts: 3, type: "section_classified", title: "pnpm 安装", model: "m" });
    const hits = store.searchText("pnpm");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ type: "tool_result", seq: 1 });
  });

  it("排除归档会话、子会话、excludeSessions", () => {
    seed(store, "arch", ["关键词甲乙丙"], { archived: true });
    seed(store, "child", ["关键词甲乙丙"], { spawnedBy: true });
    seed(store, "me", ["关键词甲乙丙"]);
    seed(store, "ok", ["关键词甲乙丙"]);
    expect(store.searchText("关键词甲乙丙", { excludeSessions: ["me"] }).map((h) => h.sessionId)).toEqual(["ok"]);
  });

  it("purge 连 FTS 行一起删", () => {
    seed(store, "a", ["独一无二的句子"]);
    store.purge("a");
    expect(store.searchText("独一无二")).toEqual([]);
  });

  it("老库回填：FTS 表缺失时启动一次性建索引", () => {
    // 用同一个文件路径开两次：第一次只建 events（模拟旧库），第二次建 FTS 并回填
    const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const path = join(mkdtempSync(join(tmpdir(), "otto-fts-")), "log.db");
    const legacy = new (require("better-sqlite3"))(path);
    legacy.exec(`CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, sandbox_id TEXT, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq))`);
    legacy.prepare("INSERT INTO events VALUES ('old', 0, 1, 'session_created', NULL, '{\"workspace\":\"/w\"}')").run();
    legacy.prepare("INSERT INTO events VALUES ('old', 1, 2, 'user_message', NULL, '{\"content\":\"回填这句话\"}')").run();
    legacy.close();
    const s = new EventStore(path);
    expect(s.searchText("回填这句话")).toMatchObject([{ sessionId: "old", seq: 1 }]);
    s.close();
  });
});
```

- [ ] **Step 2: 跑，确认红** — `npx vitest run tests/session/store.fts.test.ts`

- [ ] **Step 3: 实现**

`SCHEMA` 之后加（不放进 `SCHEMA` 字符串，因为回填要先判表在不在）：

```ts
/** 派生索引，不是事实：events 是日志，events_fts 随时可 DROP 重建。
    trigram：中文不需要分词，代价是查询 ≥3 字符（短查询走 LIKE 兜底，见 searchText）。
    只收三种事件的正文——其余事件是系统事实/UI 路标，不是"过去说过的话" */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, text, tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events
WHEN NEW.type IN ('user_message','assistant_message','tool_result')
BEGIN
  INSERT INTO events_fts(session_id, seq, type, text)
  VALUES (NEW.session_id, NEW.seq, NEW.type,
          COALESCE(json_extract(NEW.payload, '$.content'), json_extract(NEW.payload, '$.output'), ''));
END;
`;
const FTS_INDEXED_TYPES = ["user_message", "assistant_message", "tool_result"] as const;
```

constructor 里 `this.db.exec(SCHEMA)` 之后：

```ts
    const hadFts = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events_fts'")
      .get();
    this.db.exec(FTS_SCHEMA);
    if (!hadFts) this.rebuildFts(); // 老库第一次开：一次性回填
```

方法：

```ts
  /** 从 events 重建索引。幂等：先清空再灌。老库首开、或索引损坏时用 */
  rebuildFts(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM events_fts");
      this.db
        .prepare(
          `INSERT INTO events_fts(session_id, seq, type, text)
           SELECT session_id, seq, type,
                  COALESCE(json_extract(payload, '$.content'), json_extract(payload, '$.output'), '')
             FROM events WHERE type IN ('user_message','assistant_message','tool_result')`
        )
        .run();
    })();
  }

  /** 全文检索。≥3 字符走 FTS5 trigram + BM25；更短的走 LIKE 兜底（trigram 的硬限制，
      中文双字词太常见不能不管）。永远排除归档会话与子会话 */
  searchText(query: string, opts: { limit?: number; excludeSessions?: string[] } = {}): FtsHit[] {
    const q = query.trim();
    if (!q) return [];
    const limit = opts.limit ?? 300;
    const exclude = opts.excludeSessions ?? [];
    const notIn = exclude.length ? `AND f.session_id NOT IN (${exclude.map(() => "?").join(",")})` : "";
    const common = `
      AND f.session_id NOT IN (SELECT DISTINCT session_id FROM events WHERE type = 'session_archived')
      AND f.session_id NOT IN (SELECT session_id FROM events WHERE seq = 0 AND json_extract(payload, '$.spawnedBy') IS NOT NULL)
      ${notIn}`;
    if ([...q].length >= 3) {
      const rows = this.db
        .prepare(
          `SELECT f.session_id AS sessionId, f.seq, f.type, f.text, -bm25(events_fts) AS score
             FROM events_fts f WHERE events_fts MATCH ? ${common}
            ORDER BY score DESC LIMIT ?`
        )
        .all(ftsQuote(q), ...exclude, limit) as FtsHit[];
      return rows;
    }
    return this.db
      .prepare(
        `SELECT f.session_id AS sessionId, f.seq, f.type, f.text, 0 AS score
           FROM events_fts f WHERE f.text LIKE ? ESCAPE '\\' ${common}
          ORDER BY f.session_id, f.seq LIMIT ?`
      )
      .all(`%${likeEscape(q)}%`, ...exclude, limit) as FtsHit[];
  }
```

helper（文件顶部）：

```ts
/** FTS5 查询语法里引号/运算符有意义；把用户词整体当短语：双引号包住，内部引号翻倍 */
function ftsQuote(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}
```

`purge` 的事务里，`del.run(id)` 之后加 `this.db.prepare("DELETE FROM events_fts WHERE session_id = ?").run(id)`。

- [ ] **Step 4: 跑，确认绿** — `npx vitest run tests/session && npx tsc --noEmit`

- [ ] **Step 5: 提交** — `feat(store): FTS5 trigram 索引——insert 触发器同步、老库回填、purge 连带删`

---

### Task 2: `ExecutionWorld.history` 能力 + 主进程实现

**Files:**
- Modify: `src/world/executionWorld.ts`（接口 + `withHistory` + 两个装饰器透传）
- Create: `src/main/historyCapability.ts`（用 EventStore 实现）
- Test: `tests/main/historyCapability.test.ts`、`tests/world/executionWorld.test.ts`（追加透传断言）

**Interfaces:**
```ts
// executionWorld.ts
export interface HistorySession { sessionId: string; title: string | null; workspace: string | null; startedTs: number; lastTs: number; userTurns: number }
export interface HistoryHit { sessionId: string; seq: number; type: string; text: string; score: number }
export interface HistoryCapability {
  /** 全文检索（已排除归档/子会话/当前会话） */
  search(query: string, opts?: { limit?: number }): HistoryHit[];
  /** 某会话 [fromSeq, toSeq] 区间的事件（含端点）；未知会话 = [] */
  window(sessionId: string, fromSeq: number, toSeq: number): SessionEvent[];
  /** 整段事件；未知会话 = [] */
  load(sessionId: string): SessionEvent[];
  /** 最近会话（排除归档/子会话/当前会话） */
  recent(limit: number): HistorySession[];
}
export function withHistory(world: ExecutionWorld, history: HistoryCapability): ExecutionWorld;
// historyCapability.ts
export function createHistoryCapability(store: EventStore, currentSessionId: () => string): HistoryCapability;
```
`withAbortSignal` / `withExecOutput` 加 `...(world.history ? { history: world.history } : {})`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/main/historyCapability.test.ts
import { describe, it, expect } from "vitest";
import { EventStore } from "../../src/session/store.js";
import { createHistoryCapability } from "../../src/main/historyCapability.js";

function seed(store: EventStore, id: string, msgs: string[], ts = 1) {
  store.append({ sessionId: id, ts, type: "session_created", workspace: "/w" });
  msgs.forEach((m, i) => {
    store.append({ sessionId: id, ts: ts + i + 1, type: "user_message", content: m });
    store.append({ sessionId: id, ts: ts + i + 1, type: "assistant_message", content: `回：${m}` });
  });
}

describe("historyCapability", () => {
  it("search 排除当前会话；window 取区间；load 全段；recent 按 lastTs 倒序带 userTurns", () => {
    const store = new EventStore(":memory:");
    seed(store, "cur", ["关键词甲乙丙"], 100);
    seed(store, "old", ["关键词甲乙丙", "第二句"], 1);
    const h = createHistoryCapability(store, () => "cur");
    expect(h.search("关键词甲乙丙").map((x) => x.sessionId)).toEqual(["old"]);
    expect(h.window("old", 1, 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(h.load("old")).toHaveLength(5);
    expect(h.load("nope")).toEqual([]);
    expect(h.recent(10)).toMatchObject([{ sessionId: "old", userTurns: 2, title: "关键词甲乙丙" }]);
  });
});
```

`tests/world/executionWorld.test.ts` 追加：`withAbortSignal` / `withExecOutput` 对带 `history` 的 world 保持同一引用（照 config 那条写）。

- [ ] **Step 2: 红**

- [ ] **Step 3: 实现**

```ts
// src/main/historyCapability.ts
// 历史会话查询能力——session_search 工具的世界。工具只认 world.history（硬规则），
// 这里把 EventStore 焊成那个接口；v2 SandboxWorld 可以换成 RPC 到宿主。
import type { EventStore } from "../session/store.js";
import type { HistoryCapability } from "../world/executionWorld.js";

export function createHistoryCapability(store: EventStore, currentSessionId: () => string): HistoryCapability {
  return {
    search: (query, opts) =>
      store.searchText(query, { ...(opts?.limit ? { limit: opts.limit } : {}), excludeSessions: [currentSessionId()] }),
    window: (sessionId, fromSeq, toSeq) =>
      store.load(sessionId).filter((e) => e.seq >= fromSeq && e.seq <= toSeq),
    load: (sessionId) => store.load(sessionId),
    recent: (limit) =>
      store
        .sessions()
        .filter((s) => s.spawnedFrom === null && s.sessionId !== currentSessionId())
        .slice(0, limit)
        .map((s) => ({
          sessionId: s.sessionId, title: s.title, workspace: s.workspace,
          startedTs: s.startedTs, lastTs: s.lastTs,
          userTurns: store.load(s.sessionId).filter((e) => e.type === "user_message").length,
        })),
  };
}
```

（`recent` 里每个 session `load` 一遍数 turn：20 个会话、只在 BROWSE 时跑，可接受；若 `sessions()` 已有 `events` 计数也别用它——那是总事件数不是 turn 数。）

- [ ] **Step 4: 绿 + tsc**

- [ ] **Step 5: 提交** — `feat(world): history 能力——session_search 的世界，工具不碰 store`

---

### Task 3: `session_search` 工具（四形态，零 LLM）

**Files:**
- Create: `src/tools/sessionSearch.ts`
- Test: `tests/tools/sessionSearch.test.ts`

**Interfaces:**
```ts
export const SESSION_SEARCH_TOOL_NAME = "session_search";
export function createSessionSearchTool(): Tool;   // requiresApproval: false; available = 恒真（挂载由 world.history 决定）
export type SessionSearchMode = "discovery" | "scroll" | "read" | "browse";
export function inferMode(args: Record<string, unknown>): SessionSearchMode; // query→discovery；session_id+around_seq→scroll；session_id→read；否则 browse
/** 输出末行机器可读：<!--session_search:{...}--> ，UI 据此渲染 */
export interface SessionSearchResult {
  mode: SessionSearchMode;
  query?: string;
  chunks?: { id: string; sessionId: string; seq: number; source: string; locator: string; text: string; score: number }[]; // discovery
  document?: { sessionId: string; title: string; pages: number; anchors: { page: number; label: string }[] };          // read
}
export function parseSessionSearchResult(output: string): SessionSearchResult | null;
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/tools/sessionSearch.test.ts
import { describe, it, expect } from "vitest";
import { createSessionSearchTool, inferMode, parseSessionSearchResult } from "../../src/tools/sessionSearch.js";
import type { ExecutionWorld, HistoryCapability } from "../../src/world/executionWorld.js";
import type { SessionEvent } from "../../src/session/events.js";

function ev(sessionId: string, seq: number, type: "user_message" | "assistant_message", content: string): SessionEvent {
  return { sessionId, seq, ts: seq, type, content } as SessionEvent;
}
const sessions: Record<string, SessionEvent[]> = {
  s1: [
    { sessionId: "s1", seq: 0, ts: 0, type: "session_created", workspace: "/w" } as SessionEvent,
    ...Array.from({ length: 12 }, (_, i) => ev("s1", i + 1, i % 2 ? "assistant_message" : "user_message", `第${i + 1}句 ${i === 6 ? "关键词" : ""}`)),
  ],
  s2: [
    { sessionId: "s2", seq: 0, ts: 0, type: "session_created", workspace: "/w" } as SessionEvent,
    ev("s2", 1, "user_message", "另一个会话也有关键词"),
  ],
};
const history: HistoryCapability = {
  search: (q) => (q.includes("关键词")
    ? [{ sessionId: "s1", seq: 7, type: "user_message", text: "第7句 关键词", score: 2 },
       { sessionId: "s1", seq: 7, type: "user_message", text: "重复命中同一条", score: 1.5 },
       { sessionId: "s2", seq: 1, type: "user_message", text: "另一个会话也有关键词", score: 1 }]
    : []),
  window: (id, a, b) => (sessions[id] ?? []).filter((e) => e.seq >= a && e.seq <= b),
  load: (id) => sessions[id] ?? [],
  recent: (n) => [{ sessionId: "s2", title: "另一个会话也有关键词", workspace: "/w", startedTs: 0, lastTs: 5, userTurns: 1 }].slice(0, n),
};
const world = { history } as unknown as ExecutionWorld;
const tool = createSessionSearchTool();
const text = async (args: unknown) => { const r = await tool.run(args, world); return typeof r === "string" ? r : r.output; };

describe("inferMode", () => {
  it.each([
    [{ query: "x" }, "discovery"],
    [{ session_id: "s", around_seq: 3 }, "scroll"],
    [{ session_id: "s" }, "read"],
    [{}, "browse"],
  ])("%j → %s", (args, mode) => { expect(inferMode(args as Record<string, unknown>)).toBe(mode); });
});

describe("session_search", () => {
  it("discovery：按 session 去重、第一名带 ±5 + 首尾 3、其余只给命中；末行机器可读", async () => {
    const out = await text({ query: "关键词" });
    expect(out).toContain("s1");
    expect(out).toContain("第2句");      // 第一名的上下文窗（seq 7 ± 5）
    expect(out).toContain("第12句");     // 尾部 bookend
    expect(out).not.toContain("重复命中"); // 同 session 去重
    const parsed = parseSessionSearchResult(out)!;
    expect(parsed.mode).toBe("discovery");
    expect(parsed.chunks!.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
    expect(parsed.chunks![0]).toMatchObject({ seq: 7, score: 2, locator: expect.stringContaining("#7") });
  });
  it("discovery 零命中：人话 + 空 chunks", async () => {
    const out = await text({ query: "没有的词" });
    expect(out).toMatch(/没有找到/);
    expect(parseSessionSearchResult(out)!.chunks).toEqual([]);
  });
  it("scroll：围绕 seq 取窗，window 默认 5", async () => {
    const out = await text({ session_id: "s1", around_seq: 6 });
    expect(out).toContain("第1句");
    expect(out).toContain("第11句");
    expect(out).not.toContain("第12句");
  });
  it("read：COMPACT 投影 + document 元数据（pages = user turn 数）", async () => {
    const out = await text({ session_id: "s1" });
    expect(out).toContain("第1句");
    const parsed = parseSessionSearchResult(out)!;
    expect(parsed.document).toMatchObject({ sessionId: "s1", pages: 6 });
  });
  it("read：未知会话报错", async () => {
    await expect(tool.run({ session_id: "nope" }, world)).rejects.toThrow(/没有/);
  });
  it("browse：最近会话列表", async () => {
    const out = await text({});
    expect(out).toContain("s2");
    expect(out).toContain("另一个会话也有关键词");
  });
  it("world 没有 history 能力 = 人话报错", async () => {
    await expect(tool.run({ query: "x" }, {} as ExecutionWorld)).rejects.toThrow(/历史/);
  });
});
```

- [ ] **Step 2: 红** — `npx vitest run tests/tools/sessionSearch.test.ts`

- [ ] **Step 3: 实现**

```ts
// src/tools/sessionSearch.ts
// session_search — 跨会话回忆。对标 hermes tools/session_search_tool.py：四种形态由参数推断，
// 零 LLM 调用；过去做过什么去查，不存进记忆（ADR-0060 的另一半）。
// 只认 world.history（硬规则）；索引本身在 EventStore（派生、可重建）。
import type { Tool } from "./tool.js";
import type { ExecutionWorld, HistoryHit } from "../world/executionWorld.js";
import type { SessionEvent } from "../session/events.js";
import { deriveMessages, COMPACT_COMPRESSION } from "../session/deriveMessages.js";

export const SESSION_SEARCH_TOOL_NAME = "session_search";
const RESULT_MARK = "<!--session_search:";
const MAX_SESSIONS = 8;
const TOP_WINDOW = 5;
const BOOKEND = 3;
const SNIPPET = 300;
const READ_CAP = 12_000;

export type SessionSearchMode = "discovery" | "scroll" | "read" | "browse";
export interface SessionSearchResult {
  mode: SessionSearchMode;
  query?: string;
  chunks?: { id: string; sessionId: string; seq: number; source: string; locator: string; text: string; score: number }[];
  document?: { sessionId: string; title: string; pages: number; anchors: { page: number; label: string }[] };
}

export function inferMode(a: Record<string, unknown>): SessionSearchMode {
  if (typeof a["query"] === "string" && a["query"].trim()) return "discovery";
  if (typeof a["session_id"] === "string") return typeof a["around_seq"] === "number" ? "scroll" : "read";
  return "browse";
}

export function parseSessionSearchResult(output: string): SessionSearchResult | null {
  const i = output.lastIndexOf(RESULT_MARK);
  if (i < 0) return null;
  try { return JSON.parse(output.slice(i + RESULT_MARK.length, output.lastIndexOf("-->"))) as SessionSearchResult; }
  catch { return null; }
}

function clip(s: string, n = SNIPPET): string {
  return [...s].length > n ? [...s].slice(0, n).join("") + `…[截断，原长 ${[...s].length}]` : s;
}
function textOf(e: SessionEvent): string | null {
  if (e.type === "user_message" || e.type === "assistant_message") return e.content;
  if (e.type === "tool_result") return e.output;
  return null;
}
function role(e: SessionEvent): string {
  return e.type === "user_message" ? "user" : e.type === "assistant_message" ? "assistant" : "tool";
}
function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderEvents(events: SessionEvent[]): string {
  return events.map((e) => { const t = textOf(e); return t === null ? null : `[#${e.seq}] ${role(e)}: ${clip(t)}`; })
    .filter((x): x is string => x !== null).join("\n");
}
function titleOf(events: SessionEvent[]): string {
  const first = events.find((e) => e.type === "user_message");
  return first && first.type === "user_message" ? first.content.split("\n")[0]!.trim().slice(0, 60) : "(无标题)";
}
function tail(s: string, cap: number): string {
  const cps = [...s];
  return cps.length <= cap ? s : `…[前 ${cps.length - cap} 字符已省略]\n` + cps.slice(-cap).join("");
}

export function createSessionSearchTool(): Tool {
  async function run(args: unknown, world: ExecutionWorld): Promise<string> {
    const h = world.history;
    if (!h) throw new Error("这个世界没有历史会话查询能力");
    const a = (args ?? {}) as Record<string, unknown>;
    const mode = inferMode(a);

    if (mode === "browse") {
      const list = h.recent(20);
      const body = list.length
        ? list.map((s) => `- ${s.sessionId} · ${s.title ?? "(无标题)"} · ${fmtTs(s.startedTs)} · ${s.userTurns} 轮 · ${s.workspace ?? ""}`).join("\n")
        : "没有历史会话。";
      return `最近 ${list.length} 个会话（传 session_id 读整段，或 query 全文检索）：\n${body}\n${RESULT_MARK}${JSON.stringify({ mode })}-->`;
    }

    if (mode === "read") {
      const id = a["session_id"] as string;
      const events = h.load(id);
      if (events.length === 0) throw new Error(`没有 id 为「${id}」的会话`);
      const msgs = deriveMessages(events, COMPACT_COMPRESSION).filter((m) => m.role !== "system");
      const body = msgs.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[多模态]"}`).join("\n\n");
      const userTurns = events.filter((e) => e.type === "user_message");
      const anchors = userTurns.map((e, i) => ({ page: i + 1, label: clip((e as { content: string }).content.split("\n")[0]!, 40) }));
      const result: SessionSearchResult = { mode, document: { sessionId: id, title: titleOf(events), pages: userTurns.length, anchors } };
      return `会话 ${id}「${titleOf(events)}」，${userTurns.length} 轮：\n${tail(body, READ_CAP)}\n${RESULT_MARK}${JSON.stringify(result)}-->`;
    }

    if (mode === "scroll") {
      const id = a["session_id"] as string;
      const around = a["around_seq"] as number;
      const win = typeof a["window"] === "number" ? a["window"] : TOP_WINDOW;
      const events = h.window(id, around - win, around + win);
      if (events.length === 0) throw new Error(`没有 id 为「${id}」的会话，或 seq ${around} 附近没有事件`);
      return `会话 ${id} 第 ${around} 条附近（±${win}）：\n${renderEvents(events)}\n${RESULT_MARK}${JSON.stringify({ mode })}-->`;
    }

    // discovery
    const query = (a["query"] as string).trim();
    const hits = h.search(query, { limit: 300 });
    // 按 session 去重：保留每个 session 分最高的那条（hits 已按分排序）
    const best = new Map<string, HistoryHit>();
    for (const hit of hits) if (!best.has(hit.sessionId)) best.set(hit.sessionId, hit);
    const top = [...best.values()].slice(0, MAX_SESSIONS);
    if (top.length === 0) {
      return `没有找到包含「${query}」的历史会话。换个词试试，或不带参数调用列出最近会话。\n${RESULT_MARK}${JSON.stringify({ mode, query, chunks: [] })}-->`;
    }
    const sections: string[] = [];
    const chunks: NonNullable<SessionSearchResult["chunks"]> = [];
    top.forEach((hit, rank) => {
      const all = h.load(hit.sessionId);
      const title = titleOf(all);
      chunks.push({ id: `${hit.sessionId}#${hit.seq}`, sessionId: hit.sessionId, seq: hit.seq, source: title,
        locator: `${fmtTs(all[0]?.ts ?? 0)} · #${hit.seq}`, text: clip(hit.text, 160), score: hit.score });
      if (rank === 0) {
        // 第一名：命中 ±5 + 首尾各 3（hermes 的 adaptive hydration）
        const byText = all.filter((e) => textOf(e) !== null);
        const head = byText.slice(0, BOOKEND);
        const tailE = byText.slice(-BOOKEND);
        const mid = all.filter((e) => e.seq >= hit.seq - TOP_WINDOW && e.seq <= hit.seq + TOP_WINDOW && textOf(e) !== null);
        const seen = new Set<number>();
        const merged = [...head, ...mid, ...tailE].filter((e) => (seen.has(e.seq) ? false : (seen.add(e.seq), true))).sort((x, y) => x.seq - y.seq);
        sections.push(`## ${hit.sessionId}「${title}」（最相关，命中 #${hit.seq}）\n${renderEvents(merged)}`);
      } else {
        sections.push(`## ${hit.sessionId}「${title}」（命中 #${hit.seq}）\n[#${hit.seq}] ${hit.type}: ${clip(hit.text)}`);
      }
    });
    const result: SessionSearchResult = { mode, query, chunks };
    return `「${query}」命中 ${best.size} 个会话（展示前 ${top.length}）。要看某段前后用 session_id + around_seq，整段用 session_id：\n\n${sections.join("\n\n")}\n${RESULT_MARK}${JSON.stringify(result)}-->`;
  }

  return {
    def: {
      name: SESSION_SEARCH_TOOL_NAME,
      description:
        "查历史会话（不含当前会话）。过去做过什么、进度到哪、当时怎么决定的，用这个查，别存进记忆。" +
        "四种用法：query = 全文检索；session_id = 读整段；session_id + around_seq = 看某条前后；不带参数 = 列最近会话。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词（≥3 字符走全文索引，更短走子串匹配）" },
          session_id: { type: "string", description: "要读的会话 id" },
          around_seq: { type: "number", description: "配合 session_id：看这条事件前后" },
          window: { type: "number", description: "配合 around_seq：前后各取几条，默认 5" },
        },
      },
    },
    requiresApproval: false,
    run,
  };
}
```

- [ ] **Step 4: 绿 + architecture test** — `npx vitest run tests/tools tests/architecture.test.ts && npx tsc --noEmit`

- [ ] **Step 5: 提交** — `feat(tools): session_search——四形态零 LLM 的跨会话回忆`

---

### Task 4: 装配 + 系统提示词一句

**Files:**
- Modify: `src/main/agent.ts`（选项 `history?: HistoryCapability`；`withHistory`；挂工具）
- Modify: `src/main/index.ts`（主会话 createAgent 传 `history: createHistoryCapability(store, () => sessionId)`；探针 createAgent 也传，否则 TOOL_NAMES 没有它）
- Modify: `src/session/deriveMessages.ts`（`renderMemoryPrompt` 的指引段追加一句——它跟着 `memory_loaded` 走，和记忆是一对）
- Test: `tests/main/agent.test.ts`（追加：有 history 才挂 `session_search`）、`tests/session/deriveMessages.memory.test.ts`（指引含 session_search）

- [ ] **Step 1: 测试**

```ts
  it("world 有 history 才挂 session_search", () => {
    expect(createAgent({ ...minimalOpts(), world: fakeWorld() }).toolDefs.map((d) => d.name)).not.toContain("session_search");
    const history = { search: () => [], window: () => [], load: () => [], recent: () => [] };
    expect(createAgent({ ...minimalOpts(), world: fakeWorld(), history }).toolDefs.map((d) => d.name)).toContain("session_search");
  });
```

`deriveMessages.memory.test.ts` 追加：空记忆快照的 system 含 "session_search"。

- [ ] **Step 2: 红**

- [ ] **Step 3: 实现**

agent.ts：选项 `history?: HistoryCapability`；造 world 后 `if (opts.history) world = withHistory(world, opts.history)`（照 browser/mcp 的接法）；工具表加 `...(world.history ? [createSessionSearchTool()] : [])`。子会话（subagentRunner）继承父 world → 自动有；`resumeChild` 不传。

index.ts：主会话与探针两处 `createAgent` 传 `history: createHistoryCapability(store, () => sessionId)`（探针用一个固定假 id）。

deriveMessages.ts `renderMemoryPrompt` 指引第 2 句末尾加：「过去做过什么、进度到哪、当时怎么决定的——用 session_search 查历史会话。」

- [ ] **Step 4: `npm test`**

- [ ] **Step 5: 提交** — `feat(agent): 挂 session_search（有 history 能力才挂）；记忆指引补一句去查历史`

---

### Task 5: UI——retrieval-chunks（DISCOVERY）+ document-reference（READ）

> 写 UI 前 `Skill: emil-design-eng`。

**Files:**
- Run: `npx shadcn@latest add "@assistant-ui/elements-retrieval-chunks" "@assistant-ui/elements-document-reference"`（拒绝覆盖 `surfaces.tsx`、拒绝无关依赖——memory-chips 那次的教训）
- Modify: `src/renderer/src/aui/OttoThread.tsx`（`SessionSearchCard`）
- Create: `src/renderer/src/lib/sessionSearchCard.ts`（纯函数：result → element props）
- Test: `tests/renderer/sessionSearchCard.test.ts`

**Interfaces:**
- `parseSessionSearchResult` 要让 renderer 能 import → Task 3 里把它和 `SessionSearchResult` 放进 `src/shared/sessionSearch.ts`，`src/tools/sessionSearch.ts` re-export（memory 那次同款）。
- `toRetrievalProps(result): { query: string; chunks: RetrievalChunk[]; visibleCount: number }`，score 归一化到 0..1（除以最大分，LIKE 兜底全 0 → 0.5）；
- `toDocumentProps(result): { title: string; pages: number; anchors: DocumentAnchor[] }`。

- [ ] **Step 1–2: 纯函数测试红→绿**
- [ ] **Step 3: 卡片**

`ToolFallbackWithLiveTail` 里 `memory` 分支之后：

```tsx
  if (part.toolName === "session_search" && part.isError !== true) {
    const parsed = typeof part.result === "string" ? parseSessionSearchResult(part.result) : null;
    if (parsed?.mode === "discovery" && parsed.chunks) return <RetrievalCard result={parsed} searching={false} />;
    if (parsed?.mode === "read" && parsed.document) return <DocumentCard result={parsed} />;
  }
```

`RetrievalCard`：`<RetrievalChunks query chunks visibleCount searching className="my-1 max-w-none" />`；`part.result === undefined` 时 `searching` 为 true、chunks 为空。
`DocumentCard`：`<DocumentReference title pages anchors activePage={0} onJump={() => useChat.getState().resume(result.document.sessionId)} />`——`resume` 是 store 里切会话的 action（`window.otter.resumeSession`）。

- [ ] **Step 4: `npm test` + `npm run e2e`**
- [ ] **Step 5: 提交** — `feat(session-search-ui): retrieval-chunks / document-reference 两张卡`

---

### Task 6: ADR + CONTEXT + 收尾

- ADR 号 = 合并时下一个空号（此刻 0061）：「跨会话回忆靠搜索不靠注入」——决定：FTS 是派生索引（可 DROP 重建，不是事实）；查询经 `world.history` 能力（工具不碰 store）；不自动注入历史，只给工具；子会话/归档/当前会话排除；<3 字符 LIKE 兜底。
- CONTEXT.md 两行：「跨会话回忆（session_search）」「历史索引（events_fts）」。
- `npm test` 绿 → push → PR `Closes #177`，body 贴 e2e 结果。**PR 开了就停，合并由维护者决定。**
