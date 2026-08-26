import { describe, expect, it } from "vitest";
import { skillCardLabel } from "../../src/shared/skillCard.js";

describe("skillCardLabel", () => {
  it("用户启用的：不标来源（旧日志同款，缺省即用户）", () => {
    expect(skillCardLabel({ name: "tdd" })).toBe("已启用 skill「tdd」");
    expect(skillCardLabel({ name: "tdd", source: "user" })).toBe("已启用 skill「tdd」");
  });

  it("模型启用的：标出来——用户得知道上下文里这份说明书是谁塞的", () => {
    expect(skillCardLabel({ name: "tdd", source: "model" })).toBe("Otto 启用了 skill「tdd」");
  });

  it("带参数：参数进标签", () => {
    expect(skillCardLabel({ name: "caveman", args: "ultra", source: "model" }))
      .toBe("Otto 启用了 skill「caveman」（参数：ultra）");
  });
});
