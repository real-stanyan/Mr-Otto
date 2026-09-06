import { describe, expect, it } from "vitest";
import { modelStatusText } from "../../src/renderer/src/lib/cloudModelStatus.js";

// ADR-0233：云会话统一走所有者订阅额度，这一格只读路由——没有自带 key 那半边可画
describe("modelStatusText（#945 → ADR-0233）", () => {
  it("hosted：说托管型号，不红；白名单那句要说清楚是按顺序取网关供着的", () => {
    const r = modelStatusText({ kind: "hosted", model: "deepseek-v4-flash" });
    expect(r).toEqual({ short: "deepseek-v4-flash · 托管", bad: false, full: expect.stringContaining("订阅额度") });
    expect(r.full).toContain("白名单");
  });
  it("blocked：红，说的是所有者的订阅 / 额度，不再提 key", () => {
    const r = modelStatusText({ kind: "blocked" });
    expect(r.bad).toBe(true);
    expect(r.full).toMatch(/订阅/);
    expect(r.full).not.toMatch(/key/i);
  });
  it("route 探不到（null）：不红、不说死「起不了 turn」", () => {
    const r = modelStatusText(null);
    expect(r.bad).toBe(false);
    expect(r.full).toContain("不等于起不了");
  });
});
