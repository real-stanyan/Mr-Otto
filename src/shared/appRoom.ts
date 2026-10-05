// appRoom —— Otto 应用的房间（#1675，spec docs/superpowers/specs/2026-10-05-otto-app-rooms-design.md）的纯逻辑：
// 限额常量（与 migration 0067 的 RPC 一致）、行解析（字节来自网络，逐格验）、邀请信封（应用卡多一格 room——不进位 cs 协议）、
// 「一家子」（副本认源）、即时消息的速率闸。IO 在 appRoomApi.ts。
import { APP_CARD_KIND, appShareMarker, decodeAppCard, type AppShareCard } from "./appCard.js";
import type { AppRow } from "./apps.js";
import { DM_BODY_MAX } from "./contactCard.js";

export const ROOM_MEMBERS_MAX = 8;
export const ROOM_KEYS_MAX = 500;
export const ROOM_VALUE_BYTES_MAX = 65536;
export const ROOM_KEY_MAX = 200;
export const ROOM_MSG_BYTES_MAX = 4096;
export const ROOM_MSG_PER_SEC = 20;
export const ROOM_PING_TEXT_MAX = 80;
export const ROOM_TITLE_MAX = 40;

export type RoomMemberStatus = "invited" | "joined" | "left";
export interface RoomRow { id: string; hostUid: string; hostAppId: string; hostVersion: number; familyId: string; title: string; closed: boolean; updatedTs: number }
export interface RoomMember { uid: string; status: RoomMemberStatus }
export interface RoomEntry { key: string; value: unknown; rev: number; by: string | null }
export type RoomSetResult = { ok: true; rev: number } | { ok: false; rev: number; value: unknown };
export interface RoomInvite { id: string; title: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rec = (raw: unknown): Record<string, unknown> | null => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);

export function roomRowOf(raw: unknown): RoomRow | null {
  const o = rec(raw);
  if (o === null) return null;
  const id = uuid(o.id);
  const hostUid = uuid(o.host_uid);
  const hostAppId = uuid(o.host_app_id);
  const familyId = uuid(o.family_id);
  const hostVersion = int(o.host_version);
  if (id === null || hostUid === null || hostAppId === null || familyId === null || hostVersion === null || hostVersion < 1) return null;
  if (typeof o.title !== "string" || o.title === "" || typeof o.closed !== "boolean") return null;
  const ts = typeof o.updated_at === "string" ? Date.parse(o.updated_at) : NaN;
  return { id, hostUid, hostAppId, hostVersion, familyId, title: o.title, closed: o.closed, updatedTs: Number.isNaN(ts) ? 0 : ts };
}

export function roomMemberOf(raw: unknown): RoomMember | null {
  const o = rec(raw);
  const uid = o === null ? null : uuid(o.uid);
  if (o === null || uid === null) return null;
  return o.status === "invited" || o.status === "joined" || o.status === "left" ? { uid, status: o.status } : null;
}

export function roomEntryOf(raw: unknown): RoomEntry | null {
  const o = rec(raw);
  if (o === null || !roomKeyOk(o.key) || !("value" in o)) return null;
  const rev = int(o.rev);
  if (rev === null) return null;
  return { key: o.key, value: o.value, rev, by: uuid(o.updated_by) };
}

export function roomSetResultOf(raw: unknown): RoomSetResult | null {
  const o = rec(raw);
  const rev = o === null ? null : int(o.rev);
  if (o === null || rev === null) return null;
  if (o.ok === true) return { ok: true, rev };
  if (o.ok === false) return { ok: false, rev, value: o.value ?? null };
  return null;
}

export const roomTopic = (roomId: string): string => `room:${roomId}`;
export const roomSysTopic = (roomId: string): string => `room-sys:${roomId}`;

export function encodeRoomInvite(card: AppShareCard, room: RoomInvite): string {
  const body = JSON.stringify({ otto: APP_CARD_KIND, v: 1, card, room: { id: room.id, title: room.title.slice(0, ROOM_TITLE_MAX) } });
  if (body.length > DM_BODY_MAX) throw new Error("这个应用的说明太长，发不了邀请");
  return body;
}

/** 认得出回 {card, room}；普通应用卡（没有 room）/ 别的信封回 null。card 那一半复用 decodeAppCard 的严格判 */
export function decodeRoomInvite(body: string): { card: AppShareCard; room: RoomInvite } | null {
  const card = decodeAppCard(body);
  if (card === null) return null;
  let env: unknown;
  try {
    env = JSON.parse(body);
  } catch {
    return null;
  }
  const r = rec(rec(env)?.room);
  const id = r === null ? null : uuid(r.id);
  if (r === null || id === null || typeof r.title !== "string" || r.title === "" || r.title.length > ROOM_TITLE_MAX) return null;
  return { card, room: { id, title: r.title } };
}

export const roomInvitePreview = (card: AppShareCard): string => `[邀请] ${card.icon} ${card.name}`;

/** 这个应用属于哪一家：副本（share:<源>）认源，原版认自己。同 migration 0067 app_room_create 里 family 的算法 */
export function familyOf(app: AppRow): string {
  const m = /^share:([0-9a-f-]{36})$/i.exec(app.createdByAgent);
  return m !== null ? m[1]!.toLowerCase() : app.id;
}

/**
 * 我名下对应房主那个应用的一份。认法依次：房主就是我（同一个 id）→ 我手里是它的副本 →
 * （给了房间的 family 时）家就是我的原版 → 我手里是同一家的别的副本。
 * 房主多半在副本上开局（分享过后人人手里都是副本），只认前两条会让同家的人再装一份、新副本的家又对不上房间（#1675 终审）。
 */
export function myAppForHost(apps: readonly AppRow[], hostAppId: string, familyId?: string): AppRow | null {
  const exact = apps.find((a) => a.id === hostAppId) ?? apps.find((a) => a.createdByAgent === appShareMarker(hostAppId));
  if (exact !== undefined) return exact;
  if (familyId === undefined) return null;
  const fam = familyId.toLowerCase();
  return apps.find((a) => a.id === fam) ?? apps.find((a) => familyOf(a) === fam) ?? null;
}

/** 每秒最多 perSec 次：滑动一秒的窗 */
export function createRateGate(perSec: number, now: () => number = () => Date.now()): () => boolean {
  const hits: number[] = [];
  return () => {
    const t = now();
    while (hits.length > 0 && t - hits[0]! >= 1000) hits.shift();
    if (hits.length >= perSec) return false;
    hits.push(t);
    return true;
  };
}

export const roomKeyOk = (k: unknown): k is string => typeof k === "string" && k.length >= 1 && k.length <= ROOM_KEY_MAX;

export function jsonBytes(v: unknown): number {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? Infinity : new TextEncoder().encode(s).length;
  } catch {
    return Infinity;
  }
}
