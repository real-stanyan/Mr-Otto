import { describe, expect, it } from "vitest";
import {
  CALLKIT_IDLE, callKitEventOf, inSystemCall, onVoiceCall, reduceCallKit, systemAudioReady, type CallKitState,
} from "../../src/shared/callKitBridge.js";
import type { RingPush } from "../../src/shared/callRing.js";

const RING: RingPush = {
  ringId: "r1", workspaceId: "w1", sessionId: "s1", agentId: "a1", agentName: "运维",
  reason: "部署完了", chat: "dm", expiresTs: 1_700_000_045_000,
};
const incoming = (ring: RingPush = RING) => ({ type: "incoming" as const, ring });
const run = (...events: Parameters<typeof reduceCallKit>[1][]): CallKitState => events.reduce(reduceCallKit, CALLKIT_IDLE);

describe("callKitEventOf：原生发上来的东西不信", () => {
  it("六种事件各认一遍", () => {
    expect(callKitEventOf({ type: "token", token: "ab" })).toEqual({ type: "token", token: "ab" });
    expect(callKitEventOf({ type: "incoming", ring: RING })).toEqual({ type: "incoming", ring: RING });
    expect(callKitEventOf({ type: "answer", ringId: "r1" })).toEqual({ type: "answer", ringId: "r1" });
    expect(callKitEventOf({ type: "end", ringId: "r1", answered: false, reason: "user" }))
      .toEqual({ type: "end", ringId: "r1", answered: false, reason: "user" });
    expect(callKitEventOf({ type: "mute", ringId: "r1", muted: true })).toEqual({ type: "mute", ringId: "r1", muted: true });
    expect(callKitEventOf({ type: "audio", active: true })).toEqual({ type: "audio", active: true });
  });
  it("缺字段 / 类型不对 / 认不出的 type / ring 验不过 → null", () => {
    expect(callKitEventOf(null)).toBeNull();
    expect(callKitEventOf({ type: "token", token: "" })).toBeNull();
    expect(callKitEventOf({ type: "incoming", ring: { ...RING, ringId: 3 } })).toBeNull();
    expect(callKitEventOf({ type: "answer" })).toBeNull();
    expect(callKitEventOf({ type: "end", ringId: "r1", answered: "no", reason: "user" })).toBeNull();
    expect(callKitEventOf({ type: "end", ringId: "r1", answered: false, reason: "whatever" })).toBeNull();
    expect(callKitEventOf({ type: "audio", active: 1 })).toBeNull();
    expect(callKitEventOf({ type: "hello" })).toBeNull();
  });
});

describe("reduceCallKit", () => {
  it("来电 → 接听：算系统来电进行中；音频交过来之前还不能开麦", () => {
    const s = run(incoming(), { type: "answer", ringId: "r1" });
    expect(inSystemCall(s)).toBe(true);
    expect(systemAudioReady(s, "r1")).toBe(false);
    const t = reduceCallKit(s, { type: "audio", active: true });
    expect(systemAudioReady(t, "r1")).toBe(true);
    expect(systemAudioReady(t, "other")).toBe(false);
  });
  it("只在响、没接：不算进行中", () => {
    expect(inSystemCall(run(incoming()))).toBe(false);
  });
  it("同一通重复来：不覆盖（已接的那通不能被一条重投的推送打回「在响」）", () => {
    const s = run(incoming(), { type: "answer", ringId: "r1" }, incoming());
    expect(s.calls.get("r1")?.answered).toBe(true);
  });
  it("结束：从账上拿掉；一通都不剩时音频也归零", () => {
    const s = run(incoming(), { type: "answer", ringId: "r1" }, { type: "audio", active: true },
      { type: "end", ringId: "r1", answered: true, reason: "user" });
    expect(s.calls.size).toBe(0);
    expect(s.audioActive).toBe(false);
    expect(inSystemCall(s)).toBe(false);
  });
  it("不认识的 ringId：原样返回同一个对象", () => {
    const s = run(incoming());
    expect(reduceCallKit(s, { type: "answer", ringId: "nope" })).toBe(s);
    expect(reduceCallKit(s, { type: "end", ringId: "nope", answered: false, reason: "user" })).toBe(s);
  });
});

describe("onVoiceCall：App 这边的通话结束了，系统来电跟着结束", () => {
  const answered = run(incoming(), { type: "answer", ringId: "r1" });
  it("还没见过通话开起来：关着不算结束（房间刚连上、还没拉进通话）", () => {
    const r = onVoiceCall(answered, "s1", false);
    expect(r.ended).toEqual([]);
    expect(r.state).toBe(answered);
  });
  it("开起来过、之后关了 → 结束这一通并从账上拿掉", () => {
    const opened = onVoiceCall(answered, "s1", true).state;
    expect(opened.calls.get("r1")?.sawVoiceCall).toBe(true);
    const r = onVoiceCall(opened, "s1", false);
    expect(r.ended).toEqual(["r1"]);
    expect(r.state.calls.size).toBe(0);
  });
  it("别的会话、没接的来电：不管", () => {
    expect(onVoiceCall(answered, "other", false).ended).toEqual([]);
    const ringing = run(incoming());
    expect(onVoiceCall(onVoiceCall(ringing, "s1", true).state, "s1", false).ended).toEqual([]);
  });
});
