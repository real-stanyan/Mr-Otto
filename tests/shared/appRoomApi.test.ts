// tests/shared/appRoomApi.test.ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRoom, listRooms, pingRoom, releaseRoomChannels, roomData, roomListFilter, subscribeRoom } from "../../src/shared/appRoomApi.js";
import { familyOf } from "../../src/shared/appRoom.js";
import type { AppRow } from "../../src/shared/apps.js";

const ROOM = "11111111-2222-4333-8444-555555555555";
const U1 = "2819d0bb-933b-499d-be44-2bb51b5a8391";

/** 照 realtime-js 2.112.3 的样子：channel(topic) 见到同名（topic 带 realtime: 前缀）的就把那条原样还回去——
    哪怕它正在 leaving；只有 removeChannel 那条 promise 落地之后它才从 getChannels() 里消失。
    manualRemove：removeChannel 挂着，等测试逐条 settle */
function fakeClient(rpcReply: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }, opts: { manualRemove?: boolean; sendReply?: string } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  type FakeChannel = { topic: string; on(kind: string, filter: { event: string }, cb: (p: { payload: unknown }) => void): FakeChannel; subscribe(cb?: (s: string) => void): FakeChannel; send(m: unknown): Promise<string> };
  // 每个频道名一份：记下 opts 与按事件名注册的回调
  const channels = new Map<string, { opts: unknown; on: Map<string, (p: { payload: unknown }) => void>; sent: unknown[]; subscribed: number; status: ((s: string) => void) | null; api: FakeChannel }>();
  const pending: { topic: string; settle: () => void }[] = [];
  const removed: string[] = [];
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) { calls.push({ fn, args }); return rpcReply(fn, args); },
    channel(topic: string, o: unknown) {
      const had = channels.get(topic);
      if (had !== undefined) return had.api;
      const c = { opts: o, on: new Map<string, (p: { payload: unknown }) => void>(), sent: [] as unknown[], subscribed: 0, status: null as ((s: string) => void) | null, api: null as unknown as FakeChannel };
      const api: FakeChannel = {
        topic: `realtime:${topic}`,
        on(kind, filter, cb) { if (kind === "broadcast") c.on.set(filter.event, cb); return api; },
        subscribe(cb) { c.subscribed += 1; c.status = cb ?? null; return api; },
        async send(m) { c.sent.push(m); return opts.sendReply ?? "ok"; },
      };
      c.api = api;
      channels.set(topic, c);
      return api;
    },
    getChannels() { return [...channels.values()].map((c) => c.api); },
    removeChannel(ch: FakeChannel) {
      const plain = ch.topic.replace(/^realtime:/, "");
      return new Promise<string>((resolve) => {
        const settle = (): void => { channels.delete(plain); removed.push(plain); resolve("ok"); };
        if (opts.manualRemove === true) pending.push({ topic: plain, settle });
        else queueMicrotask(settle);
      });
    },
  } as unknown as SupabaseClient;
  const fire = (topic: string, event: string, payload: unknown) => channels.get(topic)?.on.get(event)?.({ payload });
  const status = (topic: string, s: string) => channels.get(topic)?.status?.(s);
  return { client, calls, channels, fire, status, pending, removed };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const noop = { change: () => undefined, members: () => undefined, closed: () => undefined, message: () => undefined };

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
  it("listRooms：同一家的房间 + 就开在这个应用上的房间（.or 两个条件），按 updated_at 倒序", async () => {
    const FAM = "0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b";
    const APPX = "c0000000-0000-4000-8000-000000000000";
    const ops: unknown[][] = [];
    const row = { id: ROOM, host_uid: U1, host_app_id: APPX, host_version: 1, family_id: FAM, title: "局", closed: false, updated_at: "2026-10-05T00:00:00Z" };
    const builder: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["select", "eq", "or", "order", "limit"]) builder[m] = (...a: unknown[]) => { ops.push([m, ...a]); return builder; };
    (builder as { then?: unknown }).then = (res: (v: unknown) => void) => res({ data: [row], error: null });
    const client = { from: (t: string) => { ops.push(["from", t]); return builder; } } as unknown as SupabaseClient;
    const rows = await listRooms(client, FAM, APPX);
    expect(rows?.map((r) => r.id)).toEqual([ROOM]);
    expect(ops).toContainEqual(["from", "app_rooms"]);
    expect(ops).toContainEqual(["or", `family_id.eq.${FAM},host_app_id.eq.${APPX}`]);
    expect(ops.some((o) => o[0] === "eq" && o[1] === "family_id")).toBe(false);
    expect(ops).toContainEqual(["order", "updated_at", { ascending: false }]);
  });
  it("listRooms 的过滤串：A 原作者、B 拿副本 Bc 开局（family=A, host=Bc）、C 拿的是 Bc 的副本 Cc——C 两个 id 都给自己的源，才认得出这一局（#1675 复审）", () => {
    const A = "a0000000-0000-4000-8000-000000000000";
    const Bc = "b0000000-0000-4000-8000-000000000000";
    const Cc = "c0000000-0000-4000-8000-000000000000";
    const room = { family_id: A, host_app_id: Bc };
    // PostgREST 的 or：逗号分开的 col.eq.val，任一条成立
    const matches = (filter: string, row: Record<string, string>): boolean =>
      filter.split(",").some((c) => { const [col, op, val] = c.split("."); return op === "eq" && row[col!] === val; });
    const app = (id: string, createdByAgent: string): AppRow => ({ id, workspaceId: "w", ownerUid: U1, slug: "g", name: "g", icon: "g", description: "", currentVersion: 1, createdByAgent, updatedTs: 0 });
    const cc = app(Cc, `share:${Bc}`);
    expect(familyOf(cc)).toBe(Bc);
    expect(matches(roomListFilter(familyOf(cc), familyOf(cc)), room)).toBe(true); // 第二条 host_app_id.eq.Bc 命中
    expect(matches(roomListFilter(familyOf(cc), cc.id), room)).toBe(false); // 原来给自己的 id：两条都落空
    // A 自己、B 自己也都认得出
    expect(matches(roomListFilter(familyOf(app(A, "a_x")), familyOf(app(A, "a_x"))), room)).toBe(true);
    expect(matches(roomListFilter(familyOf(app(Bc, `share:${A}`)), familyOf(app(Bc, `share:${A}`))), room)).toBe(true);
    expect(roomListFilter(A, Bc)).toBe(`family_id.eq.${A},host_app_id.eq.${Bc}`);
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

  it("send：频道没收下（回的不是 ok，比如 timed out / error）就抛「即时消息没发出去」", async () => {
    const f = fakeClient(() => ({ data: null, error: null }), { sendReply: "timed out" });
    const link = subscribeRoom(f.client, ROOM, U1, noop);
    await expect(link.send({ hi: 1 })).rejects.toThrow("即时消息没发出去");
  });
  it("status：room-sys 的原样给；room: 那条带 chat: 前缀给（宿主的重订只认 room-sys 的）", () => {
    const f = fakeClient(() => ({ data: null, error: null }));
    const got: string[] = [];
    subscribeRoom(f.client, ROOM, U1, { ...noop, status: (s) => got.push(s) });
    f.status(`room-sys:${ROOM}`, "SUBSCRIBED");
    f.status(`room:${ROOM}`, "CHANNEL_ERROR");
    expect(got).toEqual(["SUBSCRIBED", "chat:CHANNEL_ERROR"]);
  });

  it("close() 是个 promise：两条频道都真拆完才落地；拆完之前同名 channel() 还会拿回那条旧的（realtime-js 的行为）", async () => {
    const f = fakeClient(() => ({ data: null, error: null }), { manualRemove: true });
    const link = subscribeRoom(f.client, ROOM, U1, noop);
    const oldSys = f.client.channel(`room-sys:${ROOM}`);
    let done = false;
    const p = link.close().then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    expect(f.pending.map((x) => x.topic).sort()).toEqual([`room-sys:${ROOM}`, `room:${ROOM}`].sort());
    // 还在 leaving：同名再要一条，拿回的是旧的那条——在它上面 subscribe 就是那个死订阅
    expect(f.client.channel(`room-sys:${ROOM}`)).toBe(oldSys);
    f.pending[0]!.settle();
    await flush();
    expect(done).toBe(false);
    f.pending[1]!.settle();
    await p;
    expect(done).toBe(true);
    expect(f.channels.size).toBe(0);
  });

  it("releaseRoomChannels：把这个 client 上这间房已有的两条频道拆干净（别的房不动），之后 subscribeRoom 拿到的是新频道", async () => {
    const OTHER = "99999999-2222-4333-8444-555555555555";
    const f = fakeClient(() => ({ data: null, error: null }));
    const staleSys = f.client.channel(`room-sys:${ROOM}`);
    f.client.channel(`room:${ROOM}`);
    f.client.channel(`room:${OTHER}`);
    await releaseRoomChannels(f.client, ROOM);
    expect(f.removed.sort()).toEqual([`room-sys:${ROOM}`, `room:${ROOM}`].sort());
    expect(f.channels.has(`room:${OTHER}`)).toBe(true);
    subscribeRoom(f.client, ROOM, U1, noop);
    expect(f.client.channel(`room-sys:${ROOM}`)).not.toBe(staleSys);
    expect(f.channels.get(`room-sys:${ROOM}`)?.subscribed).toBe(1);
    // 什么都没有时是空操作
    const g = fakeClient(() => ({ data: null, error: null }));
    await releaseRoomChannels(g.client, ROOM);
    expect(g.removed).toEqual([]);
  });
});
