/** 任务会话云端日志的 API 口（#1223）。taskSessionSync 与测试通过它调 Supabase；真实现在
    supabaseTaskSessionsApi.ts。错误统一成 TaskSyncError：调用方按 code 分支（seq_conflict 进冲突流程、
    pen_required 重拿笔、no_session 标 detached、network/missing_schema 当离线），不按文案 */
import type { SessionEvent } from "../session/events.js";

export interface TaskSessionRow {
  id: string;
  title: string;
  archived: boolean;
  last_seq: number;
  pen_holder: string | null;
  pen_until: string | null;
  updated_at: string;
}

export type TaskSyncErrorCode =
  | "seq_conflict" // P0010：expected_seq 不等于 last_seq+1
  | "pen_required" // P0011：executor 类事件而笔不在我手上
  | "no_session" // P0013：expected_seq > 0 但行不存在（别的设备删了）
  | "forbidden" // P0012 / 42501：不是我的会话、形状非法
  | "missing_schema" // PGRST202 / 42883 / 42P01 / PGRST205：0036 还没在真库跑
  | "network" // fetch 失败
  | "other";

export class TaskSyncError extends Error {
  constructor(public readonly code: TaskSyncErrorCode, message: string) {
    super(message);
    this.name = "TaskSyncError";
  }
}

export interface TaskSessionsApi {
  listChanged(uid: string, sinceIso: string | null): Promise<TaskSessionRow[]>;
  getSession(uid: string, sessionId: string): Promise<TaskSessionRow | null>;
  pullEvents(uid: string, sessionId: string, afterSeq: number, limit: number): Promise<SessionEvent[]>;
  append(sessionId: string, expectedSeq: number, holder: string, events: readonly SessionEvent[]): Promise<number>;
  acquirePen(sessionId: string, holder: string, ttlS: number): Promise<{ ok: boolean; holder: string | null; until: number | null }>;
  releasePen(sessionId: string, holder: string): Promise<void>;
  deleteSession(uid: string, sessionId: string): Promise<void>;
  uploadAttachment(uid: string, hex: string, bytes: Uint8Array): Promise<void>;
  downloadAttachment(uid: string, hex: string): Promise<Uint8Array | null>;
  /** realtime：task_sessions 上属于我的 INSERT/UPDATE 行原样回调；返回退订函数 */
  subscribe(uid: string, onRow: (row: TaskSessionRow) => void): () => void;
}
