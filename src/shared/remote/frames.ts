// 远程中继的线格式。照 islandBridge.ts 的 decodeCommand 同一套规矩：
// 逐字段类型检查，认不出来的整条丢弃——不是"剥掉不认识的字段然后放行"。
// 这个区别是安全性质：上行帧从公网来，剥字段等于替攻击者做了归一化。
//
// 纯文件：不许 import node builtin / electron（手机端也要跑这一份）。

import type { IslandFleet } from "../shellBridge.js";

/** 移动端时间线的一条消息（timeline 帧的元素，Task 之外由 trimForMobile 产出） */
export interface MobileMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** 被 trimForMobile 截断过 → UI 显示"在电脑上看全文" */
  truncated?: boolean;
}

/** 桌面 → 手机。
    注意这里**没有** hello：握手包（handshake.ts 的 HandshakeHello）是**明文**、
    走同一条线、在加密建立之前发的，和这里的加密帧是两种完全不同的东西。
    曾经有过一个同名的 DownFrame 变体，零个生产者，留下的只是"同一根线上两个 hello"
    这个给下一个读代码的人挖的坑，已删。 */
export type DownFrame =
  | { type: "fleet"; fleet: IslandFleet }
  | { type: "timeline"; sessionId: string; messages: MobileMessage[] }
  /** 保活。nginx 的 proxy_read_timeout 是 600s，心跳必须比它短得多。
      **生产者在 plan B**：真实现 SSE 传输那一层才会挂定时器发它。
      现在只有解码这一半，因为手机端从第一天起就要认得它。 */
  | { type: "ping"; ts: number };

/** 手机 → 桌面。恰好五个词，没有 focusSession，approve 没有 grant 档 */
export type UpFrame =
  | { type: "approve"; sessionId: string; callId: string }
  | { type: "deny"; sessionId: string; callId: string }
  | { type: "send"; sessionId: string; text: string }
  | { type: "watch"; sessionId: string }
  | { type: "unwatch"; sessionId: string };

export function encodeFrame(f: DownFrame | UpFrame): string {
  return JSON.stringify(f);
}

function parseObject(line: string): Record<string, unknown> | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  return o as Record<string, unknown>;
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

/** 认得的字段集合之外还有别的键 = 整条丢弃。
    这一条挡的是「approve 带 grant」这类：剥掉多余字段放行，等于替攻击者归一化 */
function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

export function decodeUpFrame(line: string): UpFrame | null {
  const o = parseObject(line);
  if (!o) return null;
  switch (o.type) {
    case "approve":
    case "deny":
      return exactKeys(o, ["type", "sessionId", "callId"]) && str(o.sessionId) && str(o.callId)
        ? { type: o.type, sessionId: o.sessionId, callId: o.callId }
        : null;
    case "send":
      return exactKeys(o, ["type", "sessionId", "text"]) && str(o.sessionId) && str(o.text)
        ? { type: "send", sessionId: o.sessionId, text: o.text }
        : null;
    case "watch":
    case "unwatch":
      return exactKeys(o, ["type", "sessionId"]) && str(o.sessionId)
        ? { type: o.type, sessionId: o.sessionId }
        : null;
    default:
      return null;
  }
}

export function decodeDownFrame(line: string): DownFrame | null {
  const o = parseObject(line);
  if (!o) return null;
  switch (o.type) {
    case "fleet":
      return o.fleet && typeof o.fleet === "object" && Array.isArray((o.fleet as IslandFleet).agents)
        ? { type: "fleet", fleet: o.fleet as IslandFleet }
        : null;
    case "timeline":
      return str(o.sessionId) && Array.isArray(o.messages)
        ? { type: "timeline", sessionId: o.sessionId, messages: o.messages as MobileMessage[] }
        : null;
    case "ping":
      return typeof o.ts === "number" ? { type: "ping", ts: o.ts } : null;
    default:
      return null;
  }
}
