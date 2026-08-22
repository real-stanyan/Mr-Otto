// EventStore — SQLite 持久化的 append-only 事件日志
// 不变量在数据库层强制：PRIMARY KEY 挡重复 seq，trigger 挡 UPDATE/DELETE

import Database from "better-sqlite3";
import type { SessionEvent } from "./events.js";
import { BILLED_EVENT_TYPES } from "./deriveUsage.js";
import type { BilledRow } from "../shared/usageStats.js";

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
  /** 标题投影，优先级：最后一条 session_renamed（用户手动改名）＞
      第一条 user_message 首行（自动推导）＞ null（UI 自行兜底） */
  title: string | null;
  /** 这个会话是不是被派活派出来的子会话（ADR-0047）：是就带上派它的那个父
      会话 id，供 UI 把它从侧栏滤掉、以及子会话视图里"← 回到父会话"用。
      从第 0 条 session_created 的 spawnedBy.sessionId 投影出来。
      不是子会话 / 旧日志没有 spawnedBy 字段 → null（schema 向后兼容硬规则） */
  spawnedFrom: string | null;
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

/** FTS5 查询语法里引号/运算符有意义；把用户词整体当短语：双引号包住，内部引号翻倍 */
function ftsQuote(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** searchText() 的命中行——一条被索引的历史消息/工具结果 */
export interface FtsHit {
  sessionId: string;
  seq: number;
  type: "user_message" | "assistant_message" | "tool_result";
  text: string;
  /** -bm25（越大越相关）；LIKE 兜底时恒为 0 */
  score: number;
}

export class EventStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);

    // 建表 + 回填一次性焊死在一个事务里：不然崩在"表建完、回填还没跑"那道缝上，
    // 下次开库会看见 events_fts 已存在（= 判定"已回填"，见 rebuildFts 之上的注释），
    // 索引从此永久空着、永远不会被自愈。CREATE VIRTUAL TABLE / CREATE TRIGGER 在
    // SQLite 里本身就是事务性 DDL，better-sqlite3 的 transaction() 支持嵌套（内部转
    // SAVEPOINT），rebuildFts() 自己那层事务原样嵌进来
    this.db.transaction(() => {
      const hadFts = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events_fts'")
        .get();
      this.db.exec(FTS_SCHEMA);
      if (!hadFts) this.rebuildFts(); // 老库第一次开：一次性回填
    })();
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

  /** 物理抹除整个会话（被遗忘权）。
      与 append-only 不矛盾：trigger 挡的是"改写历史"（UPDATE / 删日志的一部分），
      而 purge 是"整段历史被完整遗忘"——要么全在、要么全无，不存在被篡改的中间态。
      实现上事务内临时卸下 no_delete trigger，删完装回：
      单连接同步库（better-sqlite3），事务里不会有并发写者穿过这扇临时开的门。

      **级联删它派出去的子会话**（ADR-0047）：子会话不进侧栏、不进 ⌘K，只能从父
      时间线上那张卡点进去——父日志一没，它就是谁也够不着、谁也删不掉的孤儿，
      而它的 token 账还在 billedUsage 里继续算。删除按 ADR-0002 是"整会话物理
      抹除，不可逆"，用户以为抹掉的那段记录（子会话里存着同一个 workspace 的
      文件内容和 bash 输出）却留在库里，这既是承诺没兑现，也是隐私漏洞。
      不递归：子 agent 不能再派子 agent（ADR-0047 决定 5），一层到底。

      @returns 真正被抹掉的 sessionId（含自己）——调用方据此把终端/浏览器/
               agent 注册表里对应的活资源一并注销 */
  purge(sessionId: string): string[] {
    const children = (
      this.db
        .prepare(
          `SELECT session_id FROM events
            WHERE seq = 0 AND type = 'session_created'
              AND json_extract(payload, '$.spawnedBy.sessionId') = ?`
        )
        .all(sessionId) as { session_id: string }[]
    ).map((r) => r.session_id);
    const ids = [sessionId, ...children];
    this.db.transaction((all: string[]) => {
      this.db.exec("DROP TRIGGER events_no_delete");
      const del = this.db.prepare("DELETE FROM events WHERE session_id = ?");
      const delFts = this.db.prepare("DELETE FROM events_fts WHERE session_id = ?");
      for (const id of all) {
        del.run(id);
        delFts.run(id);
      }
      this.db.exec(`CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events log is append-only'); END;`);
    })(ids);
    return ids;
  }

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
    // LIKE 兜底：`f.text LIKE ?` 没有索引可用（trigram 索引最短 3 字符，<3
    // 字符的查询够不到它），这条查询是对 events_fts.text 的全表扫描。v1 能接受
    // 是因为触发这条路径的只有 1~2 字符的查询——真出现在生产库上大概率是
    // 输入还没打完；真要给短查询也走索引，得换成 bigram/单字符 tokenizer 或
    // 前缀索引，目前没这个必要
    return this.db
      .prepare(
        `SELECT f.session_id AS sessionId, f.seq, f.type, f.text, 0 AS score
           FROM events_fts f WHERE f.text LIKE ? ESCAPE '\\' ${common}
          ORDER BY f.session_id, f.seq LIMIT ?`
      )
      .all(`%${likeEscape(q)}%`, ...exclude, limit) as FtsHit[];
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
    const rows = this.db
      .prepare(
        `SELECT session_id AS sessionId,
                COUNT(*)   AS events,
                MIN(ts)    AS startedTs,
                MAX(ts)    AS lastTs,
                (SELECT json_extract(payload, '$.workspace')
                   FROM events e0
                  WHERE e0.session_id = e.session_id AND e0.seq = 0) AS workspace,
                (SELECT json_extract(payload, '$.content')
                   FROM events e1
                  WHERE e1.session_id = e.session_id AND e1.type = 'user_message'
                  ORDER BY e1.seq LIMIT 1) AS title,
                (SELECT json_extract(payload, '$.title')
                   FROM events e2
                  WHERE e2.session_id = e.session_id AND e2.type = 'session_renamed'
                  ORDER BY e2.seq DESC LIMIT 1) AS renamed,
                (SELECT json_extract(payload, '$.spawnedBy.sessionId')
                   FROM events e3
                  WHERE e3.session_id = e.session_id AND e3.seq = 0) AS spawnedFrom
           FROM events e
          WHERE session_id NOT IN
                (SELECT DISTINCT session_id FROM events WHERE type = 'session_archived')
          GROUP BY session_id
          ORDER BY lastTs DESC`
      )
      .all() as (SessionSummary & { renamed: string | null })[];
    // 手动改名（最后一条胜出）压过自动标题；自动标题只取首行；
    // 空白一律算没有（显示截断交给 UI 的 ellipsis）
    return rows.map(({ renamed, ...r }) => ({
      ...r,
      title: renamed?.trim() || r.title?.split("\n")[0]?.trim() || null,
    }));
  }

  /**
   * 全库的计费行（设置页那张「哪家烧了多少」的图）。
   *
   * 在 SQL 层就投影成四个数，而不是 load() 出整库事件再过一遍：一台用了几个月的
   * 机器，日志里绝大多数字节是工具输出，为了几个 token 数把它们全读进内存不划算。
   * "哪些事件算账"这条规则不在这里 —— 类型清单从 deriveUsage.ts 导入（唯一事实源），
   * 这里只负责按它筛行。usage 缺省的行直接不出现（同 deriveUsage：没记 ≠ 没花）。
   *
   * 归档的会话**照样算**：archive 是"从会话列表里消失"，不是"这笔钱没花过"。
   * （purge 例外——那是日志本身被完整遗忘，账自然也跟着没了。）
   *
   * @param since 只要这个时刻之后的（毫秒）。UI 只画一个窗口，更早的行不必过桥
   */
  billedUsage(since: number): BilledRow[] {
    const marks = BILLED_EVENT_TYPES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ts,
                json_extract(payload, '$.model')                  AS model,
                json_extract(payload, '$.usage.promptTokens')     AS promptTokens,
                json_extract(payload, '$.usage.completionTokens') AS completionTokens
           FROM events
          WHERE type IN (${marks})
            AND ts >= ?
            AND model IS NOT NULL
            AND promptTokens IS NOT NULL
            AND completionTokens IS NOT NULL
          ORDER BY ts`
      )
      .all(...BILLED_EVENT_TYPES, since) as BilledRow[];
    return rows;
  }

  /** 一批会话各自的 user_message 条数（"几轮对话"）。给 recent() 用：
      逐会话 load() 整段事件只为数一个类型，会话一多、日志一长就是不必要的 N+1；
      这里一条 SQL 一次性数完，session_id 不在 events 里的（未知会话）在结果 Map
      里直接不出现——调用方按需 `?? 0` */
  userTurnCounts(sessionIds: string[]): Map<string, number> {
    if (sessionIds.length === 0) return new Map();
    const marks = sessionIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS n
           FROM events
          WHERE type = 'user_message' AND session_id IN (${marks})
          GROUP BY session_id`
      )
      .all(...sessionIds) as { sessionId: string; n: number }[];
    return new Map(rows.map((r) => [r.sessionId, r.n]));
  }

  close(): void {
    this.db.close();
  }
}
