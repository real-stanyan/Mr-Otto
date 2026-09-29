// call_user —— 回电那把刀（#1411，spec §2.1）。它只管参数与「有没有人可打」，别的都在 callRinger 里。
import { describe, expect, it } from "vitest";
import { createCallUserTool } from "../../services/runtime/src/callUserTool.js";
import { CALL_USER_TOOL_NAME, RING_OPENING_MAX } from "../../src/shared/callRing.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;

describe("call_user", () => {
  it("名字、参数、不过审批门", () => {
    const t = createCallUserTool({ initiator: () => "u1", ring: async () => "" });
    expect(t.def.name).toBe(CALL_USER_TOOL_NAME);
    expect(t.def.parameters).toMatchObject({ required: ["reason", "opening"] });
    expect(t.requiresApproval).toBe(false);
  });

  it("reason 不是字符串 / 规整完是空的：抛错（让模型改参数）", async () => {
    const t = createCallUserTool({ initiator: () => "u1", ring: async () => "打了" });
    await expect(t.run({ reason: 3, opening: "部署好了，你看一下。" }, world)).rejects.toThrow("reason");
    await expect(t.run({ reason: " \n ", opening: "部署好了，你看一下。" }, world)).rejects.toThrow("reason");
  });

  it("opening 不是字符串 / 规整完是空的 / 超过 200 字：抛错，不打", async () => {
    const calls: string[] = [];
    const t = createCallUserTool({ initiator: () => "u1", ring: async (to) => { calls.push(to); return "打了"; } });
    await expect(t.run({ reason: "好了" }, world)).rejects.toThrow("opening");
    await expect(t.run({ reason: "好了", opening: " \n " }, world)).rejects.toThrow("opening");
    await expect(t.run({ reason: "好了", opening: "字".repeat(RING_OPENING_MAX + 1) }, world)).rejects.toThrow("200");
    expect(await t.run({ reason: "好了", opening: "字".repeat(RING_OPENING_MAX) }, world)).toBe("打了");
    expect(calls).toEqual(["u1"]);
  });

  it("这一轮不是人叫起来的：不打，回一句", async () => {
    const calls: string[] = [];
    for (const who of [null, "system", ""]) {
      const t = createCallUserTool({ initiator: () => who, ring: async (to) => { calls.push(to); return "打了"; } });
      expect(await t.run({ reason: "部署完了", opening: "部署好了，你看一下。" }, world)).toContain("没人可打");
    }
    expect(calls).toEqual([]);
  });

  it("打给叫起这一轮的那个人，reason 与 opening 先规整", async () => {
    const calls: [string, string, string][] = [];
    const t = createCallUserTool({ initiator: () => "u1", ring: async (to, reason, opening) => { calls.push([to, reason, opening]); return "已经打过去了"; } });
    expect(await t.run({ reason: "部署完了\n  要你拍板", opening: "  部署好了，\n 你看一下。 " }, world)).toBe("已经打过去了");
    expect(calls).toEqual([["u1", "部署完了 要你拍板", "部署好了， 你看一下。"]]);
  });
});
