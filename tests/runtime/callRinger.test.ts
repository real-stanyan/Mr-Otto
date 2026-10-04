// callRinger —— 一次回电从打出去到接通 / 未接（#1411，spec §2.2–2.3）。时钟与定时器都是手拨的：
// 45 秒到点、5 秒推送封顶、冷却 10 分钟都不用真等。
import { describe, expect, it } from "vitest";
import { RING_PUSH_WAIT_MS, createRinger } from "../../services/runtime/src/callRinger.js";
import { RING_ANSWER_GRACE_MS, RING_TTL_MS, type RingChatKind, type RingPush } from "../../src/shared/callRing.js";
import type { CallRingEvent, SessionEvent } from "../../src/session/events.js";

/** 手拨的钟：advance 到点的定时器按时间顺序跑 */
function clock(start = 1_000_000) {
  let t = start;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = next++;
      pending.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h: unknown): void => {
      pending.delete(h as number);
    },
    advance(ms: number): void {
      t += ms;
      for (const [id, p] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (p.at <= t && pending.has(id)) {
          pending.delete(id);
          p.fn();
        }
      }
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function makeRinger(o: {
  seed?: SessionEvent[];
  watching?: boolean;
  devices?: number | Error;
  push?: (uid: string, ring: RingPush) => Promise<number>;
  chat?: RingChatKind;
  start?: number;
} = {}) {
  const c = clock(o.start);
  const events: CallRingEvent[] = [];
  const pushes: RingPush[] = [];
  let seq = 100;
  const r = createRinger({
    sessionId: "s1",
    workspaceId: "w1",
    seed: o.seed ?? [],
    append: (e) => {
      const logged = { ...e, seq: seq++ } as CallRingEvent;
      events.push(logged);
      return logged;
    },
    isWatching: () => o.watching ?? false,
    deviceCount: async () => {
      if (o.devices instanceof Error) throw o.devices;
      return o.devices ?? 1;
    },
    push: o.push ?? (async (_uid, ring) => {
      pushes.push(ring);
      return 1;
    }),
    chatKindFor: () => o.chat ?? "dm",
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    log: () => {},
  });
  return { r, c, events, pushes };
}

const seeded = (phase: "ringing" | "answered" | "missed", ts: number, expiresTs: number, ringId = "old"): SessionEvent => ({
  seq: 1, sessionId: "s1", ts, type: "call_ring", ringId, phase, fromAgentId: "ops", toUid: "u1",
  reason: "旧的", expiresTs, ignorable: true,
});

describe("打出去", () => {
  it("落 ringing（45 秒时限）、推送带齐那几格、回「已经打过去了」；到点记未接", async () => {
    const { r, c, events, pushes } = makeRinger({ chat: "group" });
    const text = await r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。");
    expect(text).toContain("已经打过去了");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "call_ring", phase: "ringing", fromAgentId: "ops", toUid: "u1", reason: "部署完了", opening: "部署好了，你看一下。",
      expiresTs: c.now() + RING_TTL_MS, ignorable: true, sessionId: "s1",
    });
    expect(pushes).toEqual([{
      ringId: events[0]!.ringId, workspaceId: "w1", sessionId: "s1", agentId: "ops", agentName: "运维",
      reason: "部署完了", opening: "部署好了，你看一下。", chat: "group", expiresTs: events[0]!.expiresTs,
    }]);
    c.advance(RING_TTL_MS - 1);
    expect(events).toHaveLength(1);
    c.advance(1);
    expect(events.map((e) => e.phase)).toEqual(["ringing", "missed"]);
    expect(events[1]).toMatchObject({ phase: "missed", opening: "部署好了，你看一下。" });
  });

  it("他正开着这条聊天：不打、不落事件", async () => {
    const { r, events, pushes } = makeRinger({ watching: true });
    expect(await r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。")).toContain("正开着这条聊天");
    expect(events).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("没有能收推送的设备：不打、不落事件；查设备抛错：另一句话，也不落", async () => {
    const none = makeRinger({ devices: 0 });
    expect(await none.r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。")).toContain("能接电话的新版");
    expect(none.events).toEqual([]);
    const broken = makeRinger({ devices: new Error("db down") });
    expect(await broken.r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。")).toContain("查不到他的手机");
    expect(broken.events).toEqual([]);
  });

  it("一台都没送到：ringing 之后当场记未接，回「没打通」", async () => {
    const { r, events } = makeRinger({ push: async () => 0 });
    expect(await r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。")).toContain("没打通");
    expect(events.map((e) => e.phase)).toEqual(["ringing", "missed"]);
  });

  it("推送 5 秒没回：当没送到", async () => {
    const { r, c, events } = makeRinger({ push: () => new Promise<number>(() => {}) });
    const p = r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。");
    await flush();
    c.advance(RING_PUSH_WAIT_MS);
    expect(await p).toContain("没打通");
    expect(events.map((e) => e.phase)).toEqual(["ringing", "missed"]);
  });
});

describe("tryCall（结构化结果，#1441）", () => {
  it("ignoreWatching 时对方开着聊天也照打；callerName 进推送", async () => {
    const { r, events, pushes } = makeRinger({ watching: true });
    const res = await r.tryCall("ops", "运维", "u2", "事由", "开场", { ignoreWatching: true, callerName: "Stan 的 运维" });
    expect(res.kind).toBe("ringing");
    if (res.kind === "ringing") expect(res.ringId).toBe(events[0]!.ringId);
    expect(pushes[0]!.agentName).toBe("Stan 的 运维");
    // 日志里的 fromAgentId 仍是智能体自己，名字只改推送
    expect(events[0]!.fromAgentId).toBe("ops");
  });

  it("不带选项时 watching 照旧拦、推送用原名", async () => {
    const w = makeRinger({ watching: true });
    expect((await w.r.tryCall("ops", "运维", "u1", "事由", "开场")).kind).toBe("watching");
    const n = makeRinger();
    await n.r.tryCall("ops", "运维", "u1", "事由", "开场");
    expect(n.pushes[0]!.agentName).toBe("运维");
  });

  it("每种不打各回自己的 kind；call() 的文案逐字不变", async () => {
    const args = ["ops", "运维", "u1", "事由", "开场"] as const;
    const texts = {
      watching: "他这会儿正开着这条聊天，直接在聊天里说就行，不用打电话。",
      no_device: "他的手机上还没有能接电话的新版 App（或者还没在手机上登录），打不了电话——在聊天里说一声，他回来会看到。",
      lookup_failed: "这会儿查不到他的手机，电话没打出去——在聊天里说一声，他回来会看到。",
      undelivered: "没打通（推送没送到）——在聊天里说一声，他回来会看到。",
      ringing: "已经打过去了。他接起来你会先开口；45 秒没接就算未接，他回来会在聊天里看到。",
    };
    const cases: Array<[keyof typeof texts, () => ReturnType<typeof makeRinger>]> = [
      ["watching", () => makeRinger({ watching: true })],
      ["no_device", () => makeRinger({ devices: 0 })],
      ["lookup_failed", () => makeRinger({ devices: new Error("db down") })],
      ["undelivered", () => makeRinger({ push: async () => 0 })],
      ["ringing", () => makeRinger()],
    ];
    for (const [kind, make] of cases) {
      const a = make();
      const res = await a.r.tryCall(...args);
      expect(res.kind).toBe(kind);
      expect(res.message).toBe(texts[kind]);
      const b = make();
      expect(await b.r.call(...args)).toBe(texts[kind]);
    }
  });
});

describe("不设冷却（#1499）", () => {
  it("同一只打给同一个人：刚打过一分钟也照样再打", async () => {
    const { r, c, events } = makeRinger();
    await r.call("ops", "运维", "u1", "一", "部署好了，你看一下。");
    c.advance(60_000);
    expect(await r.call("ops", "运维", "u1", "二", "部署好了，你看一下。")).toContain("已经打过去了");
    expect(events.filter((e) => e.phase === "ringing")).toHaveLength(2);
  });

  it("重启后日志里有刚打过的那一通，也照样再打", async () => {
    const start = 1_000_000;
    const { r, events } = makeRinger({
      start,
      seed: [seeded("ringing", start - 60_000, start - 15_000), seeded("missed", start - 15_000, start - 15_000)],
    });
    expect(await r.call("ops", "运维", "u1", "再打一次", "部署好了，你看一下。")).toContain("已经打过去了");
    expect(events.map((e) => e.phase)).toEqual(["ringing"]);
  });
});

describe("接听", () => {
  it("还在响：记接通、撤掉定时器（到点不再记未接）", async () => {
    const { r, c, events } = makeRinger();
    await r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。");
    const got = r.answer("ops", "u1");
    expect(got?.reason).toBe("部署完了");
    expect(got?.opening).toBe("部署好了，你看一下。");
    c.advance(RING_TTL_MS);
    expect(events.map((e) => e.phase)).toEqual(["ringing", "answered"]);
  });

  it("到点记了未接、还在宽限里：照样算接通；过了宽限：不算", async () => {
    const late = makeRinger();
    await late.r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。");
    late.c.advance(RING_TTL_MS + 5_000);
    expect(late.r.answer("ops", "u1")).not.toBeNull();
    expect(late.events.map((e) => e.phase)).toEqual(["ringing", "missed", "answered"]);
    const tooLate = makeRinger();
    await tooLate.r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。");
    tooLate.c.advance(RING_TTL_MS + RING_ANSWER_GRACE_MS + 1);
    expect(tooLate.r.answer("ops", "u1")).toBeNull();
  });

  it("别的智能体 / 别的人：不算接听", async () => {
    const { r } = makeRinger();
    await r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。");
    expect(r.answer("ads", "u1")).toBeNull();
    expect(r.answer("ops", "u2")).toBeNull();
  });
});

describe("重启与归档", () => {
  it("resume：过了时限的补一条未接；没过的接着计时；接通过的不碰", () => {
    const start = 1_000_000;
    const { r, c, events } = makeRinger({
      start,
      seed: [
        seeded("ringing", start - 60_000, start - 15_000, "expired"),
        seeded("ringing", start - 10_000, start + 35_000, "live"),
        seeded("ringing", start - 20_000, start + 25_000, "done"),
        seeded("answered", start - 19_000, start + 25_000, "done"),
      ],
    });
    r.resume();
    expect(events.map((e) => [e.ringId, e.phase])).toEqual([["expired", "missed"]]);
    c.advance(35_000);
    expect(events.map((e) => [e.ringId, e.phase])).toEqual([["expired", "missed"], ["live", "missed"]]);
    expect(events.every((e) => e.opening === undefined)).toBe(true);
  });

  it("missAll：还在响的一律未接，撤掉定时器", async () => {
    const { r, c, events } = makeRinger();
    await r.call("ops", "运维", "u1", "部署完了", "部署好了，你看一下。");
    r.missAll();
    c.advance(RING_TTL_MS);
    expect(events.map((e) => e.phase)).toEqual(["ringing", "missed"]);
  });
});
