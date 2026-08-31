// cs（cloud session）帧协议——工作区云会话的线上约定（ADR-0199）。
// 与 wire.ts 同纪律：多端共用一份，只有类型 + 纯函数。
// 帧走 relay 的 payload 通道（cid 定向），内容是 base64url(JSON)。
// 事件只发给已过 hello 验籍的 cid——房名可猜，所以不存在房间级广播。

import type { SessionEvent } from "../../session/events.js";
import { b64decode, b64encode } from "./b64.js";
import { MAX_FRAME_BYTES } from "./wire.js";

export const CS_PROTOCOL_VERSION = 1;
export const CS_MAX_TEXT_BYTES = 64 * 1024;

export function csCtlChannel(): string {
  return "cs-ctl";
}

export function csChannel(workspaceId: string, sessionId: string): string {
  return `cs-${workspaceId}-${sessionId}`;
}

/** 标准 UUID 的十六进制形状（8-4-4-4-12，全小写——workspaceId 来自 Supabase
    的 `gen_random_uuid()`，sessionId 来自 Node 的 `crypto.randomUUID()`，
    两者的规范文本形式都是小写）。 */
const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CS_SESSION_CHANNEL_RE = new RegExp(`^cs-${UUID_SEGMENT}-${UUID_SEGMENT}$`);

/** 精确判定「这是不是一条 cs 房间名」——不是「以 `cs-` 开头」（终审复审
    R1）。用于 edge.ts 的角色收口（role=host 只认平台身份）：好友代理的
    channelId 是 `b64encode(randomBytes(32))`（proxyInvite.ts），base64url
    字母表含 `-`（b64.ts），约 1/262144 的邀请码会生成 `cs-` 开头的房名——
    收口判据若只看前缀，撞上时代理房间里真人的 host 会被误降级成
    guest，A/B 双方都变 guest 后 relay.ts 的 `peersOf`/`otherRole` 只配对
    异角色，永远配不上、也没有任何报错（正是 relay.ts 文件头警告的那种
    失败形态）。精确匹配 `cs-ctl` 或 `cs-<uuid>-<uuid>`——要求精确长度 +
    十六进制字母表 + 固定短横线位置，随机 base64url 串撞不上；`Cs-`/
    `xcs-` 这类变体本来就落进空房间，不受影响。
    房名的构造（上面两个函数）与识别（这个函数）刻意放在同一处、同源于
    这份协议文件——分了家迟早会漂。 */
export function isCsChannel(channel: string): boolean {
  return channel === csCtlChannel() || CS_SESSION_CHANNEL_RE.test(channel);
}

export type CsDeniedCode =
  | "bad_jwt"
  | "not_member"
  | "version_mismatch"
  | "not_authorized"
  | "no_session";

/** 成员 → runtime */
export type CsUp =
  | { t: "hello"; v: number; jwt: string }
  | { t: "create"; workspaceId: string }
  | { t: "say"; text: string; mention: boolean }
  | { t: "backlog"; afterSeq: number }
  | { t: "approve"; callId: string; decision: "approved" | "denied" }
  | { t: "config"; repoUrl: string; pat?: string }
  | { t: "archive" };

/** runtime → 成员 */
export type CsDown =
  | {
      t: "welcome";
      v: number;
      sessionId: string;
      lastSeq: number;
      initiatorUid: string | null;
      ownerUid: string;
    }
  | { t: "created"; workspaceId: string; sessionId: string; channel: string }
  | { t: "denied"; code: CsDeniedCode }
  | { t: "event"; event: SessionEvent }
  | { t: "backlog"; events: SessionEvent[]; done: boolean }
  | { t: "error"; msg: string };

export function encodeCs(msg: CsUp | CsDown): string {
  // Check size limit for say.text
  if (msg.t === "say" && msg.text.length > 0) {
    const textBytes = new TextEncoder().encode(msg.text).byteLength;
    if (textBytes > CS_MAX_TEXT_BYTES) {
      throw new Error(
        `say.text exceeds ${CS_MAX_TEXT_BYTES} bytes: ${textBytes}`
      );
    }
  }

  const json = JSON.stringify(msg);
  const utf8 = new TextEncoder().encode(json);
  const encoded = b64encode(utf8);

  // Check entire frame size limit
  const frameBytes = new TextEncoder().encode(encoded).byteLength;
  if (frameBytes > MAX_FRAME_BYTES) {
    throw new Error(
      `cs frame exceeds ${MAX_FRAME_BYTES} bytes: ${frameBytes}`
    );
  }

  return encoded;
}

function isValidCsDeniedCode(v: unknown): v is CsDeniedCode {
  return (
    v === "bad_jwt" ||
    v === "not_member" ||
    v === "version_mismatch" ||
    v === "not_authorized" ||
    v === "no_session"
  );
}

function isSessionEvent(v: unknown): v is SessionEvent {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  // 浅校验 SessionEventBase 的三个必填字段。
  // 逐子类型的形状验证属于 EventStore 落盘侧的责任，
  // 这层是线上防呆，只验 base 字段。
  return (
    typeof obj.type === "string" &&
    typeof obj.seq === "number" &&
    typeof obj.sessionId === "string" &&
    typeof obj.ts === "number"
  );
}

export function decodeCsUp(b64: string): CsUp | null {
  try {
    const bytes = b64decode(b64);
    if (!bytes) return null;

    const json = new TextDecoder().decode(bytes);
    const msg = JSON.parse(json) as unknown;

    if (typeof msg !== "object" || msg === null) return null;
    const obj = msg as Record<string, unknown>;

    const t = obj.t;

    if (t === "hello") {
      if (
        typeof obj.v === "number" &&
        typeof obj.jwt === "string"
      ) {
        return { t: "hello", v: obj.v, jwt: obj.jwt };
      }
      return null;
    }

    if (t === "create") {
      if (typeof obj.workspaceId === "string") {
        return { t: "create", workspaceId: obj.workspaceId };
      }
      return null;
    }

    if (t === "say") {
      if (typeof obj.text === "string" && typeof obj.mention === "boolean") {
        return { t: "say", text: obj.text, mention: obj.mention };
      }
      return null;
    }

    if (t === "backlog") {
      if (typeof obj.afterSeq === "number") {
        return { t: "backlog", afterSeq: obj.afterSeq };
      }
      return null;
    }

    if (t === "approve") {
      if (
        typeof obj.callId === "string" &&
        (obj.decision === "approved" || obj.decision === "denied")
      ) {
        return { t: "approve", callId: obj.callId, decision: obj.decision };
      }
      return null;
    }

    if (t === "config") {
      if (typeof obj.repoUrl === "string") {
        const pat = obj.pat;
        if (pat === undefined || typeof pat === "string") {
          const result: CsUp = { t: "config", repoUrl: obj.repoUrl };
          if (typeof pat === "string") {
            result.pat = pat;
          }
          return result;
        }
      }
      return null;
    }

    if (t === "archive") {
      return { t: "archive" };
    }

    return null;
  } catch {
    return null;
  }
}

export function decodeCsDown(b64: string): CsDown | null {
  try {
    const bytes = b64decode(b64);
    if (!bytes) return null;

    const json = new TextDecoder().decode(bytes);
    const msg = JSON.parse(json) as unknown;

    if (typeof msg !== "object" || msg === null) return null;
    const obj = msg as Record<string, unknown>;

    const t = obj.t;

    if (t === "welcome") {
      if (
        typeof obj.v === "number" &&
        typeof obj.sessionId === "string" &&
        typeof obj.lastSeq === "number" &&
        (obj.initiatorUid === null || typeof obj.initiatorUid === "string") &&
        typeof obj.ownerUid === "string"
      ) {
        return {
          t: "welcome",
          v: obj.v,
          sessionId: obj.sessionId,
          lastSeq: obj.lastSeq,
          initiatorUid: obj.initiatorUid as string | null,
          ownerUid: obj.ownerUid,
        };
      }
      return null;
    }

    if (t === "created") {
      if (
        typeof obj.workspaceId === "string" &&
        typeof obj.sessionId === "string" &&
        typeof obj.channel === "string"
      ) {
        return {
          t: "created",
          workspaceId: obj.workspaceId,
          sessionId: obj.sessionId,
          channel: obj.channel,
        };
      }
      return null;
    }

    if (t === "denied") {
      if (isValidCsDeniedCode(obj.code)) {
        return { t: "denied", code: obj.code };
      }
      return null;
    }

    if (t === "event") {
      if (isSessionEvent(obj.event)) {
        return { t: "event", event: obj.event };
      }
      return null;
    }

    if (t === "backlog") {
      if (
        Array.isArray(obj.events) &&
        typeof obj.done === "boolean"
      ) {
        // Validate each event
        if (!obj.events.every(isSessionEvent)) {
          return null;
        }
        return {
          t: "backlog",
          events: obj.events as SessionEvent[],
          done: obj.done,
        };
      }
      return null;
    }

    if (t === "error") {
      if (typeof obj.msg === "string") {
        return { t: "error", msg: obj.msg };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}
