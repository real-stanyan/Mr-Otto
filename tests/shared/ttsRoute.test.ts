// ttsRoute（#1163；#1356 A4 从主进程挪进 shared）：语音合成走不走得通、四种 blocked 各说各的话；
// 手机端用的 ttsHostedOf 把一份订阅快照翻成 routeTts 要的那一格。
import { describe, expect, it } from "vitest";
import type { BillingMe } from "../../src/shared/billing.js";
import { routeTts, ttsBlocked, ttsHostedOf } from "../../src/shared/ttsRoute.js";

// ── 语音那条路（#1163） ───────────────────────────────────────────────
//
// 与出图同形：没有「自带 key」这一档，要么走托管、要么走不通。四种 blocked 分开措辞，
// 后两种（网关不供语音 / 连不上网关）不许写成「你没订阅」——那会让一个正在付钱的人去点续费。

describe("routeTts", () => {
  const base = { hostedBaseUrl: "https://edge/llm/v1", hostedToken: "jwt" };
  const hosted = (over: Partial<{ subscribed: boolean; exhausted: boolean; resetAt: number; ttsModels: string[] }> = {}) =>
    ({ subscribed: true, exhausted: false, ttsModels: ["speech-2.8-turbo"], ...over });

  it("订阅 + 网关供 + 拿得到 JWT → 走网关的 /speech，点名清单第一款", () => {
    expect(routeTts({ ...base, hosted: hosted() })).toEqual({ kind: "hosted", url: "https://edge/llm/v1/speech", model: "speech-2.8-turbo" });
  });

  it("没订阅：说订阅，不提 key", () => {
    const r = routeTts({ ...base, hosted: hosted({ subscribed: false }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("订阅");
    expect(r.reason).not.toContain("key");
  });

  it("额度用完：报恢复时间 + 加购", () => {
    const r = routeTts({ ...base, hosted: hosted({ exhausted: true, resetAt: Date.UTC(2026, 8, 8, 6, 30) }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("额度已用完");
    expect(r.reason).toContain("加购");
  });

  it("网关一款语音模型都不供：说「不供语音」，不是「你没订阅」", () => {
    const r = routeTts({ ...base, hosted: hosted({ ttsModels: [] }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("语音");
    expect(r.reason).not.toContain("没有订阅");
  });

  it("拿不到 JWT / 网关地址：说连不上；没装配托管也走不通；额度用完排在「不供语音」前面", () => {
    for (const partial of [{ hostedBaseUrl: base.hostedBaseUrl }, { hostedToken: base.hostedToken }]) {
      const r = routeTts({ ...partial, hosted: hosted() });
      expect(r.kind).toBe("blocked");
      if (r.kind !== "blocked") continue;
      expect(r.reason).toContain("连不上");
    }
    expect(routeTts({ ...base }).kind).toBe("blocked");
    const r = routeTts({ ...base, hosted: hosted({ exhausted: true, ttsModels: [] }) });
    if (r.kind === "blocked") expect(r.reason).toContain("额度已用完");
  });
});

describe("ttsHostedOf（#1356 A4，手机端）", () => {
  const me = (over: Partial<BillingMe> = {}): BillingMe => ({
    plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
    models: [], imageModels: [], ttsModels: ["speech-2.8-turbo"], modelPlatforms: {}, ...over,
  });
  const snap = (m: BillingMe | null) => ({ me: m, fetchedAt: 0, exhausted: null });

  it("还没查到（null / me 为 null）→ undefined（ttsBlocked 据此说要订阅，调用方此时本来就不画钮）", () => {
    expect(ttsHostedOf(null)).toBeUndefined();
    expect(ttsHostedOf(snap(null))).toBeUndefined();
    expect(ttsBlocked(ttsHostedOf(null))).toContain("订阅");
  });
  it("订阅活跃：subscribed、exhausted 恒为 false（额度用完由网关的 429 当场说）、清单原样", () => {
    expect(ttsHostedOf(snap(me()))).toEqual({ subscribed: true, exhausted: false, ttsModels: ["speech-2.8-turbo"] });
    expect(ttsBlocked(ttsHostedOf(snap(me())))).toBeNull();
  });
  it("past_due / 没订阅 → subscribed false；网关不供语音 → 说不供，不说没订阅", () => {
    expect(ttsHostedOf(snap(me({ status: "past_due" })))?.subscribed).toBe(false);
    expect(ttsHostedOf(snap(me({ status: "none", plan: null })))?.subscribed).toBe(false);
    const blocked = ttsBlocked(ttsHostedOf(snap(me({ ttsModels: [] }))));
    expect(blocked).toContain("语音");
    expect(blocked).not.toContain("没有订阅");
  });
});
