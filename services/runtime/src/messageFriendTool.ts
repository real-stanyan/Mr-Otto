// message_friend —— 派智能体给主人的好友发一条私聊消息（#1549）。call_friend 的姊妹刀：同一套「这一轮能不能」的闸、
// 同一套好友解析与档位（在 outreachHub.message 里），只是不响铃——以主人名义往 messages 表里写一条，正文带
// 「[<智能体> 代发]」前缀，收信人一眼看得出不是本人敲的。这里只管参数与闸。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { CALL_FRIEND_TOOL_NAME, FRIEND_MESSAGE_MAX, MESSAGE_FRIEND_TOOL_NAME } from "../../../src/shared/outreach.js";

export interface MessageFriendDeps {
  /** 这一轮能不能发：主人本人亲口点起、不是接力、不是汇报轮。不能时回那句人话 */
  maySend: () => string | null;
  dispatch: (friend: string, text: string) => Promise<string>;
}

export function createMessageFriendTool(deps: MessageFriendDeps): Tool {
  const str = (args: unknown, k: string): string => {
    const v = (args as Record<string, unknown> | null)?.[k];
    if (typeof v !== "string") throw new Error(`message_friend: 参数 ${k} 必须是字符串`);
    return v;
  };
  return {
    def: {
      name: MESSAGE_FRIEND_TOOL_NAME,
      description:
        "替用户给他的一位好友发一条文字消息：落在用户与那位好友的私聊里，对方手机会收到通知，消息前面标着是你代发的。" +
        "只在用户亲口让你给某位好友发消息、转达一件事时用。发出去就撤不回；对方回不回、什么时候回你看不到，别替用户许诺回复。" +
        `要实时一问一答才用 ${CALL_FRIEND_TOOL_NAME} 打电话，转达一句话就发消息。`,
      parameters: {
        type: "object",
        properties: {
          friend: { type: "string", description: "好友的名字，照用户说的写" },
          text: { type: "string", description: `要发的正文（${FRIEND_MESSAGE_MAX} 字以内）：照用户要转达的意思写，口语，别加用户没说的内容；可以换行` },
        },
        required: ["friend", "text"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const friend = str(args, "friend").replace(/\s+/gu, " ").trim();
      if (friend === "") throw new Error("message_friend: friend 不能是空的");
      // 正文保留换行（私聊里多行是常态），只去头尾空白、把连续空行压成一个
      const text = str(args, "text").replace(/\r\n?/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
      if (text === "") throw new Error("message_friend: text 不能是空的");
      if ([...text].length > FRIEND_MESSAGE_MAX) throw new Error(`message_friend: text 超过 ${FRIEND_MESSAGE_MAX} 字了，缩短一点，或者分两条`);
      const no = deps.maySend();
      if (no !== null) return no;
      return deps.dispatch(friend, text);
    },
  };
}
