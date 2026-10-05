// tests/shared/appRoomApi.test.ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRoom, pingRoom, releaseRoomChannels, roomData, subscribeRoom } from "../../src/shared/appRoomApi.js";

const ROOM = "11111111-2222-4333-8444-555555555555";
const U1 = "2819d0bb-933b-499d-be44-2bb51b5a8391";

/** 照 realtime-js 2.112.3 的样子：channel(topic) 见到同名（topic 带 realtime: 前缀）的就把那条原样还回去——
    哪怕它正在 leaving；只有 removeChannel 那条 promise 落地之后它才从 getChannels() 里消失。
    manualRemove：removeChannel 挂着，等测试逐条 settle */
function fakeClient(rpcReply: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }, opts: { manualRemove?: boolean } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  type FakeChannel = { topic: string; on(kind: string, filter: { event: string }, cb: (p: { payload: unknown }) => void): FakeChannel; subscribe(cb?: (s: string) => void): FakeChannel; send(m: unknown): Promise<string> };
  // 每个频道名一份：记下 opts 与按事件名注册的回调
  const channels = new Map<string, { opts: unknown; on: Map<string, (p: { payload: unknown }) => void>; sent: unknown[]; subscribed: number; api: FakeChannel }>();
  const pending: { topic: string; settle: () => void }[] = [];
  const removed: string[] = [];
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) { calls.push({ fn, args }); return rpcReply(fn, args); },
    channel(topic: string, o: unknown) {
      const had = channels.get(topic);
      if (had !== undefined) return had.api;
      const c = { opts: o, on: new Map<string, (p: { payload: unknown }) => void>(), sent: [] as unknown[], subscribed: 0, api: null as unknown as FakeChannel };
      const api: FakeChannel = {
        topic: `realtime:${topic}`,
        on(kind, filter, cb) { if (kind === "broadcast") c.on.set(filter.event, cb); return api; },
        subscribe() { c.subscribed += 1; return api; },
        async send(m) { c.sent.push(m); return "ok"; },
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
  return { client, calls, channels, fire, pending, removed };
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
