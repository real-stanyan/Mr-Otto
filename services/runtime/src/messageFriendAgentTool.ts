// message_friend_agent —— 车道里的智能体给对面主人公开的智能体发一句话（#1542，ADR-0358）。只管参数与「说什么」，
// 找对面的车道、落话、封顶都在 laneBridge 里（注入的 send）。只说话、不动任何人的东西：requiresApproval 为假，
// 而且客人点起的轮里也不掀成要批（它的副作用是对面车道里多一句两个人都看得到的话，与回话是同一种东西）。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { BRIDGE_TEXT_MAX, MESSAGE_FRIEND_AGENT_TOOL_NAME } from "../../../src/shared/laneBridge.js";

export interface MessageFriendAgentDeps {
  /** 发一句给对面的智能体；回给模型的那句话（发成了 / 为什么没发成） */
  send: (text: string, agent: string | undefined) => Promise<string>;
}

export function createMessageFriendAgentTool(deps: MessageFriendAgentDeps): Tool {
  return {
    def: {
      name: MESSAGE_FRIEND_AGENT_TOOL_NAME,
      description:
        "给对面那位朋友公开的智能体发一句话（它住在朋友的电脑上，回话会出现在这条私聊里，你们两位主人都看得到）。" +
        "用在主人让你去跟对方的智能体商量、要资料、交接的时候。一句说清要什么、为什么；别替主人答应任何事。" +
        "这是异步的：发出去先回主人一句，对方智能体的回话到了系统会再叫你。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: `要对它说的话（${BRIDGE_TEXT_MAX} 字以内）` },
          agent: { type: "string", description: "对面哪一只（名字）。对面只公开了一只时可以不填" },
        },
        required: ["text"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld): Promise<string> {
      const a = (args ?? {}) as Record<string, unknown>;
      const text = typeof a.text === "string" ? a.text.replace(/\s+/gu, " ").trim() : "";
      if (text === "") throw new Error("message_friend_agent: text 不能是空的");
      if (text.length > BRIDGE_TEXT_MAX) throw new Error(`message_friend_agent: text 最多 ${BRIDGE_TEXT_MAX} 字（收到 ${text.length} 字）`);
      const agent = typeof a.agent === "string" && a.agent.trim() !== "" ? a.agent.trim() : undefined;
      return deps.send(text, agent);
    },
  };
}
