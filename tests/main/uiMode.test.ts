import { describe, expect, it } from "vitest";
import { codingUiFromEnv } from "../../src/main/uiMode.js";

describe("codingUiFromEnv（#1386：写代码那一半先藏起来）", () => {
  it("默认不画——没设这个变量就是微信式的聊天界面", () => {
    expect(codingUiFromEnv({})).toBe(false);
  });

  it("只认字面量 1：别的写法一律当没开（真值有好几种写法，就会有人以为关掉了而实际开着）", () => {
    expect(codingUiFromEnv({ OTTO_CODING: "1" })).toBe(true);
    for (const v of ["0", "", "true", "yes", " 1", "1 "]) {
      expect(codingUiFromEnv({ OTTO_CODING: v })).toBe(false);
    }
  });
});
