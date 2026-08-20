import { describe, it, expect } from "vitest";
import { createRequestGate } from "../../src/renderer/src/lib/latestRequest.js";

describe("createRequestGate", () => {
  it("最后发起的那个才算数——先发后到的旧结果被判废", () => {
    const gate = createRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(second)).toBe(true);
    expect(gate.isCurrent(first)).toBe(false); // 点了 #1 又点 #2,#1 晚到也不许盖
  });

  it("只发起一个时它一直算数（不会被自己作废）", () => {
    const gate = createRequestGate();
    const t = gate.begin();
    expect(gate.isCurrent(t)).toBe(true);
    expect(gate.isCurrent(t)).toBe(true);
  });

  it("两个 gate 各记各的,互不影响", () => {
    const a = createRequestGate();
    const b = createRequestGate();
    const ta = a.begin();
    b.begin();
    expect(a.isCurrent(ta)).toBe(true);
  });
});
