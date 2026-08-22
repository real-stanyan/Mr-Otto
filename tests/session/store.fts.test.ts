import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { EventStore } from "../../src/session/store.js";

function seed(
  store: EventStore,
  sessionId: string,
  msgs: string[],
  opts: { spawnedBy?: boolean; archived?: boolean } = {}
) {
  store.append({
    sessionId,
    ts: 1,
    type: "session_created",
    workspace: "/w",
    ...(opts.spawnedBy ? { spawnedBy: { sessionId: "parent", toolCallId: "t", agent: "x" } } : {}),
  });
  for (const m of msgs) store.append({ sessionId, ts: 2, type: "user_message", content: m });
  if (opts.archived) store.append({ sessionId, ts: 3, type: "session_archived" });
}

describe("EventStore FTS", () => {
  let store: EventStore;
  beforeEach(() => {
    store = new EventStore(":memory:");
  });

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
    const path = join(mkdtempSync(join(tmpdir(), "otto-fts-")), "log.db");
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, sandbox_id TEXT, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq))`
    );
    legacy.prepare("INSERT INTO events VALUES ('old', 0, 1, 'session_created', NULL, '{\"workspace\":\"/w\"}')").run();
    legacy.prepare("INSERT INTO events VALUES ('old', 1, 2, 'user_message', NULL, '{\"content\":\"回填这句话\"}')").run();
    legacy.close();
    const s = new EventStore(path);
    expect(s.searchText("回填这句话")).toMatchObject([{ sessionId: "old", seq: 1 }]);
    s.close();
  });

  it("events_fts 表已建但是空的 + events 里有数据 → 不回填（存在即视为已完成，不看是否为空）", () => {
    const path = join(mkdtempSync(join(tmpdir(), "otto-fts-")), "log.db");
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, sandbox_id TEXT, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq))`
    );
    legacy.exec(
      `CREATE VIRTUAL TABLE events_fts USING fts5(session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, text, tokenize='trigram')`
    );
    legacy.prepare("INSERT INTO events VALUES ('old', 0, 1, 'session_created', NULL, '{\"workspace\":\"/w\"}')").run();
    legacy
      .prepare("INSERT INTO events VALUES ('old', 1, 2, 'user_message', NULL, '{\"content\":\"不该被回填的句子\"}')")
      .run();
    legacy.close();
    const s = new EventStore(path);
    expect(s.searchText("不该被回填的句子")).toEqual([]);
    s.close();
  });

  it("userTurnCounts 批量数 user_message：只数点名的会话，未知会话不出现在结果里", () => {
    seed(store, "a", ["第一句", "第二句"]);
    seed(store, "b", ["只有一句"]);
    const counts = store.userTurnCounts(["a", "b", "nope"]);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
    expect(counts.has("nope")).toBe(false);
    expect(store.userTurnCounts([])).toEqual(new Map());
  });
});
