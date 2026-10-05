// roomPush —— 应用房间的「叫人」（#1675，spec §6）。应用调 otto.room.ping → 手机直连 app_room_ping RPC 往 app_room_pings 写一行
// （限速在 RPC 里）。runtime 用 service key 订这张表的 INSERT，推给这间房其他 joined 成员。推不推交 notifier（朋友那个开关 / 免打扰）。
// 形状同 friendPush.ts，同样的已知代价：realtime 断线期间写进来的不补推。
import type { SupabaseClient } from "@supabase/supabase-js";
import { alertBody, type AlertPush } from "../../../src/shared/notifyPrefs.js";
import type { Notifier } from "./notifier.js";

export interface RoomPingRow { id: number; roomId: string; fromUid: string; text: string }

export function roomPingOf(raw: unknown): RoomPingRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "number" ? o.id : typeof o.id === "string" && /^\d+$/.test(o.id) ? Number(o.id) : null;
  if (id === null || typeof o.room_id !== "string" || typeof o.from_uid !== "string" || typeof o.text !== "string" || o.text === "") return null;
  return { id, roomId: o.room_id, fromUid: o.from_uid, text: o.text };
}

export interface RoomPushDeps {
  notifier: Notifier;
  nameOf(uid: string): Promise<string>;
  audience(roomId: string, exceptUid: string): Promise<{ uids: string[]; appName: string; hostAppId: string } | null>;
  log(m: string): void;
}

export function createRoomPush(d: RoomPushDeps): { onInsert(raw: unknown): Promise<void> } {
  return {
    async onInsert(raw) {
      const p = roomPingOf(raw);
      if (p === null) return;
      try {
        const aud = await d.audience(p.roomId, p.fromUid);
        if (aud === null || aud.uids.length === 0) return;
        let name: string;
        try {
          name = await d.nameOf(p.fromUid);
        } catch {
          name = p.fromUid.slice(0, 8);
        }
        const push: AlertPush = { title: `${name}·${aud.appName}`, body: alertBody(p.text), target: { kind: "room", roomId: p.roomId, hostAppId: aud.hostAppId } };
        for (const uid of aud.uids) await d.notifier.send(uid, "friend", push);
      } catch (err) {
        d.log(`[otto-runtime] 房间叫人推送失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** 其他 joined 成员 + 房主那一版清单里的应用名 */
export function createRoomAudience(client: SupabaseClient): RoomPushDeps["audience"] {
  return async (roomId, exceptUid) => {
    const room = await client.from("app_rooms").select("host_app_id, host_version, closed").eq("id", roomId).maybeSingle();
    if (room.error || room.data === null) return null;
    const r = room.data as { host_app_id: string; host_version: number; closed: boolean };
    if (r.closed) return null;
    const mem = await client.from("app_room_members").select("uid").eq("room_id", roomId).eq("status", "joined");
    if (mem.error) return null;
    const uids = ((mem.data ?? []) as { uid: string }[]).map((m) => m.uid).filter((u) => u !== exceptUid);
    const ver = await client.from("app_versions").select("manifest").eq("app_id", r.host_app_id).eq("version", r.host_version).maybeSingle();
    const name = (ver.data as { manifest?: { name?: unknown } } | null)?.manifest?.name;
    return { uids, appName: typeof name === "string" && name !== "" ? name : "应用", hostAppId: r.host_app_id };
  };
}

export function subscribeRoomPings(client: SupabaseClient, onInsert: (raw: unknown) => void, log: (m: string) => void): () => void {
  const channel = client
    .channel("otto-runtime-room-pings")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "app_room_pings" }, (payload) => onInsert(payload.new))
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") log("[otto-runtime] 房间叫人推送：已订上 app_room_pings");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") log(`[otto-runtime] 房间叫人推送：订阅 ${status}${err ? `：${err.message}` : ""}（supabase-js 会自己重连）`);
    });
  return () => {
    void client.removeChannel(channel);
  };
}
