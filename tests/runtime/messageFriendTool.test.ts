// message_friend —— 派智能体给主人的好友发私聊那把刀（#1549）。只管参数规整与「这一轮能不能发」。
import { describe, expect, it } from "vitest";
import { createMessageFriendTool, type MessageFriendDeps } from "../../services/runtime/src/messageFriendTool.js";
import { CALL_FRIEND_TOOL_NAME, FRIEND_MESSAGE_MAX, MESSAGE_FRIEND_TOOL_NAME } from "../../src/shared/outreach.js";

const mk = (over: Partial<MessageFriendDeps> = {}) => {
  const calls: unknown[] = [];
  const tool = createMessageFriendTool({ maySend: () => null, dispatch: async (...a) => (calls.push(a), "发了"), ...over });
  return { tool, calls };
};

describe("message_friend", () => {
  it("名字对、两个参数必填、直接暴露、不走审批门（亮不亮由 sessionService 按轮决定）", () => {
    const { tool } = mk();
    expect(tool.def.name).toBe(MESSAGE_FRIEND_TOOL_NAME);
    expect(tool.def.parameters).toMatchObject({ required: ["friend", "text"] });
    expect(tool.exposure).toBe("direct");
    expect(tool.requiresApproval).toBe(false);
    // 描述里把两把刀的分工说清：实时问答打电话、转达一句话发消息
    expect(tool.def.description).toContain(CALL_FRIEND_TOOL_NAME);
    expect(tool.def.description).toContain("代发");
  });

  it("参数齐全：名字压空白、正文保留换行只去头尾与多余空行，交给 dispatch", async () => {
    const { tool, calls } = mk();
    expect(await tool.run({ friend: " 小红 ", text: "  第一条\r\n\r\n\r\n\r\n第二条\n " }, null as never)).toBe("发了");
    expect(calls[0]).toEqual(["小红", "第一条\n\n第二条"]);
  });

  it("空的 / 不是字符串 / 超长：抛错不发", async () => {
    const a = mk();
    await expect(a.tool.run({ friend: "小红", text: "   " }, null as never)).rejects.toThrow("不能是空的");
    await expect(a.tool.run({ friend: "小红" }, null as never)).rejects.toThrow("必须是字符串");
    await expect(a.tool.run({ friend: "小红", text: "字".repeat(FRIEND_MESSAGE_MAX + 1) }, null as never)).rejects.toThrow(String(FRIEND_MESSAGE_MAX));
    expect(a.calls).toEqual([]);
  });

  it("这一轮不能发：回 maySend 的那句人话，不碰 dispatch", async () => {
    const { tool, calls } = mk({ maySend: () => "只有他本人亲口让你发才行。" });
    expect(await tool.run({ friend: "小红", text: "嗨" }, null as never)).toBe("只有他本人亲口让你发才行。");
    expect(calls).toEqual([]);
  });
});
