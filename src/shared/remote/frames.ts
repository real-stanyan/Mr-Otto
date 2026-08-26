// 远程中继的线格式。照 islandBridge.ts 的 decodeCommand 同一套规矩：
// 逐字段类型检查，认不出来的整条丢弃——不是"剥掉不认识的字段然后放行"。
// 这个区别是安全性质：上行帧从公网来，剥字段等于替攻击者做了归一化。
//
// 纯文件：不许 import node builtin / electron（手机端也要跑这一份）。

import type { IslandFleet } from "../shellBridge.js";
import type { ModelUsageRow, RemoteStats } from "./stats.js";

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
  | { type: "ping"; ts: number }
  /** 设置页那两块:会话热力图 + 各模型用量。**只在手机开口问的时候发一次**,
      不跟着 fleet 走 —— 理由见 stats.ts 开头 */
  | { type: "stats"; stats: RemoteStats }
  /** 一句给人看的话,不进日志、不影响状态。**存在的理由是"静默丢弃"**:
      手机传上来的附件由桌面那道闸门(attachmentIntake)分类,认不出的会被拒收,
      而拒收如果不回话,在手机上和"传成功了"长得一模一样 */
  | { type: "notice"; text: string };

/** 手机 → 桌面。没有 focusSession，approve 没有 grant 档 */
export type UpFrame =
  | { type: "approve"; sessionId: string; callId: string }
  | { type: "deny"; sessionId: string; callId: string }
  /** uploads = 这条消息带的附件,值是先前 upload 帧里的 uploadId。
      **附件和文字必须同一条帧发**:分两条的话中间断线就会留下一半 */
  | { type: "send"; sessionId: string; text: string; uploads?: string[] }
  /** 一个附件的一片。中继单帧上限 256 KiB(gateway.ts 的 MAX_UPLINK_BYTES),
      而随手一张照片是几 MB —— 分片不是优化,是能不能传的问题。
      顺序和防重放由密封流保证(sealedStream 的严格递增计数器),所以这里
      只带 seq 让接收侧断言"正好是下一片",不需要自己做窗口 */
  | { type: "upload"; uploadId: string; seq: number; total: number; name: string; data: string }
  | { type: "watch"; sessionId: string }
  | { type: "unwatch"; sessionId: string }
  /** 要一份设置页的统计。**拉取,不订阅**:人翻到那一屏才问一次 */
  | { type: "stats" };

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

/** 非负整数。**必须挡住小数和 NaN**:seq 用来当数组下标和"下一片"的判据,
    一个 1.5 或 NaN 能让重组器的状态永远对不上而不报错 */
function nat(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function strArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(str);
}

/** 认得的字段集合之外还有别的键 = 整条丢弃。
    这一条挡的是「approve 带 grant」这类：剥掉多余字段放行，等于替攻击者归一化 */
function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** exactKeys 的"有可选字段"版:必填的都在,而且没有白名单之外的键。
    **不能拿 exactKeys 代替**——它要求键集完全相等,一个缺席的可选字段就会
    让整条合法帧被丢掉(timeline 的 truncated 就踩过:大多数消息没有这个键,
    整条时间线于是在手机上永远加载不出来)。 */
function keysWithin(o: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const own = Object.keys(o);
  if (!required.every((k) => own.includes(k))) return false;
  return own.every((k) => required.includes(k) || optional.includes(k));
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
    case "send": {
      if (!keysWithin(o, ["type", "sessionId", "text"], ["uploads"])) return null;
      if (!str(o.sessionId) || !str(o.text)) return null;
      if (o.uploads !== undefined && !strArray(o.uploads)) return null;
      return o.uploads === undefined
        ? { type: "send", sessionId: o.sessionId, text: o.text }
        : { type: "send", sessionId: o.sessionId, text: o.text, uploads: o.uploads };
    }
    case "upload":
      return exactKeys(o, ["type", "uploadId", "seq", "total", "name", "data"]) &&
        str(o.uploadId) && str(o.name) && str(o.data) &&
        nat(o.seq) && nat(o.total) && o.total > 0 && o.seq < o.total
        ? {
            type: "upload", uploadId: o.uploadId, seq: o.seq,
            total: o.total, name: o.name, data: o.data,
          }
        : null;
    case "watch":
    case "unwatch":
      return exactKeys(o, ["type", "sessionId"]) && str(o.sessionId)
        ? { type: o.type, sessionId: o.sessionId }
        : null;
    case "stats":
      return exactKeys(o, ["type"]) ? { type: "stats" } : null;
    default:
      return null;
  }
}

function isMobileMessage(v: unknown): v is MobileMessage {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (m.role !== "user" && m.role !== "assistant" && m.role !== "tool") return false;
  if (!str(m.text)) return false;
  if (m.truncated !== undefined && typeof m.truncated !== "boolean") return false;
  return keysWithin(m, ["role", "text"], ["truncated"]);
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isDayCount(v: unknown): v is { date: string; count: number } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  return exactKeys(d, ["date", "count"]) && str(d.date) && num(d.count);
}

function isModelUsageRow(v: unknown): v is ModelUsageRow {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (!exactKeys(m, ["label", "provider", "inTokens", "outTokens", "costUsd"])) return false;
  if (!str(m.label) || !str(m.provider)) return false;
  if (!num(m.inTokens) || !num(m.outTokens)) return false;
  // null 是"查不到价",和 0 是两件事 —— 这里要认得住这个区别
  return m.costUsd === null || num(m.costUsd);
}

/** 逐字段查。这一条来自已认证的桌面,不是公网上的任意人,但"整条丢弃"是这个
    文件的规矩,而 UI 会直接拿它去 map 和做除法 —— 少查一层,一条畸形统计
    就是一次白屏 */
function isRemoteStats(v: unknown): v is RemoteStats {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  if (!exactKeys(t, [
    "now", "activityDays", "usageDays", "activity", "sessions", "models", "totalCostUsd",
  ])) return false;
  if (!num(t.now) || !nat(t.activityDays) || !nat(t.usageDays) || !nat(t.sessions)) return false;
  if (!Array.isArray(t.activity) || !t.activity.every(isDayCount)) return false;
  if (!Array.isArray(t.models) || !t.models.every(isModelUsageRow)) return false;
  return t.totalCostUsd === null || num(t.totalCostUsd);
}

export function decodeDownFrame(line: string): DownFrame | null {
  const o = parseObject(line);
  if (!o) return null;
  switch (o.type) {
    case "fleet":
      return o.fleet && typeof o.fleet === "object" && Array.isArray((o.fleet as IslandFleet).agents)
        ? { type: "fleet", fleet: o.fleet as IslandFleet }
        : null;
    case "timeline": {
      // 元素也要逐字段查。这一条来自已认证的桌面,不是公网上的任意人,
      // 但"整条丢弃"是这个文件的规矩,而 UI 会直接 .map 出 role/text ——
      // 少查一层,一条畸形消息就是一次白屏
      if (!str(o.sessionId) || !Array.isArray(o.messages)) return null;
      if (!o.messages.every(isMobileMessage)) return null;
      return { type: "timeline", sessionId: o.sessionId, messages: o.messages };
    }
    case "ping":
      return typeof o.ts === "number" ? { type: "ping", ts: o.ts } : null;
    case "stats":
      return exactKeys(o, ["type", "stats"]) && isRemoteStats(o.stats)
        ? { type: "stats", stats: o.stats }
        : null;
    case "notice":
      return exactKeys(o, ["type", "text"]) && str(o.text) ? { type: "notice", text: o.text } : null;
    default:
      return null;
  }
}
