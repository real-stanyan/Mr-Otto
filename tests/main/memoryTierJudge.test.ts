import { describe, expect, it } from "vitest";
import { createMemoryTierJudge } from "../../src/main/memoryTierJudge.js";
import type { DecisionReply } from "../../src/shared/decision.js";

const says = (c: string, conf: number): DecisionReply => ({ model: "m", inputTokens: 1, answers: { e0: { type: "choice", choice: c, probabilities: { [c]: 1 }, confidence: conf } } });
const rig = (mode: "off" | "shadow" | "on", reply: DecisionReply | null) => {
  const logs: string[] = [];
  let asked = 0;
  const judge = createMemoryTierJudge({ mode: () => mode, decide: async () => { asked++; return reply; } }, (l) => logs.push(l));
  return { judge, logs, asked: () => asked };
};

describe("createMemoryTierJudge", () => {
  it("off：不问，回 null", async () => {
    const r = rig("off", says("project", 0.99));
    expect(await r.judge(["x"], "memory", "Mr_Otto")).toBeNull();
    expect(r.asked()).toBe(0);
  });
  it("on：回 mismatch", async () => {
    expect(await rig("on", says("project", 0.95)).judge(["x"], "memory", "Mr_Otto")).toEqual([{ index: 0, suggested: "project", confidence: 0.95 }]);
  });
  it("shadow：只记一行，回 null（工具那侧因此照常写）；日志里没有正文", async () => {
    const r = rig("shadow", says("project", 0.95));
    expect(await r.judge(["机密内容"], "memory", "Mr_Otto")).toBeNull();
    expect(r.logs[0]).toContain('"use":"memory"');
    expect(r.logs.join()).not.toContain("机密");
  });
  it("没问出来：null", async () => {
    expect(await rig("on", null).judge(["x"], "memory", "Mr_Otto")).toBeNull();
  });
});
