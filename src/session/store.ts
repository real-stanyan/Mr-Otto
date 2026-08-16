// EventStore — SQLite 持久化的 append-only 事件日志
// 不变量在数据库层强制：PRIMARY KEY 挡重复 seq，trigger 挡 UPDATE/DELETE

import Database from "better-sqlite3";
import type { SessionEvent } from "./events.js";

// SessionEvent 去掉 seq（seq 由 EventStore 分配）。
// 普通 Omit 会把 discriminated union 压扁成只剩公共字段，
// 这里用分配式条件类型让 Omit 对 union 的每个成员分别生效。
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewSessionEvent = DistributiveOmit<SessionEvent, "seq">;

/** 会话列表条目——sessions() 的返回形状，欢迎页直接消费 */
export interface SessionSummary {
  sessionId: string;
  /** 事件条数（粗略的"会话有多长"） */
  events: number;
  startedTs: number;
  /** 最后一条事件的时间——列表按它倒序，最近聊过的在最上面 */
  lastTs: number;
  /** 旧日志可能没记 workspace → null（不可恢复，UI 该滤掉） */
  workspace: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  type       TEXT    NOT NULL,
  sandbox_id TEXT,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events log is append-only'); END;
`;

export class EventStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /** 追加一条事件，seq 由存储层分配，返回完整事件 */
  append(event: NewSessionEvent): SessionEvent {
    const insert = this.db.transaction((e: NewSessionEvent): SessionEvent => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE session_id = ?")
        .get(e.sessionId) as { next: number };

      // 信封拆列，其余进 payload JSON
      const { sessionId, ts, sandboxId, type, ...payload } = e;
      this.db
        .prepare(
          "INSERT INTO events (session_id, seq, ts, type, sandbox_id, payload) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(sessionId, row.next, ts, type, sandboxId ?? null, JSON.stringify(payload));

      return { ...e, seq: row.next } as SessionEvent;
    });
    return insert(event);
  }

  /** 按 seq 顺序读出一个会话的全部事件 */
  load(sessionId: string): SessionEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, ts, type, sandbox_id, payload FROM events WHERE session_id = ? ORDER BY seq"
      )
      .all(sessionId) as {
      seq: number;
      ts: number;
      type: string;
      sandbox_id: string | null;
      payload: string;
    }[];

    return rows.map((r) => ({
      seq: r.seq,
      sessionId,
      ts: r.ts,
      type: r.type,
      ...(r.sandbox_id !== null ? { sandboxId: r.sandbox_id } : {}),
      ...JSON.parse(r.payload),
    })) as SessionEvent[];
  }

  /** 列出库里所有会话（欢迎页会话列表 / CLI --list 用），新会话在前 */
  sessions(): SessionSummary[] {
    // workspace 藏在第 0 条事件（session_created）的 payload JSON 里，
    // 用 json_extract 在 SQL 层投影出来——又一个"从日志推导"的例子。
    // 旧日志可能没有 workspace 字段 → null（schema 向后兼容硬规则）。
    // 归档的会话（日志里出现过 session_archived）不进列表：删除 = 投影里消失，日志原封不动。
    return this.db
      .prepare(
        `SELECT session_id AS sessionId,
                COUNT(*)   AS events,
                MIN(ts)    AS startedTs,
                MAX(ts)    AS lastTs,
                (SELECT json_extract(payload, '$.workspace')
                   FROM events e0
                  WHERE e0.session_id = e.session_id AND e0.seq = 0) AS workspace
           FROM events e
          WHERE session_id NOT IN
                (SELECT DISTINCT session_id FROM events WHERE type = 'session_archived')
          GROUP BY session_id
          ORDER BY lastTs DESC`
      )
      .all() as SessionSummary[];
  }

  close(): void {
    this.db.close();
  }
}
