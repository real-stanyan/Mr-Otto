import { describe, expect, it } from "vitest";
import { laneOf, laneValue, parseLaneValue } from "../../src/shared/modelLane.js";

describe("lane 的选单 id", () => {
  it("auto 就是裸型号 id —— 绝大多数条目不该因为这个特性变形", () => {
    expect(laneValue("deepseek-v4-flash", "auto")).toBe("deepseek-v4-flash");
  });

  it("grant 带前缀:同一款的两份在 cmdk 里得是两个 value", () => {
    expect(laneValue("deepseek-v4-flash", "grant")).toBe("grant:deepseek-v4-flash");
    expect(laneValue("deepseek-v4-flash", "grant")).not.toBe(
      laneValue("deepseek-v4-flash", "auto")
    );
  });

  it("来回一趟原样", () => {
    for (const lane of ["auto", "grant"] as const) {
      expect(parseLaneValue(laneValue("deepseek-v4-pro", lane))).toEqual({
        model: "deepseek-v4-pro",
        lane,
      });
    }
  });

  it("认不出前缀的一律 auto", () => {
    expect(parseLaneValue("glm-5.3")).toEqual({ model: "glm-5.3", lane: "auto" });
  });
});

describe("laneOf", () => {
  it("最后一条 model_changed 说了算", () => {
    expect(
      laneOf([
        { type: "model_changed", lane: "grant" },
        { type: "user_message" },
        { type: "model_changed" },
      ])
    ).toBe("auto");
  });

  it("旧日志没有这个字段 = auto（schema 向后兼容）", () => {
    expect(laneOf([{ type: "model_changed" }])).toBe("auto");
  });

  it("一次都没切过 = auto", () => {
    expect(laneOf([{ type: "user_message" }])).toBe("auto");
  });
});
