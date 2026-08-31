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
  return b64encode(utf8);
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
  return typeof obj.type === "string";
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
