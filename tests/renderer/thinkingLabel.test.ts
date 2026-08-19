import { describe, it, expect } from "vitest";
import { thinkingLabel } from "../../src/renderer/src/lib/thinkingLabel.js";

describe("thinkingLabel", () => {
  it("没有耗时(旧日志/非流式)就只报字数——缺席不是 0,不许编", () => {
    expect(thinkingLabel("一二三")).toBe("思考 3 字");
  });

  it("有耗时就一起报", () => {
    expect(thinkingLabel("一二三", 6200)).toBe("思考 3 字 · 6.2s");
  });

  it("不到一秒用毫秒,别显示 0.0s", () => {
    expect(thinkingLabel("一二三", 420)).toBe("思考 3 字 · 420ms");
  });

  it("正好一秒走秒", () => {
    expect(thinkingLabel("一", 1000)).toBe("思考 1 字 · 1.0s");
  });

  it("负数是坏数据,只报字数", () => {
    expect(thinkingLabel("一二", -5)).toBe("思考 2 字");
  });

  it("超过一小时是坏数据(时钟跳变/挂起),只报字数", () => {
    expect(thinkingLabel("一二", 3_600_001)).toBe("思考 2 字");
  });

  it("零毫秒是合法的(快得测不出),照报", () => {
    expect(thinkingLabel("一二", 0)).toBe("思考 2 字 · 0ms");
  });
});
