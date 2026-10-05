// reply_to_friend —— 主人在管理员私聊里回朋友带来的话，管理员把它送回和那位朋友的外联那条线（#1655）。
// message_friend 的姊妹刀：同一套「这一轮能不能」的闸（主人亲口、非监督轮）、同一套好友解析与档位（在 outreachHub.replyToFriend 里）。
// 区别只在落点：message_friend 写进人与人的私聊；这把落回朋友和你聊的那条线，由你在那边转告
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { FRIEND_MESSAGE_MAX, MESSAGE_FRIEND_TOOL_NAME, REPLY_TO_FRIEND_TOOL_NAME } from "../../../src/shared/outreach.js";

export interface ReplyToFriendDeps {
  maySend: () => string | null;
  dispatch: (friend: string, text: string) => Promise<string>;
}

export function createReplyToFriendTool(deps: ReplyToFriendDeps): Tool {
  const str = (args: unknown, k: string): string => {
    const v = (args as Record<string, unknown> | null)?.[k];
    if (typeof v !== "string") throw new Error(`reply_to_friend: 参数 ${k} 必须是字符串`);
    return v;
  };
  return {
    def: {
      name: REPLY_TO_FRIEND_TOOL_NAME,
      description:
        "把主人的回话送回给之前托你带话的那位朋友：落在朋友和你聊的那条线上，你会在那边转告，朋友手机会收到通知。" +
        "只在主人亲口让你回朋友带来的话时用（「告诉他…」「跟他说行」）。" +
        `朋友没托你带过话、或者主人要主动找朋友，用 ${MESSAGE_FRIEND_TOOL_NAME}。`,
      parameters: {
        type: "object",
        properties: {
          friend: { type: "string", description: "那位朋友的名字，照主人说的写" },
          text: { type: "string", description: `主人要回的话（${FRIEND_MESSAGE_MAX} 字以内），照主人的意思写，别加料` },
        },
        required: ["friend", "text"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld): Promise<string> {
      const friend = str(args, "friend").replace(/\s+/gu, " ").trim();
      if (friend === "") throw new Error("reply_to_friend: friend 不能是空的");
      const text = str(args, "text").replace(/\r\n?/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
      if (text === "") throw new Error("reply_to_friend: text 不能是空的");
      if ([...text].length > FRIEND_MESSAGE_MAX) throw new Error(`reply_to_friend: text 超过 ${FRIEND_MESSAGE_MAX} 字了，缩短一点`);
      const no = deps.maySend();
      if (no !== null) return no;
      return deps.dispatch(friend, text);
    },
  };
}
