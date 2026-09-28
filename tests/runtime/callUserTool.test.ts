// call_user —— 回电那把刀（#1411，spec §2.1）。它只管参数与「有没有人可打」，别的都在 callRinger 里。
import { describe, expect, it } from "vitest";
import { createCallUserTool } from "../../services/runtime/src/callUserTool.js";
import { CALL_USER_TOOL_NAME } from "../../src/shared/callRing.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;

describe("call_user", () => {
  it("名字、参数、不过审批门", () => {
    const t = createCallUserTool({ initiator: () => "u1", ring: async () => "" });
    expect(t.def.name).toBe(CALL_USER_TOOL_NAME);
    expect(t.def.parameters).toMatchObject({ required: ["reason"] });
    expect(t.requiresApproval).toBe(false);
  });

  it("reason 不是字符串 / 规整完是空的：抛错（让模型改参数）", async () => {
    const t = createCallUserTool({ initiator: () => "u1", ring: async () => "打了" });
    await expect(t.run({ reason: 3 }, world)).rejects.toThrow("reason");
    await expect(t.run({ reason: " \n " }, world)).rejects.toThrow("reason");
  });

  it("这一轮不是人叫起来的：不打，回一句", async () => {
    const calls: string[] = [];
    for (const who of [null, "system", ""]) {
      const t = createCallUserTool({ initiator: () => who, ring: async (to) => { calls.push(to); return "打了"; } });
      expect(await t.run({ reason: "部署完了" }, world)).toContain("没人可打");
    }
    expect(calls).toEqual([]);
  });

  it("打给叫起这一轮的那个人，reason 先规整", async () => {
    const calls: [string, string][] = [];
    const t = createCallUserTool({ initiator: () => "u1", ring: async (to, reason) => { calls.push([to, reason]); return "已经打过去了"; } });
    expect(await t.run({ reason: "部署完了\n  要你拍板" }, world)).toBe("已经打过去了");
    expect(calls).toEqual([["u1", "部署完了 要你拍板"]]);
  });
});
