// reply_to_friend —— 主人在管理员私聊里回朋友的话，管理员送回外联那条线（#1655）。闸同 message_friend
import { describe, expect, it } from "vitest";
import { createReplyToFriendTool } from "../../services/runtime/src/replyToFriendTool.js";
import { FRIEND_MESSAGE_MAX, MESSAGE_FRIEND_TOOL_NAME, REPLY_TO_FRIEND_TOOL_NAME } from "../../src/shared/outreach.js";

const mk = (maySend: () => string | null = () => null) => {
  const calls: [string, string][] = [];
  const tool = createReplyToFriendTool({ maySend, dispatch: async (f, t) => (calls.push([f, t]), "送到了") });
  return { tool, calls };
};

describe("reply_to_friend", () => {
  it("名字、两个必填、直接暴露、不走审批门；描述和 message_friend 分工说清", () => {
    const { tool } = mk();
    expect(tool.def.name).toBe(REPLY_TO_FRIEND_TOOL_NAME);
    expect(tool.def.parameters).toMatchObject({ required: ["friend", "text"] });
    expect(tool.requiresApproval).toBe(false);
    expect(tool.def.description).toContain(MESSAGE_FRIEND_TOOL_NAME);
    expect(tool.def.description).toContain("带话");
  });
  it("规整参数后 dispatch", async () => {
    const { tool, calls } = mk();
    expect(await tool.run({ friend: " Stan ", text: " 行\r\n\r\n\r\n钥匙在门口 " }, null as never)).toBe("送到了");
    expect(calls).toEqual([["Stan", "行\n\n钥匙在门口"]]);
  });
  it("这一轮不能发：回 maySend 那句，不 dispatch", async () => {
    const { tool, calls } = mk(() => "只有他本人亲口让你回才行。");
    expect(await tool.run({ friend: "Stan", text: "行" }, null as never)).toBe("只有他本人亲口让你回才行。");
    expect(calls).toEqual([]);
  });
  it("空 / 超长抛错", async () => {
    const { tool } = mk();
    await expect(tool.run({ friend: "", text: "行" }, null as never)).rejects.toThrow("不能是空的");
    await expect(tool.run({ friend: "Stan", text: "字".repeat(FRIEND_MESSAGE_MAX + 1) }, null as never)).rejects.toThrow(String(FRIEND_MESSAGE_MAX));
  });
});
