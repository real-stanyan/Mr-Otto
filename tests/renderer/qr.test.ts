import { describe, expect, it } from "vitest";
import { QUIET_ZONE, qrModules } from "../../src/renderer/src/lib/qr.js";

describe("qrModules", () => {
  it("同一串字每次出同一个矩阵", () => {
    expect(qrModules("otto-pair:1:d1:x")).toEqual(qrModules("otto-pair:1:d1:x"));
  });

  it("是个正方形,而且四条边各留了四格静区(少了很多扫码器认不出)", () => {
    const m = qrModules("otto-pair:1:d1:x");
    expect(m.length).toBeGreaterThan(QUIET_ZONE * 2);
    for (const row of m) expect(row).toHaveLength(m.length);
    const dark = (y: number, x: number): boolean => m[y]![x]!;
    for (let i = 0; i < m.length; i += 1) {
      for (let q = 0; q < QUIET_ZONE; q += 1) {
        expect(dark(q, i)).toBe(false);
        expect(dark(m.length - 1 - q, i)).toBe(false);
        expect(dark(i, q)).toBe(false);
        expect(dark(i, m.length - 1 - q)).toBe(false);
      }
    }
  });

  it("真的编了东西进去:内圈有深色模块", () => {
    const m = qrModules("otto-pair:1:d1:x");
    expect(m.some((row) => row.some(Boolean))).toBe(true);
  });

  it("字越长版本越大(一张真实的配对码装得下)", () => {
    const real = `otto-pair:1:${"d".repeat(36)}:${"A".repeat(43)}:${"B".repeat(43)}`;
    expect(qrModules(real).length).toBeGreaterThan(qrModules("x").length);
  });
});
