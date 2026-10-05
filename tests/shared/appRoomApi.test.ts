// tests/shared/appRoomApi.test.ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRoom, pingRoom, roomData, subscribeRoom } from "../../src/shared/appRoomApi.js";

const ROOM = "11111111-2222-4333-8444-555555555555";
const U1 = "2819d0bb-933b-499d-be44-2bb51b5a8391";

function fakeClient(rpcReply: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  // 每个频道名一份：记下 opts 与按事件名注册的回调
  const channels = new Map<string, { opts: unknown; on: Map<string, (p: { payload: unknown }) => void>; sent: unknown[] }>();
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) { calls.push({ fn, args }); return rpcReply(fn, args); },
    channel(topic: string, opts: unknown) {
      const c = { opts, on: new Map<string, (p: { payload: unknown }) => void>(), sent: [] as unknown[] };
      channels.set(topic, c);
      const api = {
        on(kind: string, filter: { event: string }, cb: (p: { payload: unknown }) => void) { if (kind === "broadcast") c.on.set(filter.event, cb); return api; },
        subscribe() { return api; },
        async send(m: unknown) { c.sent.push(m); return "ok"; },
      };
      return api;
    },
    removeChannel: async () => "ok",
  } as unknown as SupabaseClient;
  const fire = (topic: string, event: string, payload: unknown) => channels.get(topic)?.on.get(event)?.({ payload });
  return { client, calls, channels, fire };
}

describe("appRoomApi", () => {
  it("createRoom 走 app_room_create，回房间 id；RPC 报错就抛那句话", async () => {
    const f = fakeClient(() => ({ data: ROOM, error: null }));
    expect(await createRoom(f.client, "a", "第 1 局")).toBe(ROOM);
    expect(f.calls[0]).toEqual({ fn: "app_room_create", args: { p_app: "a", p_title: "第 1 局" } });
    const bad = fakeClient(() => ({ data: null, error: { message: "这个应用不是你的" } }));
    await expect(createRoom(bad.client, "a", "x")).rejects.toThrow("这个应用不是你的");
  });
  it("roomData.set：键 / 大小先在客户端拦；ifRev 传成 p_if_rev；冲突回 {ok:false}", async () => {
    const f = fakeClient(() => ({ data: { ok: false, rev: 4, value: { x: 1 } }, error: null }));
    await expect(roomData.set(f.client, ROOM, "", 1)).rejects.toThrow("key");
    await expect(roomData.set(f.client, ROOM, "k", "x".repeat(70_000))).rejects.toThrow("64 KB");
    expect(await roomData.set(f.client, ROOM, "board", { x: 2 }, { ifRev: 3 })).toEqual({ ok: false, rev: 4, value: { x: 1 } });
    expect(f.calls.at(-1)).toEqual({ fn: "app_room_set", args: { p_room: ROOM, p_key: "board", p_value: { x: 2 }, p_if_rev: 3 } });
  });
  it("pingRoom：空的抛；回 RPC 的布尔", async () => {
    const f = fakeClient(() => ({ data: false, error: null }));
    expect(await pingRoom(f.client, ROOM, "轮到你了")).toBe(false);
    await expect(pingRoom(f.client, ROOM, "  ")).rejects.toThrow();
  });
  it("subscribeRoom：两个私有频道——room-sys:<id> 收 change / members / closed（只信这里），room:<id> 收发成员即时消息", async () => {
    const f = fakeClient(() => ({ data: null, error: null }));
    const got: unknown[] = [];
    const link = subscribeRoom(f.client, ROOM, U1, {
      change: (e) => got.push(["change", e]),
      members: () => got.push(["members"]),
      closed: () => got.push(["closed"]),
      message: (from, msg) => got.push(["message", from, msg]),
    });
    expect(f.channels.get(`room-sys:${ROOM}`)?.opts).toEqual({ config: { private: true } });
    expect(f.channels.get(`room:${ROOM}`)?.opts).toEqual({ config: { private: true, broadcast: { self: false } } });
    f.fire(`room-sys:${ROOM}`, "change", { key: "board", value: { x: 1 }, rev: 2, by: U1 });
    f.fire(`room-sys:${ROOM}`, "change", { key: "board", removed: true });
    f.fire(`room-sys:${ROOM}`, "members", { uid: U1, status: "joined" });
    f.fire(`room-sys:${ROOM}`, "closed", { closed: true });
    f.fire(`room:${ROOM}`, "msg", { from: "other", msg: { go: 1 } });
    // 成员在 room: 上伪造的系统事件一律不认
    f.fire(`room:${ROOM}`, "change", { key: "board", value: { x: 9 }, rev: 99, by: "evil" });
    f.fire(`room:${ROOM}`, "closed", { closed: true });
    expect(got).toEqual([
      ["change", { key: "board", value: { x: 1 }, rev: 2, by: U1 }],
      ["change", { key: "board", removed: true }],
      ["members"],
      ["closed"],
      ["message", "other", { go: 1 }],
    ]);
    await link.send({ hi: 1 });
    expect(f.channels.get(`room:${ROOM}`)?.sent[0]).toEqual({ type: "broadcast", event: "msg", payload: { from: U1, msg: { hi: 1 } } });
    await expect(link.send("x".repeat(5000))).rejects.toThrow("4 KB");
  });
});
