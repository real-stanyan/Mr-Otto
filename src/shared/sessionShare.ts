// sessionShare — 跨账号会话快照共享的纯逻辑（导出 / 导入）。
// 白名单 + 字段级剥离规则见 docs/adr/0147。纯文件：不 import node builtin / electron，
// 手机端（将来）或测试可 import 同一份源码，同 friendsQuery.ts 的先例。

import type {
  SessionEvent,
  ToolCallRequest,
  UserTextFile,
} from "../session/events.js";

export const SHARE_PAYLOAD_VERSION = 1 as const;
/** 保守体积上限：PostgREST request body 默认 2MB，留一半余量。超限拒绝，不静默截断 */
export const MAX_SHARE_PAYLOAD_BYTES = 1_000_000;

// ─── 剥离后的事件形状（seq 保留作 coversUpTo 翻译的锚，sessionId 由接收端重写）───
//
// 与 SessionEvent 的差别就是「字段级剥离」的结果：reasoning/usage/diffStat/images/
// attachments 这些本机引用或审计字段被摘掉；session_created 根本不导出（接收端按
// 自己的工作区重建，workspace 路径是源用户的隐私，见 ADR-0147）。

export type ShareEvent =
  | {
      type: "user_message";
      seq: number;
      ts: number;
      content: string;
      textFiles?: UserTextFile[];
      origin?: "background";
      backgroundTaskIds?: string[];
    }
  | {
      type: "assistant_message";
      seq: number;
      ts: number;
      content: string;
      model: string;
      toolCalls?: ToolCallRequest[];
    }
  | {
      type: "tool_result";
      seq: number;
      ts: number;
      toolCallId: string;
      status: "ok" | "error" | "denied";
      output: string;
    }
  | { type: "tool_execution_started"; seq: number; ts: number; toolCallId: string }
  | {
      type: "turn_ended";
      seq: number;
      ts: number;
      outcome: "completed" | "error" | "aborted" | "interrupted";
      error?: string;
      errorClass?: "rate-limit" | "retryable" | "fatal";
    }
  | {
      type: "skill_invoked";
      seq: number;
      ts: number;
      name: string;
      content: string;
      args?: string;
      source?: "user" | "model";
    }
  | { type: "skill_released"; seq: number; ts: number; name: string }
  | { type: "image_described"; seq: number; ts: number; content: string; model: string }
  | {
      type: "context_compacted";
      seq: number;
      ts: number;
      summary: string;
      model: string;
      trigger?: "auto" | "manual";
    }
  | {
      type: "micro_compacted";
      seq: number;
      ts: number;
      summary: string;
      coversUpTo: number;
      model: string;
    }
  | {
      type: "tool_hook";
      seq: number;
      ts: number;
      toolCallId: string;
      hook: string;
      phase: "pre" | "post";
      action: "feedback";
      message: string;
    };

/**
 * 单条事件的导出：白名单事件 → 剥离后的 ShareEvent；其余 → null。
 * switch 穷尽 SessionEvent 的所有 type，不落兜底分支——新增事件类型时 tsc 强制
 * 在这里表态（和 persistencePolicy 同一手法）：是剥离还是保留，都得显式写出来。
 */
export function exportShareEvent(event: SessionEvent): ShareEvent | null {
  switch (event.type) {
    // session_created 不导出：workspace 是源用户本机路径（隐私），forkedFrom/spawnedBy
    // 是同库链语义，接收端全部重建（ADR-0147）
    case "session_created":
      return null;

    case "user_message": {
      // attachments 是图片 ref（sha256:<hex>），指向源用户本机附件库，跨机死链。
      // textFiles 是全文快照、自包含，保留
      const { attachments: _attachments, sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "assistant_message": {
      // reasoning（模型思考）和 usage（token 账单）是审计/隐私，不进模型视野
      const { reasoning: _r, usage: _u, sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "tool_result": {
      // diffStat 是写盘行数账（给人看的统计），images 是本机附件 ref
      const { diffStat: _d, images: _i, sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "tool_execution_started": {
      const { sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "turn_ended": {
      // 空跑判定（barrenEventIndexes）依赖它；error/errorClass 保留（重放/诊断）
      const { sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "skill_invoked":
    case "skill_released": {
      const { sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "image_described": {
      const { sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "context_compacted": {
      const { usage: _u, sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "micro_compacted": {
      // coversUpTo 是 seq 语义——导入时 seq 重映射，翻译在 importShareEvents 里做
      const { usage: _u, sessionId: _sid, ...keep } = event;
      return keep;
    }

    case "tool_hook": {
      // 只有 post+feedback 进模型视野（feedbackByCall 包装 tool_result）；
      // block/revise_args/reject/guard_deny 的模型可见面已在配对的 tool_result 里，
      // 钩子事件本身是审计凭据，跨机不传。feedback 一定有 message（deriveMessages
      // 收集 feedbackByCall 时 `message === undefined` 的会跳过）
      if (event.action !== "feedback" || event.message === undefined) return null;
      const { action: _a, revisedArgs: _r, originalOutput: _o, sessionId: _sid, ...keep } = event;
      return { ...keep, action: "feedback" as const, message: event.message };
    }

    // 模型不可见 / 本机引用 / 审计 / 隐私 / 跨机无意义 —— 全部剥离（ADR-0147）
    case "approval_decision":
    case "model_changed":
    case "session_archived":
    case "session_unarchived":
    case "session_renamed":
    case "section_classified":
    case "suggestions_generated":
    case "subagent_spawned":
    case "subagent_briefed":
    case "memory_loaded":
    case "memory_user_edit":
    case "memory_nudge":
    case "session_autotitled":
    case "project_instructions":
    case "request_envelope":
    case "background_task_completed":
    case "background_task_started":
    case "checkpoint_created":
    case "workspace_restored":
    case "branch_checked_out":
      return null;
  }
}

/** 整段日志导出成可跨机的 ShareEvent 序列（保持 seq 升序，数组序即投影序） */
export function exportShareEvents(events: readonly SessionEvent[]): ShareEvent[] {
  const out: ShareEvent[] = [];
  for (const e of events) {
    const share = exportShareEvent(e);
    if (share) out.push(share);
  }
  return out;
}

export interface SessionSharePayload {
  version: typeof SHARE_PAYLOAD_VERSION;
  sourceSessionId: string;
  events: ShareEvent[];
}

/** 组装 payload（发送侧）。纯拼装，不碰体积判断——体积由调用方在 JSON.stringify 后量 */
export function buildSharePayload(sourceSessionId: string, events: readonly SessionEvent[]): SessionSharePayload {
  return {
    version: SHARE_PAYLOAD_VERSION,
    sourceSessionId,
    events: exportShareEvents(events),
  };
}

// ─── 导入（接收侧）───

/** SessionEvent 去掉 seq——store.append 的入参形状（store.ts 同款 DistributiveOmit，
    shared 层不能 import store.ts，故在此重复定义同一结构，两侧靠结构类型对齐） */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewSessionEvent = DistributiveOmit<SessionEvent, "seq">;

/**
 * 把 ShareEvent 序列还原成可 append 的事件：sessionId 重写为新会话 id，seq 去掉
 * （由存储层分配），micro_compacted.coversUpTo 从「原 seq」翻译到「新 seq」。
 *
 * coversUpTo 为什么必须翻译：absorbedIndexes 用 `e.seq > latest.coversUpTo` 划吸收
 * 边界，而 seq 是日志里的稳定身份。跨机导入后 seq 重新编号，不翻译的话那条边界
 * 会指向一个不存在的位置，微压缩投影整个错乱。翻译锚点是「原 seq → 新 seq」的
 * 一一映射——coversUpTo 只可能落在 assistant_message/tool_result/turn_ended 上
 * （microCompact.ts 的 end 停在三个真内容类型上），三者都在白名单里，映射必命中；
 * 真命不中 = payload 被外部改坏了，宁可抛错也不静默投出残缺上下文。
 */
export function importShareEvents(
  exported: readonly ShareEvent[],
  newSessionId: string
): NewSessionEvent[] {
  const seqMap = new Map<number, number>();
  const out: NewSessionEvent[] = [];
  let nextSeq = 0;
  for (const e of exported) {
    seqMap.set(e.seq, nextSeq);
    const { seq: _seq, ...rest } = e;
    out.push({ ...rest, sessionId: newSessionId } as NewSessionEvent);
    nextSeq++;
  }
  // 第二遍翻译 micro coversUpTo（依赖完整的 seqMap，不能在第一遍里顺手做）
  for (const evt of out) {
    if (evt.type !== "micro_compacted") continue;
    const mapped = seqMap.get(evt.coversUpTo);
    if (mapped === undefined) {
      throw new Error(
        `sessionShare: micro_compacted.coversUpTo=${evt.coversUpTo} 不在导出事件里，` +
          `payload 疑似被外部改坏，拒绝导入`
      );
    }
    evt.coversUpTo = mapped;
  }
  return out;
}

/** session_shares 表一行的渲染层形态（snake_case 列名在主进程归一成 camelCase，
    同 friends.ts 的 FriendProfile）。payload 结构见 SessionSharePayload */
export interface SessionShareRecord {
  id: string;
  sender: string;
  recipient: string;
  title: string;
  /** 那句交代（分享者留的话） */
  message: string;
  payload: SessionSharePayload;
  status: "pending" | "accepted" | "declined";
  /** ISO 8601（supabase timestamptz 原样传） */
  createdAt: string;
}
