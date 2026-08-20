import { describe, expect, it } from "vitest";

import { pickGreeting } from "../../src/renderer/src/lib/greeting.js";

describe("pickGreeting", () => {
  it("有名字就把名字放进去", () => {
    expect(pickGreeting("Stan", 0)).toContain("Stan");
  });

  it("没名字走另一套说法 —— 不是把带名字那几句掐掉名字", () => {
    // 掐完会剩下"，今天挖点什么？"这种断头句
    for (let i = 0; i < 10; i++) {
      const line = pickGreeting(null, i / 10);
      expect(line).not.toContain("{name}");
      expect(line.startsWith("，")).toBe(false);
    }
  });

  it("空白名字当没有名字", () => {
    expect(pickGreeting("   ", 0)).toBe(pickGreeting(null, 0));
  });

  it("名字里的空格削掉，不带进句子", () => {
    expect(pickGreeting(" Stan ", 0)).toContain("Stan，");
  });

  it("roll 越界也给得出一句话，不会算出空下标", () => {
    expect(pickGreeting("Stan", 1)).toBeTruthy();
    expect(pickGreeting("Stan", -1)).toBeTruthy();
    expect(pickGreeting(null, 999)).toBeTruthy();
  });

  it("占位符一定被替换掉", () => {
    for (let i = 0; i < 10; i++) {
      expect(pickGreeting("Stan", i / 10)).not.toContain("{name}");
    }
  });

  it("roll 在 0~1 上铺开时不同的句子都取得到", () => {
    const seen = new Set(Array.from({ length: 20 }, (_, i) => pickGreeting("Stan", i / 20)));
    expect(seen.size).toBeGreaterThan(1);
  });
});
