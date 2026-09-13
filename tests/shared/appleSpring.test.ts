// Apple 两参数口径（response / damping ratio）→ RN Animated.spring 吃的物理三元组。
// 钉的是换算公式本身：ω₀ = 2π / response，stiffness = ω₀²，damping = 2ζω₀，质量取 1。

import { describe, expect, it } from "vitest";
import { appleSpring } from "../../src/shared/appleSpring.js";

describe("appleSpring", () => {
  it("按下的反馈（0.15s、临界阻尼）", () => {
    expect(appleSpring(0.15)).toEqual({ stiffness: 1755, damping: 84, mass: 1 });
  });

  it("挪位置（0.4s、临界阻尼）——Apple 那张表里 PiP 的档", () => {
    expect(appleSpring(0.4)).toEqual({ stiffness: 247, damping: 31, mass: 1 });
  });

  it("带动量的收尾（0.32s、ζ 0.82）：阻尼按比例变小，劲度只看 response", () => {
    expect(appleSpring(0.32, 0.82)).toEqual({ stiffness: 386, damping: 32, mass: 1 });
    expect(appleSpring(0.32, 0.82).stiffness).toBe(appleSpring(0.32).stiffness);
    expect(appleSpring(0.32, 0.82).damping).toBeLessThan(appleSpring(0.32).damping);
  });

  it("response 越小越快：劲度更大", () => {
    expect(appleSpring(0.2).stiffness).toBeGreaterThan(appleSpring(0.4).stiffness);
  });
});
