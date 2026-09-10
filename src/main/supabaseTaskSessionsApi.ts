/** TaskSessionsApi 的真 supabase 实现（#1223）。薄到只有请求形状与错误码映射；同 supabaseMemoryDocsApi 的纪律。 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionEvent } from "../session/events.js";
import { TASK_SQLSTATE } from "../shared/taskSync.js";
import { TaskSyncError, type TaskSessionRow, type TaskSessionsApi, type TaskSyncErrorCode } from "./taskSessionsApi.js";

const BUCKET = "task-attachments";
const ROW_COLUMNS = "id,title,archived,last_seq,pen_holder,pen_until,updated_at";

/** 「这句错话是不是网络挂了」——`codeOf` 的 default 分支与 `guarded` 的 catch 共用一份判据：
    两处各写一条正则，改一处忘一处不报错，只会让同一次断网在两条路上得出两种结论 */
export function isNetworkMessage(msg: string): boolean {
  return /fetch failed|network|ECONN|ENOTFOUND|Failed to fetch/i.test(msg);
}

/** 22*（数据异常）与 23*（完整性约束）这两族没有专属分支：冻结那句话里要能看出到底是哪个码 */
const TERMINAL_SQLSTATE = /^(22|23)/;

export function codeOf(err: { code?: string; message: string }): TaskSyncErrorCode {
  switch (err.code) {
    case TASK_SQLSTATE.seq_conflict: return "seq_conflict";
    case TASK_SQLSTATE.pen_required: return "pen_required";
    case TASK_SQLSTATE.no_session: return "no_session";
    case TASK_SQLSTATE.forbidden:
    case "42501": return "forbidden";
    case "PGRST202":
    case "PGRST205":
    case "42883":
    case "42P01": return "missing_schema";
    // JWT 过期（#1223 终审 I4）：下一次调用 supabase-js 自己会刷 token，所以这是**瞬态**——
    // 判成 other 的话它进 30 s 重试循环也能好，但状态行会写成一句莫名其妙的失败
    case "PGRST301": return "network";
    default:
      // 22P05（NUL 字节进 jsonb）/ 22P02 / 23xxx：同一批再发一次结果一模一样，**终态**。
      // 原来一律落进 other → fail() → 每 30 s 重试一次、这条会话永远脏着，而没有任何人
      // 说得出为什么。走 forbidden = 既有的 freeze 那条路（message 带原 SQLSTATE）
      if (err.code !== undefined && TERMINAL_SQLSTATE.test(err.code)) return "forbidden";
      return isNetworkMessage(err.message) ? "network" : "other";
  }
}

/** 没有专属分支的那两族要把 SQLSTATE 带进消息：冻结的原因最终会原样出现在账号页那行 */
function messageOf(err: { code?: string; message: string }): string {
  return err.code !== undefined && TERMINAL_SQLSTATE.test(err.code) ? `${err.code}: ${err.message}` : err.message;
}

function unwrap<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new TaskSyncError(codeOf(res.error), messageOf(res.error));
  return res.data;
}

/** supabase-js 在 fetch 层挂掉时是 reject 不是 {error}：统一包成 network */
async function guarded<T>(p: () => Promise<T>): Promise<T> {
  try {
    return await p();
  } catch (err) {
    if (err instanceof TaskSyncError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new TaskSyncError(err instanceof TypeError || isNetworkMessage(msg) ? "network" : "other", msg);
  }
}

export function createSupabaseTaskSessionsApi(client: SupabaseClient): TaskSessionsApi {
  return {
    listChanged: (uid, sinceIso) =>
      guarded(async () => {
        const base = client.from("task_sessions").select(ROW_COLUMNS).eq("uid", uid);
        const res = sinceIso !== null
          ? await base.gt("updated_at", sinceIso).order("updated_at", { ascending: true })
          : await base.order("updated_at", { ascending: true });
        return (unwrap(res) ?? []) as TaskSessionRow[];
      }),
    getSession: (uid, sessionId) =>
      guarded(async () => {
        const rows = (unwrap(await client.from("task_sessions").select(ROW_COLUMNS).eq("uid", uid).eq("id", sessionId)) ?? []) as TaskSessionRow[];
        return rows[0] ?? null;
      }),
    pullEvents: (uid, sessionId, afterSeq, limit) =>
      guarded(async () => {
        const rows = (unwrap(
          await client.from("task_session_events").select("payload").eq("uid", uid).eq("session_id", sessionId).gt("seq", afterSeq).order("seq", { ascending: true }).limit(limit)
        ) ?? []) as { payload: SessionEvent }[];
        return rows.map((r) => r.payload);
      }),
    append: (sessionId, expectedSeq, holder, events) =>
      guarded(async () =>
        unwrap(await client.rpc("task_append", { p_session_id: sessionId, p_expected_seq: expectedSeq, p_holder: holder, p_events: events })) as number
      ),
    acquirePen: (sessionId, holder, ttlS) =>
      guarded(async () => {
        const rows = unwrap(await client.rpc("task_pen_acquire", { p_session_id: sessionId, p_holder: holder, p_ttl_s: ttlS })) as { ok: boolean; holder: string | null; until: string | null }[] | null;
        const r = rows?.[0];
        if (!r) throw new TaskSyncError("other", "task_pen_acquire 没有返回行");
        return { ok: r.ok, holder: r.holder, until: r.until ? Date.parse(r.until) : null };
      }),
    releasePen: (sessionId, holder) =>
      guarded(async () => {
        unwrap(await client.rpc("task_pen_release", { p_session_id: sessionId, p_holder: holder }));
      }),
    deleteSession: (uid, sessionId) =>
      guarded(async () => {
        unwrap(await client.from("task_sessions").delete().eq("uid", uid).eq("id", sessionId));
      }),
    uploadAttachment: (uid, hex, bytes) =>
      guarded(async () => {
        unwrap(await client.storage.from(BUCKET).upload(`${uid}/${hex}`, bytes, { upsert: true, contentType: "application/octet-stream" }));
      }),
    downloadAttachment: (uid, hex) =>
      guarded(async () => {
        const res = await client.storage.from(BUCKET).download(`${uid}/${hex}`);
        if (res.error) {
          if (/not found|404/i.test(res.error.message)) return null;
          throw new TaskSyncError(codeOf(res.error), messageOf(res.error));
        }
        return new Uint8Array(await res.data.arrayBuffer());
      }),
    subscribe(uid, onRow) {
      // 同 workspace-mentions 那条通道的纪律：状态不并进好友健康度；哑掉不无声——打一行 warn，
      // 60 s sweep 是兜底不是主路（spec §3.6）
      const channel = client
        .channel(`task-sessions-${uid}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "task_sessions", filter: `uid=eq.${uid}` }, (p) => onRow(p.new as TaskSessionRow))
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "task_sessions", filter: `uid=eq.${uid}` }, (p) => onRow(p.new as TaskSessionRow))
        .subscribe((st) => {
          if (st === "SUBSCRIBED" || st === "CLOSED") return;
          console.warn(`[otto] 任务会话 realtime 订阅状态：${st}（改靠 60s sweep）`);
        });
      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}
