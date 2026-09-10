import { describe, expect, it } from "vitest";
import { modelStatusText } from "../../src/renderer/src/lib/cloudModelStatus.js";

// ADR-0233：云会话统一走所有者订阅额度，这一格只读路由——没有自带 key 那半边可画。
// #1052（ADR-0246）：判据再收一次——**只在起不了 turn 的时候出现**，正常那两态不画。
describe("modelStatusText（#945 → ADR-0233 → #1052）", () => {
  it("hosted：一格都不画（「一切正常」不需要常驻标签）", () => {
    expect(modelStatusText({ kind: "hosted", model: "deepseek-flash" })).toBeNull();
  });
  it("route 探不到（null）：也不画——它自己那句话就是「turn 照跑」，不可行动", () => {
    expect(modelStatusText(null)).toBeNull();
  });
  it("blocked：留着，说的是所有者的订阅 / 额度，不再提 key", () => {
    const r = modelStatusText({ kind: "blocked" });
    expect(r).not.toBeNull();
    expect(r!.short).toBe("没有可用的模型");
    expect(r!.full).toMatch(/订阅/);
    expect(r!.full).not.toMatch(/key/i);
  });
  // 保鲜期：这一格活着的唯一理由是「它挡住干活」。哪天有人给正常态加回一句话，
  // 这条会红——而那正是 #1052 要拆掉的东西
  it("画得出来的只有 blocked 一种", () => {
    const routes = [{ kind: "hosted", model: "x" } as const, { kind: "blocked" } as const, null];
    expect(routes.filter((r) => modelStatusText(r) !== null)).toEqual([{ kind: "blocked" }]);
  });
});
