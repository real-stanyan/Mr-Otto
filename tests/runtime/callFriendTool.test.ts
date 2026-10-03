// call_friend —— 派智能体给主人的好友打电话那把刀（#1441）。只管参数规整与「这一轮能不能打」。
import { describe, expect, it } from "vitest";
import { createCallFriendTool, type CallFriendDeps } from "../../services/runtime/src/callFriendTool.js";
import { CALL_FRIEND_TOOL_NAME } from "../../src/shared/outreach.js";

const mk = (over: Partial<CallFriendDeps> = {}) => {
  const calls: unknown[] = [];
  const tool = createCallFriendTool({ mayCall: () => null, dispatch: async (...a) => (calls.push(a), "已经打过去了"), ...over });
  return { tool, calls };
};

describe("call_friend", () => {
  it("名字对、三个参数必填", () => {
    const { tool } = mk();
    expect(tool.def.name).toBe(CALL_FRIEND_TOOL_NAME);
    expect(tool.def.parameters).toMatchObject({ required: ["friend", "brief", "opening"] });
  });

  it("参数齐全：规整后交给 dispatch", async () => {
    const { tool, calls } = mk();
    expect(await tool.run({ friend: " 小红 ", brief: "问周五\n来不来", opening: "小红你好" }, null as never)).toBe("已经打过去了");
    expect(calls[0]).toEqual(["小红", "问周五 来不来", "小红你好"]);
  });

  it("brief 超 500 字 / opening 超 200 字：拒绝不截断，也不打", async () => {
    const a = mk();
    await expect(a.tool.run({ friend: "小红", brief: "字".repeat(501), opening: "嗨" }, null as never)).rejects.toThrow("500");
    const b = mk();
    await expect(b.tool.run({ friend: "小红", brief: "事", opening: "字".repeat(201) }, null as never)).rejects.toThrow("200");
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
    // 恰好到上限的放行
    const c = mk();
    await c.tool.run({ friend: "小红", brief: "字".repeat(500), opening: "字".repeat(200) }, null as never);
    expect(c.calls.length).toBe(1);
  });

  it("三个参数缺一个或是空串：抛错说清是哪个", async () => {
    const ok = { friend: "小红", brief: "事", opening: "嗨" };
    for (const k of ["friend", "brief", "opening"] as const) {
      const { tool, calls } = mk();
      await expect(tool.run({ ...ok, [k]: undefined }, null as never)).rejects.toThrow(k);
      await expect(tool.run({ ...ok, [k]: " \n " }, null as never)).rejects.toThrow(k);
      await expect(tool.run({ ...ok, [k]: 3 }, null as never)).rejects.toThrow(k);
      expect(calls).toEqual([]);
    }
  });

  it("这一轮不能打：回那句人话，不调 dispatch", async () => {
    const { tool, calls } = mk({ mayCall: () => "只有 Stan 亲口让你打，才能给他的好友打电话。" });
    expect(await tool.run({ friend: "小红", brief: "事", opening: "嗨" }, null as never)).toContain("亲口");
    expect(calls).toEqual([]);
  });

  it("不过审批门", () => expect(mk().tool.requiresApproval).toBe(false));
});
