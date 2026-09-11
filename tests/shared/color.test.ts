// 实色加透明度（src/shared/color.ts）。手机端每一块半透明的板都从这里出来。

import { describe, expect, it } from "vitest";
import { withAlpha } from "../../src/shared/color.js";

describe("withAlpha", () => {
  it("#rrggbb：和搬家之前逐字同一个输出", () => {
    expect(withAlpha("#4a70a9", 0.5)).toBe("rgba(74, 112, 169, 0.5)");
    expect(withAlpha("#f7f5ef", 0.85)).toBe("rgba(247, 245, 239, 0.85)");
  });

  it("#rgb 简写也认", () => {
    expect(withAlpha("#fff", 0.25)).toBe("rgba(255, 255, 255, 0.25)");
  });

  it("本来就带透明度的，把透明度乘上去而不是当成不透明", () => {
    expect(withAlpha("rgba(0, 0, 0, 0.12)", 0.5)).toBe("rgba(0, 0, 0, 0.06)");
    expect(withAlpha("rgba(245, 245, 247, 0.14)", 0.5)).toBe("rgba(245, 245, 247, 0.07)");
    expect(withAlpha("rgb(1, 2, 3)", 0.3)).toBe("rgba(1, 2, 3, 0.3)");
  });

  it("认不出的原样退回，不崩", () => {
    expect(withAlpha("red", 0.5)).toBe("red");
  });
});
