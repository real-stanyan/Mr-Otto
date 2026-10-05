// relay_to_owner —— 外联那条线上，管理员替朋友带一句话给自己的主人（#1655）。只管参数；找主人的管理员私聊、
// 每小时封顶在 outreachHub.relayToOwner（注入的 send）。只对自己主人说话、不动任何人的东西：requiresApproval 为假，
// 朋友点起的轮里也不掀成要批（同 message_friend_agent 的论证，ADR-0358 决定 2）
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { RELAY_TEXT_MAX, RELAY_TO_OWNER_TOOL_NAME } from "../../../src/shared/outreach.js";

export interface RelayToOwnerDeps {
  /** 带一句给主人；回给模型的那句话（带到了 / 为什么没带到） */
  send: (text: string) => Promise<string>;
}

export function createRelayToOwnerTool(deps: RelayToOwnerDeps): Tool {
  return {
    def: {
      name: RELAY_TO_OWNER_TOOL_NAME,
      description:
        "替对面这位朋友带一句话给你的主人：落在你和主人的私聊里，主人手机会收到通知。" +
        "用在朋友的事要主人拍板（花钱、约时间、借东西、替主人答应什么）或朋友明说「帮我跟他说一声」的时候；你自己答得了的事实就直接答，不用带。" +
        "别替主人答应任何事：带到之后告诉朋友「已经转告了，他回了我再告诉你」。主人的回话会以系统消息回到这条线上。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: `要带的话（${RELAY_TEXT_MAX} 字以内）：照朋友的意思写清他要什么，别加料` },
        },
        required: ["text"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld): Promise<string> {
      const a = (args ?? {}) as Record<string, unknown>;
      const text = typeof a.text === "string" ? a.text.replace(/\s+/gu, " ").trim() : "";
      if (text === "") throw new Error("relay_to_owner: text 不能是空的");
      if ([...text].length > RELAY_TEXT_MAX) throw new Error(`relay_to_owner: text 最多 ${RELAY_TEXT_MAX} 字`);
      return deps.send(text);
    },
  };
}
