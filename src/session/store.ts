// EventStore — SQLite 持久化的 append-only 事件日志
// 不变量在数据库层强制：PRIMARY KEY 挡重复 seq，trigger 挡 UPDATE/DELETE

import Database from "better-sqlite3";
import type { SessionEvent } from "./events.js";
import { shouldPersist } from "./persistencePolicy.js";
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
  /** 用户归档（ADR-0087）：true = 收进「已归档」区，可恢复、仍可被跨会话召回。
      系统归档（reason 缺席或 "system"）根本不出现在返回值里。
      归档状态 = 最后一条 session_archived / session_unarchived 事件说了算 */
  archived: boolean;
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

-- 二级索引（纯派生，随时可 DROP 重建，不碰事件 schema 本身）：
-- 没有它们时 sessions() 的 session_archived 子查询、purge 的子会话查找、
-- billedUsage 的按类型筛行全是全表扫描——每次追加事件都要跑一遍 sessions()
-- 的路径上（灵动岛投影），长库里实测 31ms/次。
-- (session_id, type, seq) 服务"某会话里某类型的最后/全部若干条"；
-- (type, ts) 服务全库按类型 + 时间窗的账单/归档查询
CREATE INDEX IF NOT EXISTS events_session_type_seq ON events(session_id, type, seq);
CREATE INDEX IF NOT EXISTS events_type_ts ON events(type, ts);
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
  /** 预编译语句缓存（按 SQL 文本键控）。better-sqlite3 的 prepare() 没有内建缓存，
      每次调用都是一遍 sqlite3_prepare_v2——append 是全库最热的函数，不该每条事件
      重编译两条 SQL。schema 变更（purge 里临时卸 trigger）后的 reprepare 由
      better-sqlite3 自己透明处理，缓存不用管失效 */
  private stmts = new Map<string, Database.Statement>();

  private prep(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // WAL 的标准搭配：NORMAL 只在 checkpoint 时 fsync，不是每笔提交一次。
    // append() 每条事件一个事务，FULL 意味着每条事件一次 fsync——工具密集的
    // turn 一秒落好几条。丢失窗口仅限"操作系统级断电时最后几笔提交"（进程崩溃
    // 不丢），而日志层本来就设计了断尾自愈（deriveMessages 的 dangling 工具调用修复）
    this.db.pragma("synchronous = NORMAL");
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

  /** 追加一条事件，seq 由存储层分配，返回完整事件。
      唯一写入口在这用持久化策略把门（issue #339）：类型系统已经挡住了瞬态
      推送（它们不在 SessionEvent union 里），这道运行时闸防的是将来有人把
      瞬态类型加进 union 却在 persistencePolicy 里判成 transient——两处矛盾
      要在写入时炸出来，而不是静默落一条不该存在的日志 */
  append(event: NewSessionEvent): SessionEvent {
    if (!shouldPersist(event.type)) {
      throw new Error(`事件类型 ${event.type} 被持久化策略判为 transient，不允许进 append-only 日志`);
    }
    const insert = this.db.transaction((e: NewSessionEvent): SessionEvent => {
      const row = this.prep(
        "SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE session_id = ?"
      ).get(e.sessionId) as { next: number };

      // 信封拆列，其余进 payload JSON
      const { sessionId, ts, sandboxId, type, ...payload } = e;
      this.prep(
        "INSERT INTO events (session_id, seq, ts, type, sandbox_id, payload) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(sessionId, row.next, ts, type, sandboxId ?? null, JSON.stringify(payload));

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
    // fork 删除保护（issue #352）：有分支引用本会话 = 分支的历史前缀住在
    // 本会话的事件行里，删父等于把分支的记忆连根抽走——拒绝，让用户先删分支。
    // 刻意不做级联：分支在侧栏里是用户看得见的独立会话，静默连坐删除
    // 与"删除 = 用户明确要抹掉的那一段"的心智模型相悖（ADR-0002 语义是
    // 对单个会话的承诺，不是对一棵树的）
    const forks = (
      this.db
        .prepare(
          `SELECT session_id FROM events
            WHERE type = 'session_created'
              AND json_extract(payload, '$.forkedFrom.sessionId') = ?`
        )
        .all(sessionId) as { session_id: string }[]
    ).map((r) => r.session_id);
    if (forks.length > 0) {
      throw new Error(`会话有 ${forks.length} 个分支引用它（${forks.join("、")}），先删除分支才能删除本会话`);
    }
    const children = (
      this.db
        .prepare(
          `SELECT session_id FROM events
            WHERE type = 'session_created'
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
      中文双字词太常见不能不管）。永远排除归档会话与子会话。
      每个 session 只回分最高的一条（issue #190）：limit 若发生在按 session 去重之前，
      一个几百条命中的话痨会话能把其他会话挤出 discovery 的名额——GROUP BY 之后
      limit 数的是 session 数。SQLite 的 bare-column + MAX() 语义保证取到的
      seq/type/text 正是最高分那一行 */
  searchText(query: string, opts: { limit?: number; excludeSessions?: string[] } = {}): FtsHit[] {
    const q = query.trim();
    if (!q) return [];
    const limit = opts.limit ?? 300;
    const exclude = opts.excludeSessions ?? [];
    const notIn = exclude.length ? `AND f.session_id NOT IN (${exclude.map(() => "?").join(",")})` : "";
    // 归档与召回（ADR-0087 修订 ADR-0065 第 4 条）：用户归档（reason="user"）
    // 只是从列表收起，记忆不丢——照常可搜；系统归档（reason 缺席/"system"，
    // 即 sys-memory-edits 这类保留会话与 ADR-0087 之前的旧标记）仍永远排除。
    const common = `
      AND f.session_id NOT IN (
        SELECT a.session_id FROM events a
         WHERE a.type = 'session_archived'
           AND COALESCE(json_extract(a.payload, '$.reason'), 'system') = 'system'
           AND a.seq = (SELECT MAX(b.seq) FROM events b
                         WHERE b.session_id = a.session_id
                           AND b.type IN ('session_archived', 'session_unarchived')))
      AND f.session_id NOT IN (SELECT session_id FROM events WHERE type = 'session_created' AND json_extract(payload, '$.spawnedBy') IS NOT NULL)
      ${notIn}`;
    if ([...q].length >= 3) {
      // bm25() 函数出不了 FTS 查询语境（子查询外层就报 unable to use function
      // bm25），rank 隐藏列是同一个分数的列形态，能穿过子查询——内层逐行算分，
      // 外层按 session 取最高分那一行
      const rows = this.db
        .prepare(
          `SELECT sessionId, seq, type, text, MAX(score) AS score FROM (
             SELECT f.session_id AS sessionId, f.seq, f.type, f.text, -f.rank AS score
               FROM events_fts f WHERE events_fts MATCH ? ${common}
           ) GROUP BY sessionId ORDER BY score DESC LIMIT ?`
        )
        .all(ftsQuote(q), ...exclude, limit) as FtsHit[];
      return rows;
    }
    // LIKE 兜底：`f.text LIKE ?` 没有索引可用（trigram 索引最短 3 字符，<3
    // 字符的查询够不到它），这条查询是对 events_fts.text 的全表扫描。v1 能接受
    // 是因为触发这条路径的只有 1~2 字符的查询——真出现在生产库上大概率是
    // 输入还没打完；真要给短查询也走索引，得换成 bigram/单字符 tokenizer 或
    // 前缀索引，目前没这个必要。
    // LIKE 没有分数，MIN(seq) = 每个 session 里最早的那条命中（稳定可复现）
    return this.db
      .prepare(
        `SELECT f.session_id AS sessionId, MIN(f.seq) AS seq, f.type, f.text, 0 AS score
           FROM events_fts f WHERE f.text LIKE ? ESCAPE '\\' ${common}
          GROUP BY f.session_id ORDER BY f.session_id LIMIT ?`
      )
      .all(`%${likeEscape(q)}%`, ...exclude, limit) as FtsHit[];
  }

  /** fork 元数据：本会话是不是从别的会话分出来的（session_created.forkedFrom）。
      null = 普通会话。单条索引查询，链式 load 的每一跳都要问一次 */
  forkOrigin(sessionId: string): { sessionId: string; endSeq: number } | null {
    const row = this.prep(
      `SELECT json_extract(payload, '$.forkedFrom.sessionId') AS src,
              json_extract(payload, '$.forkedFrom.seq') AS endSeq
         FROM events WHERE session_id = ? AND type = 'session_created' LIMIT 1`
    ).get(sessionId) as { src: string | null; endSeq: number | null } | undefined;
    if (!row || row.src === null || row.endSeq === null) return null;
    return { sessionId: row.src, endSeq: row.endSeq };
  }

  /** 引用型零拷贝 fork（issue #352，codex ForkPersistence::Referenced 对照）：
      不复制父会话的事件行，只在新会话的 session_created 里存 (源会话, seq)
      位置引用（events.ts 早就预留了 forkedFrom 字段，schema 零改动）——读取（load）沿链取数，父子共享不可变前缀。

      seq 播种是关键一招：子会话首事件的 seq = endSeq + 1（不是 0），此后
      append 的 MAX(seq)+1 自然续上。链式视图因此**全局严格递增**——micro 的
      coversUpTo、engine 增量快照的 afterSeq、steer 的 turnId 全是 seq 语义，
      一个都不用翻译。

      边界语义：endSeq 必须指向一条 turn_ended（到某 turn 含收口为止）——源会话
      正在跑时最后的半截 turn 根本没有 turn_ended 可指，"不继承半截 turn"由此
      是结构保证，不靠中断标记。 */
  fork(sourceSessionId: string, endSeq: number, newSessionId: string, ts: number): SessionEvent {
    const boundary = this.prep(
      "SELECT type FROM events WHERE session_id = ? AND seq = ?"
    ).get(sourceSessionId, endSeq) as { type: string } | undefined;
    if (!boundary) throw new Error(`fork 点不存在：${sourceSessionId} 没有 seq=${endSeq} 的事件`);
    if (boundary.type !== "turn_ended") {
      throw new Error(`fork 点必须是 turn 收口（turn_ended），seq=${endSeq} 是 ${boundary.type}——不继承半截 turn`);
    }
    if (this.has(newSessionId)) throw new Error(`会话已存在：${newSessionId}`);
    const src = this.prep(
      `SELECT json_extract(payload, '$.title') AS title,
              json_extract(payload, '$.workspace') AS workspace
         FROM events WHERE session_id = ? AND type = 'session_created' LIMIT 1`
    ).get(sourceSessionId) as { title: string | null; workspace: string | null } | undefined;
    // 围栏必须一致：分支上的模型对工作目录的认知与父会话同源
    const payload = {
      title: `${src?.title ?? "会话"}（分支）`,
      ...(src?.workspace ? { workspace: src.workspace } : {}),
      forkedFrom: { sessionId: sourceSessionId, seq: endSeq },
    };
    this.prep(
      "INSERT INTO events (session_id, seq, ts, type, sandbox_id, payload) VALUES (?, ?, ?, 'session_created', NULL, ?)"
    ).run(newSessionId, endSeq + 1, ts, JSON.stringify(payload));
    return { sessionId: newSessionId, seq: endSeq + 1, ts, type: "session_created", ...payload } as SessionEvent;
  }

  /** 按 seq 顺序读出一个会话的全部事件。
      fork 链（issue #352）：本会话是分支时，先沿链读父会话 seq ≤ endSeq 的
      前缀（递归——父亲也可能是分支），再接自己的事件；前缀的 sessionId 改写成
      本会话（投影呈现"这是我的历史"，日志一个字节不动），seq 原样保留
      （播种保证全链严格递增）。afterSeq/untilSeq 自然穿透——seq 全链一把尺 */
  load(sessionId: string, opts: { afterSeq?: number; untilSeq?: number } = {}, depth = 0): SessionEvent[] {
    if (depth > 16) throw new Error("fork 链深度超限（>16）——日志疑似被外部改出了环");
    const origin = this.forkOrigin(sessionId);
    const own = this.loadRaw(sessionId, opts);
    if (!origin) return own;
    const parent = this.load(
      origin.sessionId,
      {
        ...(opts.afterSeq !== undefined ? { afterSeq: opts.afterSeq } : {}),
        untilSeq: Math.min(origin.endSeq, opts.untilSeq ?? Number.MAX_SAFE_INTEGER),
      },
      depth + 1
    );
    return [...parent.map((e) => ({ ...e, sessionId })), ...own];
  }

  /** 单会话裸读（不解 fork 链）——load 的原子步 */
  private loadRaw(sessionId: string, opts: { afterSeq?: number; untilSeq?: number } = {}): SessionEvent[] {
    // afterSeq = 只读这个 seq 之后的事件（issue #197）：微压缩写侧收口前的
    // 新鲜度检查只关心"开跑之后落了什么"，长会话不用全量重读。
    // untilSeq（含，issue #351）：有界重建取"某个 user turn 到 checkpoint"的
    // 连续段——上下界都给才是段，不然还是半个全量
    const rows = this.prep(
      "SELECT seq, ts, type, sandbox_id, payload FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq"
    ).all(sessionId, opts.afterSeq ?? -1, opts.untilSeq ?? Number.MAX_SAFE_INTEGER) as {
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

  /** 某会话某类型的最后一条（beforeSeq 给了 = 该 seq 之前最近的一条）。
      events_session_type_seq 索引直达，不整段扫（issue #351 反向扫描的原子步） */
  lastOfType(sessionId: string, type: SessionEvent["type"], opts: { beforeSeq?: number } = {}): SessionEvent | null {
    const row = this.prep(
      "SELECT seq, ts, type, sandbox_id, payload FROM events WHERE session_id = ? AND type = ? AND seq < ? ORDER BY seq DESC LIMIT 1"
    ).get(sessionId, type, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER) as
      | { seq: number; ts: number; type: string; sandbox_id: string | null; payload: string }
      | undefined;
    if (!row) return null;
    return {
      seq: row.seq, sessionId, ts: row.ts, type: row.type,
      ...(row.sandbox_id !== null ? { sandboxId: row.sandbox_id } : {}),
      ...JSON.parse(row.payload),
    } as SessionEvent;
  }

  /** 某会话某类型的全部事件（beforeSeq 给了 = 只取该 seq 之前的），seq 升序。
      走同一条索引；skill_invoked / memory_loaded 这类每会话只有个位数条 */
  ofType(sessionId: string, type: SessionEvent["type"], opts: { beforeSeq?: number } = {}): SessionEvent[] {
    const rows = this.prep(
      "SELECT seq, ts, type, sandbox_id, payload FROM events WHERE session_id = ? AND type = ? AND seq < ? ORDER BY seq"
    ).all(sessionId, type, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER) as
      { seq: number; ts: number; type: string; sandbox_id: string | null; payload: string }[];
    return rows.map((r) => ({
      seq: r.seq, sessionId, ts: r.ts, type: r.type,
      ...(r.sandbox_id !== null ? { sandboxId: r.sandbox_id } : {}),
      ...JSON.parse(r.payload),
    })) as SessionEvent[];
  }

  /** 列出库里所有会话（欢迎页会话列表 / CLI --list 用），新会话在前 */
  sessions(): SessionSummary[] {
    // workspace 藏在第 0 条事件（session_created）的 payload JSON 里，
    // 用 json_extract 在 SQL 层投影出来——又一个"从日志推导"的例子。
    // 旧日志可能没有 workspace 字段 → null（schema 向后兼容硬规则）。
    // 归档（ADR-0087）：状态 = 最后一条 archived/unarchived 事件说了算。
    // 系统归档（reason 缺席 = 旧事件，或 "system"）整个从返回值消失；
    // 用户归档（reason = "user"）照常返回、带 archived 标志，UI 分区呈现。
    const rows = this.prep(
      `SELECT session_id AS sessionId,
                COUNT(*)   AS events,
                MIN(ts)    AS startedTs,
                MAX(ts)    AS lastTs,
                (SELECT json_extract(payload, '$.workspace')
                   FROM events e0
                  WHERE e0.session_id = e.session_id AND e0.type = 'session_created') AS workspace,
                (SELECT json_extract(payload, '$.content')
                   FROM events e1
                  WHERE e1.session_id = e.session_id AND e1.type = 'user_message'
                  ORDER BY e1.seq LIMIT 1) AS title,
                (SELECT json_extract(payload, '$.title')
                   FROM events e2
                  WHERE e2.session_id = e.session_id AND e2.type = 'session_renamed'
                  ORDER BY e2.seq DESC LIMIT 1) AS renamed,
                (SELECT json_extract(payload, '$.title')
                   FROM events e4
                  WHERE e4.session_id = e.session_id AND e4.type = 'session_autotitled'
                  ORDER BY e4.seq DESC LIMIT 1) AS autotitled,
                (SELECT json_extract(payload, '$.spawnedBy.sessionId')
                   FROM events e3
                  WHERE e3.session_id = e.session_id AND e3.type = 'session_created') AS spawnedFrom,
                (SELECT CASE WHEN e5.type = 'session_archived'
                             THEN COALESCE(json_extract(e5.payload, '$.reason'), 'system')
                        END
                   FROM events e5
                  WHERE e5.session_id = e.session_id
                    AND e5.type IN ('session_archived', 'session_unarchived')
                  ORDER BY e5.seq DESC LIMIT 1) AS archivedReason
           FROM events e
          GROUP BY session_id
          HAVING archivedReason IS NULL OR archivedReason <> 'system'
          ORDER BY lastTs DESC`
      )
      .all() as (Omit<SessionSummary, "archived"> & {
        renamed: string | null; autotitled: string | null; archivedReason: string | null;
      })[];
    // 手动改名（最后一条胜出）压过模型浓缩标题（session_autotitled，issue #335），
    // 浓缩标题压过自动标题（第一条 user_message 首行）；
    // 空白一律算没有（显示截断交给 UI 的 ellipsis）
    return rows.map(({ renamed, autotitled, archivedReason, ...r }) => ({
      ...r,
      title: renamed?.trim() || autotitled?.trim() || r.title?.split("\n")[0]?.trim() || null,
      archived: archivedReason === "user", // system 归档已被 HAVING 滤掉,能到这的非空值只有 "user"
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
    const rows = this.prep(
      `SELECT ts,
                json_extract(payload, '$.model')                  AS model,
                json_extract(payload, '$.usage.promptTokens')     AS promptTokens,
                json_extract(payload, '$.usage.completionTokens') AS completionTokens,
                json_extract(payload, '$.usage.cachedTokens')     AS cachedTokens
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
    // prep 缓存按 SQL 文本键控——marks 随 sessionIds.length 变，缓存条数被
    // 实际出现过的会话数上限住，不会无界增长
    const marks = sessionIds.map(() => "?").join(", ");
    const rows = this.prep(
      `SELECT session_id AS sessionId, COUNT(*) AS n
           FROM events
          WHERE type = 'user_message' AND session_id IN (${marks})
          GROUP BY session_id`
      )
      .all(...sessionIds) as { sessionId: string; n: number }[];
    return new Map(rows.map((r) => [r.sessionId, r.n]));
  }

  /** 某会话里某类型最后一条的 seq；beforeSeq 给了就只看它之前（不含）。
      没有 = -1。events_session_type_seq 索引直接服务——turn 收口钩子
      （issue #279）用它算"该从哪儿开始读尾段"，别再全量 load */
  lastSeqOf(sessionId: string, type: SessionEvent["type"], beforeSeq?: number): number {
    const row = this.prep(
      "SELECT MAX(seq) AS s FROM events WHERE session_id = ? AND type = ? AND seq < ?"
    ).get(sessionId, type, beforeSeq ?? Number.MAX_SAFE_INTEGER) as { s: number | null };
    return row.s ?? -1;
  }

  /** 某会话里某类型在 afterSeq 之后（不含）有几条。memory nudge 的
      "距上次提醒过了几轮"从这条 COUNT 出，不用把整段日志读进内存数 */
  countType(sessionId: string, type: SessionEvent["type"], afterSeq = -1): number {
    const row = this.prep(
      "SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = ? AND seq > ?"
    ).get(sessionId, type, afterSeq) as { n: number };
    return row.n;
  }

  /** 某会话里某类型的全部事件（seq 升序）。适合天然稀疏的类型
      （section_classified 一个分区一条）——密集类型请走 load/window */
  eventsOfType(sessionId: string, type: SessionEvent["type"]): SessionEvent[] {
    const rows = this.prep(
      "SELECT seq, ts, type, sandbox_id, payload FROM events WHERE session_id = ? AND type = ? ORDER BY seq"
    ).all(sessionId, type) as {
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

  /** 会话存在吗（有任何事件 = 存在）。比 load().length 便宜一整个会话的 JSON.parse */
  has(sessionId: string): boolean {
    return this.prep("SELECT 1 AS one FROM events WHERE session_id = ? LIMIT 1").get(sessionId) !== undefined;
  }

  /** 单个会话的标题投影——和 sessions() 同一条规则（最后一条 session_renamed
      胜出，其次最后一条 session_autotitled，否则第一条 user_message 首行，
      否则 null）。discovery 只要标题时不必为它全量 load 整段日志 */
  titleOf(sessionId: string): string | null {
    const row = this.prep(
      `SELECT (SELECT json_extract(payload, '$.title') FROM events
                WHERE session_id = ? AND type = 'session_renamed'
                ORDER BY seq DESC LIMIT 1) AS renamed,
              (SELECT json_extract(payload, '$.title') FROM events
                WHERE session_id = ? AND type = 'session_autotitled'
                ORDER BY seq DESC LIMIT 1) AS autotitled,
              (SELECT json_extract(payload, '$.content') FROM events
                WHERE session_id = ? AND type = 'user_message'
                ORDER BY seq LIMIT 1) AS first`
    ).get(sessionId, sessionId, sessionId) as {
      renamed: string | null;
      autotitled: string | null;
      first: string | null;
    };
    return row.renamed?.trim() || row.autotitled?.trim() || row.first?.split("\n")[0]?.trim() || null;
  }

  /** 第一条 user_message 全文（会话自动命名的素材，issue #335）。
      单行 SQL 投影，不为一条消息 load 整段日志 */
  firstUserMessage(sessionId: string): string | null {
    const row = this.prep(
      `SELECT json_extract(payload, '$.content') AS content FROM events
        WHERE session_id = ? AND type = 'user_message' ORDER BY seq LIMIT 1`
    ).get(sessionId) as { content: string | null } | undefined;
    return row?.content ?? null;
  }

  /** 按 seq 闭区间读一小段事件（session_search 的 scroll 模式用）。
      原来走 load() 全量读整个会话再 filter 出 ±5 条——PK 索引本来就能直接
      服务这个区间查询，长会话不必为 11 条事件付整份 JSON.parse */
  window(sessionId: string, fromSeq: number, toSeq: number): SessionEvent[] {
    const rows = this.prep(
      "SELECT seq, ts, type, sandbox_id, payload FROM events WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq"
    ).all(sessionId, fromSeq, toSeq) as {
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

  close(): void {
    this.db.close();
  }
}
