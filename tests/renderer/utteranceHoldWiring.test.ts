// store.ts 的语音那一段没法在 vitest 里真跑（要 window.otter、要 helper 的事件流）。
// 状态机本身在 utteranceHold.test.ts 里钉死了；这里钉的是接线里三条**漏了不会报错**的：
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../src/renderer/src/store.ts", import.meta.url), "utf8");

describe("store.ts：语音扣住/合并的接线（#1281）", () => {
  it("开关读的是 endpoint 这一处", () => {
    expect(src).toMatch(/modeOf\(.*"endpoint"\)/);
  });
  it("没开时 final 直接发，不经状态机（零额外延迟由构造保证）", () => {
    expect(src).toMatch(/===\s*"off"\)\s*sendSpoken\(/);
  });
  it("只有 on 才真扣（shadow 照问、不扣）", () => {
    expect(src).toMatch(/hold:\s*[A-Za-z]+\s*===\s*"on"/);
  });
  it("关麦时把扣着的那句发出去", () => {
    expect(src).toMatch(/type:\s*"reset"/);
  });
});
