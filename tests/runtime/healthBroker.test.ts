// 健康读取的定向往返（#1656）：能力表、请求只发给那一条 cid、四种收场（回帧 / 超时 / abort / 断开）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHealthBroker, HEALTH_TIMEOUT_MS } from "../../services/runtime/src/healthBroker.js";
import type { CsDown } from "../../src/shared/remote/cloudSession.js";
import type { HealthQuery } from "../../src/shared/health.js";

const Q: HealthQuery = { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" };
const OK = { ok: true as const, days: [{ date: "2026-10-04", steps: 1 }], workouts: [] };

function setup() {
  const sent: { cid: string; msg: CsDown }[] = [];
  let n = 0;
  const broker = createHealthBroker({ send: (cid, msg) => sent.push({ cid, msg }), newId: () => `r${++n}` });
  return { broker, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("能力表", () => {
  it("cidOf 取这个 uid 最近声明的那一条；关掉 / 断开就摘", () => {
    const { broker } = setup();
    expect(broker.cidOf("u1")).toBeNull();
    broker.setCaps("c1", "u1", true);
    broker.setCaps("c2", "u1", true);
    broker.setCaps("c3", "u2", true);
    expect(broker.cidOf("u1")).toBe("c2");
    broker.setCaps("c2", "u1", false);
    expect(broker.cidOf("u1")).toBe("c1");
    broker.gone("c1");
    expect(broker.cidOf("u1")).toBeNull();
    expect(broker.cidOf("u2")).toBe("c3");
  });
  it("同一条 cid 再声明一次会挪到最新", () => {
    const { broker } = setup();
    broker.setCaps("c1", "u1", true);
    broker.setCaps("c2", "u1", true);
    broker.setCaps("c1", "u1", true);
    expect(broker.cidOf("u1")).toBe("c1");
  });
});

describe("request", () => {
  it("只发给那一条 cid；那条 cid 回帧就收场", async () => {
    const { broker, sent } = setup();
    const p = broker.request("c1", Q);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "health_query", reqId: "r1", query: Q } }]);
    expect(broker.resolve("c1", "r1", OK)).toBe(true);
    await expect(p).resolves.toEqual(OK);
  });
  it("别的 cid 冒充回帧：不认", async () => {
    const { broker } = setup();
    const p = broker.request("c1", Q);
    expect(broker.resolve("c2", "r1", OK)).toBe(false);
    expect(broker.resolve("c1", "nope", OK)).toBe(false);
    expect(broker.resolve("c1", "r1", OK)).toBe(true);
    await expect(p).resolves.toEqual(OK);
  });
  it("超时", async () => {
    const { broker } = setup();
    const p = broker.request("c1", Q);
    vi.advanceTimersByTime(HEALTH_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ ok: false, error: "手机 30 秒没回" });
    expect(broker.resolve("c1", "r1", OK)).toBe(false);
  });
  it("那条 cid 断开", async () => {
    const { broker } = setup();
    const p = broker.request("c1", Q);
    broker.gone("c1");
    await expect(p).resolves.toEqual({ ok: false, error: "手机断开了" });
  });
  it("turn 被停", async () => {
    const { broker } = setup();
    const ac = new AbortController();
    const p = broker.request("c1", Q, ac.signal);
    ac.abort();
    await expect(p).resolves.toEqual({ ok: false, error: "这一轮被停了" });
  });
  it("已经 abort 的信号：不发帧直接收场", async () => {
    const { broker, sent } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(broker.request("c1", Q, ac.signal)).resolves.toEqual({ ok: false, error: "这一轮被停了" });
    expect(sent).toEqual([]);
  });
});
