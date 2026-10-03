// outreachRun 的单测（#1441 Task 9）：假定时器 + 假 deps，形状照 callRinger.test.ts。
// 假 deps 的 append 与 sessionService 的一致——落进 events 再喂回 observe（store.append + notify），
// 这样「observe 里 finish → append → 又喂回 observe」的重入路径是真走的。
import { describe, expect, it } from "vitest";
import { createOutreachRun, type OutreachEnded, type OutreachRun, type OutreachStart } from "../../services/runtime/src/outreachRun.js";
import type { OutreachEvent, SessionEvent } from "../../src/session/events.js";
import type { RingAttempt } from "../../services/runtime/src/callRinger.js";
import { OUTREACH_CAP_MS, OUTREACH_DROP_MS } from "../../src/shared/outreach.js";
import { RING_ANSWER_GRACE_MS } from "../../src/shared/callRing.js";

const PEER = "peer-1";
const START: OutreachStart = {
  outreachId: "o1", originSessionId: "origin-1", agentId: "ops", agentName: "运维", ownerName: "Stan",
  peerUid: PEER, peerName: "小红", brief: "问问明天的会", opening: "你好，我是运维。",
};

function harness(o: { ring?: RingAttempt; seed?: SessionEvent[]; watching?: () => boolean; onEnded?: (r: OutreachEnded) => void } = {}) {
  let clock = 1_000_000;
  const events: SessionEvent[] = [...(o.seed ?? [])];
  let seq = events.length;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const ended: OutreachEnded[] = [];
  const endCalls: number[] = [];
  const logs: string[] = [];
  let run!: OutreachRun;
  const emit = (e: Record<string, unknown>): SessionEvent => {
    const logged = { ...e, seq: ++seq } as SessionEvent;
    events.push(logged);
    run.observe(logged); // sessionService.notify 里就是这样喂的
    return logged;
  };
  run = createOutreachRun({
    sessionId: "s1",
    seed: events,
    append: (e) => emit({ ...e }) as OutreachEvent,
    ring: async () => o.ring ?? { kind: "ringing", ringId: "r1", message: "已经打过去了。" },
    endCall: () => {
      endCalls.push(clock);
      emit({ sessionId: "s1", ts: clock, type: "voice_call_changed", participants: [], byUid: "system", ignorable: true });
    },
    isWatching: o.watching ?? (() => true),
    events: () => events,
    onEnded: (r) => {
      ended.push(r);
      o.onEnded?.(r);
    },
    log: (m) => logs.push(m),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  });
  /** 把时钟推进 ms，途中到点的定时器按先后触发（触发出来的新定时器照样排队） */
  const advance = (ms: number): void => {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      clock = Math.max(clock, due[1].at);
      due[1].fn();
    }
    clock = target;
  };
  const ring = (phase: "ringing" | "answered" | "missed"): SessionEvent =>
    emit({
      sessionId: "s1", ts: clock, type: "call_ring", ringId: "r1", phase, fromAgentId: "ops", toUid: PEER,
      reason: "r", expiresTs: clock + 45_000, ignorable: true,
    });
  const outreachEvents = (): OutreachEvent[] => events.filter((e): e is OutreachEvent => e.type === "outreach");
  return { run, events, ended, endCalls, logs, advance, ring, emit, outreachEvents, now: () => clock, pending: () => timers.size };
}

describe("outreachRun（#1441）", () => {
  it("start：落 started（带 originSessionId），响铃；ring 没送到 → 当场落 ended{failed}，回 refused，onEnded 不调", async () => {
    const ok = harness();
    expect(await ok.run.start(START)).toEqual({ kind: "ringing" });
    expect(ok.outreachEvents()).toHaveLength(1);
    expect(ok.outreachEvents()[0]).toMatchObject({ phase: "started", outreachId: "o1", fromAgentId: "ops", peerUid: PEER, originSessionId: "origin-1" });
    expect(ok.run.live()).toEqual(START);

    const bad = harness({ ring: { kind: "no_device", message: "他的手机上还没有新版 App" } });
    expect(await bad.run.start(START)).toEqual({ kind: "refused", message: "他的手机上还没有新版 App" });
    expect(bad.outreachEvents().map((e) => e.phase)).toEqual(["started", "ended"]);
    expect(bad.outreachEvents()[1]).toMatchObject({ outcome: "failed", originSessionId: "origin-1" });
    expect(bad.ended).toEqual([]); // 工具当场把话回给模型，不另起汇报
    expect(bad.run.live()).toBeNull();
  });

  it("已有一通在进行：refused「这只正在打另一通电话」", async () => {
    const h = harness();
    await h.run.start(START);
    const r = await h.run.start({ ...START, outreachId: "o2" });
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { message: string }).message).toContain("这只正在打另一通电话");
    expect(h.outreachEvents()).toHaveLength(1); // 第二通一条都没落
  });

  it("call_ring missed 之后等 30 秒宽限仍没接 → ended{missed}，onEnded 带空转写", async () => {
    const h = harness();
    await h.run.start(START);
    h.ring("ringing");
    h.advance(45_000);
    h.ring("missed");
    h.advance(RING_ANSWER_GRACE_MS - 1);
    expect(h.ended).toEqual([]);
    h.advance(1);
    expect(h.outreachEvents().at(-1)).toMatchObject({ phase: "ended", outcome: "missed" });
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ outcome: "missed", durationMs: null, transcript: [], originSessionId: "origin-1", agentName: "运维", ownerName: "Stan", peerName: "小红" });
    expect(h.endCalls).toEqual([]); // 没接通过，没有通话名单要清
  });

  it("missed 之后 30 秒内 answered → 不收，转入通话", async () => {
    const h = harness();
    await h.run.start(START);
    h.ring("ringing");
    h.ring("missed");
    h.advance(RING_ANSWER_GRACE_MS - 1_000);
    h.ring("answered");
    h.advance(RING_ANSWER_GRACE_MS * 2);
    expect(h.ended).toEqual([]);
    expect(h.outreachEvents().map((e) => e.phase)).toEqual(["started"]);
  });

  it("answered 之后 voice_call_changed 名单变空 → ended{completed}，durationMs = 挂断 - 接通，转写从接通那条起", async () => {
    const h = harness();
    await h.run.start(START);
    h.ring("ringing");
    // 接通前的话不算通话内容
    h.emit({ sessionId: "s1", ts: h.now(), type: "user_message", content: "接通前的杂音", fromUid: PEER, mentions: ["ops"] });
    h.advance(5_000);
    h.ring("answered");
    h.emit({ sessionId: "s1", ts: h.now(), type: "assistant_message", agentId: "ops", content: "你好，我是运维。", model: "m" });
    h.advance(3_000);
    h.emit({ sessionId: "s1", ts: h.now(), type: "user_message", content: "好的，明天去", fromUid: PEER, mentions: ["ops"] });
    h.advance(7_000);
    h.emit({ sessionId: "s1", ts: h.now(), type: "voice_call_changed", participants: [], byUid: PEER, ignorable: true });
    const last = h.outreachEvents().at(-1)!;
    expect(last).toMatchObject({ phase: "ended", outcome: "completed", durationMs: 10_000 });
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]!.durationMs).toBe(10_000);
    expect(h.ended[0]!.transcript.map((l) => [l.who, l.text])).toEqual([["agent", "你好，我是运维。"], ["peer", "好的，明天去"]]);
    expect(h.endCalls).toEqual([]); // 对方自己挂的，不用我们再清一遍
    expect(h.pending()).toBe(0); // 封顶 / 掉线定时器都收了
  });

  it("接通满 10 分钟 → endCall() 被调、ended{capped}（且恰好一条 ended）", async () => {
    const h = harness();
    await h.run.start(START);
    h.ring("ringing");
    h.ring("answered");
    h.advance(OUTREACH_CAP_MS - 1);
    expect(h.ended).toEqual([]);
    h.advance(1);
    expect(h.endCalls).toHaveLength(1);
    const ends = h.outreachEvents().filter((e) => e.phase === "ended");
    expect(ends).toHaveLength(1); // endCall 落的空名单回到 observe 时不能再收成 completed
    expect(ends[0]).toMatchObject({ outcome: "capped", durationMs: OUTREACH_CAP_MS });
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]!.outcome).toBe("capped");
    // ended 先于清名单落盘：这条 outreach 事件在那条空名单 voice_call_changed 之前
    const iEnded = h.events.findIndex((e) => e.type === "outreach" && e.phase === "ended");
    const iEmpty = h.events.findIndex((e) => e.type === "voice_call_changed" && e.participants.length === 0);
    expect(iEnded).toBeGreaterThan(-1);
    expect(iEnded).toBeLessThan(iEmpty);
  });

  it("接通后对方连续 90 秒不在房里 → endCall()、ended{completed}", async () => {
    let watching = true;
    const h = harness({ watching: () => watching });
    await h.run.start(START);
    h.ring("ringing");
    h.ring("answered");
    h.advance(60_000); // 在房里：不计
    watching = false;
    h.advance(OUTREACH_DROP_MS - 30_000); // 不在了，但还没满 90 秒
    expect(h.ended).toEqual([]);
    watching = true; // 回来了：计时清零
    h.advance(30_000);
    expect(h.ended).toEqual([]);
    watching = false;
    h.advance(OUTREACH_DROP_MS + 30_000);
    expect(h.endCalls).toHaveLength(1);
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ outcome: "completed" });
    expect(h.outreachEvents().filter((e) => e.phase === "ended")).toHaveLength(1);
  });

  it("resume：日志里停在 started 的补 ended{failed}，带 originSessionId 的照调 onEnded；agentName / ownerName 是空串", () => {
    const seed: SessionEvent[] = [
      {
        sessionId: "s1", seq: 1, ts: 1, type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops",
        peerUid: PEER, peerName: "小红", originSessionId: "origin-1", ignorable: true,
      },
    ];
    const h = harness({ seed });
    h.run.resume();
    expect(h.outreachEvents().at(-1)).toMatchObject({ phase: "ended", outcome: "failed", originSessionId: "origin-1" });
    expect(h.ended).toEqual([
      expect.objectContaining({ outreachId: "o1", originSessionId: "origin-1", outcome: "failed", agentName: "", ownerName: "", agentId: "ops", peerName: "小红" }),
    ]);
    // 再 resume 一次不再落（每一通只收一次）
    h.run.resume();
    expect(h.ended).toHaveLength(1);
  });

  it("failAll：进行中的落 ended{failed} 并调 onEnded", async () => {
    const h = harness();
    await h.run.start(START);
    h.ring("ringing");
    h.run.failAll();
    expect(h.outreachEvents().at(-1)).toMatchObject({ phase: "ended", outcome: "failed" });
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ outcome: "failed", agentName: "运维", ownerName: "Stan" });
    expect(h.pending()).toBe(0);
  });

  it("每一通只收一次：ended 之后再来 voice_call_changed 不再落", async () => {
    const h = harness();
    await h.run.start(START);
    h.ring("ringing");
    h.ring("answered");
    h.emit({ sessionId: "s1", ts: h.now(), type: "voice_call_changed", participants: [], byUid: PEER, ignorable: true });
    h.emit({ sessionId: "s1", ts: h.now(), type: "voice_call_changed", participants: [], byUid: PEER, ignorable: true });
    h.advance(OUTREACH_CAP_MS * 2);
    expect(h.outreachEvents().filter((e) => e.phase === "ended")).toHaveLength(1);
    expect(h.ended).toHaveLength(1);
  });

  it("onEnded 抛了：不冒出 observe / 定时器，记一行日志，状态照样清干净，不会再收第二次", async () => {
    const h = harness({ onEnded: () => { throw new Error("hub 炸了"); } });
    await h.run.start(START);
    h.ring("ringing");
    h.ring("answered");
    // 好友挂断那条路：从 observe 里收尾
    expect(() => h.emit({ sessionId: "s1", ts: h.now(), type: "voice_call_changed", participants: [], byUid: PEER, ignorable: true })).not.toThrow();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("hub 炸了");
    expect(h.run.live()).toBeNull();
    expect(h.pending()).toBe(0);
    h.advance(OUTREACH_CAP_MS * 2);
    expect(h.outreachEvents().filter((e) => e.phase === "ended")).toHaveLength(1);

    // 定时器那条路（封顶）
    const t = harness({ onEnded: () => { throw new Error("又炸了"); } });
    await t.run.start(START);
    t.ring("ringing");
    t.ring("answered");
    expect(() => t.advance(OUTREACH_CAP_MS)).not.toThrow();
    expect(t.logs).toHaveLength(1);
    expect(t.endCalls).toHaveLength(1); // 回调抛了也先挂了电话
    expect(t.run.live()).toBeNull();
  });
});
