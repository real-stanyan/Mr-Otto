// call_friend —— 派智能体给主人的好友打电话（#1441，spec §3）。只管参数与「这一轮能不能打」，
// 解析好友、几种不打、建会话、响铃都在 outreachHub 里（注入的 dispatch）。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { RING_OPENING_MAX, normalizeRingOpening } from "../../../src/shared/callRing.js";
import { CALL_FRIEND_TOOL_NAME, OUTREACH_BRIEF_MAX } from "../../../src/shared/outreach.js";

export interface CallFriendDeps {
  /** 这一轮能不能打：主人本人亲口点起、不是接力、不是汇报轮。不能时回那句人话 */
  mayCall: () => string | null;
  dispatch: (friend: string, brief: string, opening: string) => Promise<string>;
}

export function createCallFriendTool(deps: CallFriendDeps): Tool {
  const str = (args: unknown, k: string): string => {
    const v = (args as Record<string, unknown> | null)?.[k];
    if (typeof v !== "string") throw new Error(`call_friend: 参数 ${k} 必须是字符串`);
    const flat = v.replace(/\s+/gu, " ").trim();
    if (flat === "") throw new Error(`call_friend: ${k} 不能是空的`);
    return flat;
  };
  return {
    def: {
      name: CALL_FRIEND_TOOL_NAME,
      description:
        "替用户给他的一位好友打电话（好友的手机会响，接起来和你语音对话）。只在用户亲口让你去联系某位好友时用。" +
        "电话是异步的：打出去你就先回用户一句；聊完（或没接）系统会把通话记录带回这条聊天，到时你再汇报。" +
        "通话里你没有任何工具，所以把要问、要说的事在 brief 里写全。",
      parameters: {
        type: "object",
        properties: {
          friend: { type: "string", description: "好友的名字，照用户说的写" },
          brief: { type: "string", description: "用户交代的事（500 字以内）：要问什么、要转达什么、哪些不要说。只给通话里的你看" },
          opening: { type: "string", description: "好友接起来之后你先说的那段话（200 字以内）：说清你是谁的智能体、为什么事打来。口语，别用列表和记号" },
        },
        required: ["friend", "brief", "opening"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const friend = str(args, "friend");
      const brief = str(args, "brief");
      if ([...brief].length > OUTREACH_BRIEF_MAX) throw new Error(`call_friend: brief 超过 ${OUTREACH_BRIEF_MAX} 字了，缩短一点`);
      const opening = normalizeRingOpening(str(args, "opening"));
      if ([...opening].length > RING_OPENING_MAX) throw new Error(`call_friend: opening 超过 ${RING_OPENING_MAX} 字了，缩短一点（念出来的话宜短）`);
      const no = deps.mayCall();
      if (no !== null) return no;
      return deps.dispatch(friend, brief, opening);
    },
  };
}
