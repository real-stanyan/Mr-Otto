// call_user —— 智能体打电话回给你（#1411，spec §2.1）。
//
// 推送开着时每只都挂、不过审批门（主场群里客人点起的那一轮由 sessionService 的 guestTurn() 掀成要群主批，
// #1393）。推送关着时这把刀根本不出现——不能让模型许诺一通打不出去的电话。
// 打给叫起这一轮的那个人（sessionService 的 currentInitiator；接力那一棒是点火的那个人，ADR-0223）。
// 这把刀只管参数与「有没有人可打」，几种不打、落事件、推送都在 callRinger 里（注入的 `ring`）。

import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { CALL_USER_TOOL_NAME, normalizeRingReason } from "../../../src/shared/callRing.js";

export interface CallUserDeps {
  /** 这一轮是谁叫起来的。null / "system" / 空串 = 不是人 */
  initiator: () => string | null;
  /** 打一次（sessionService 绑好这只 agent 的 id 与名字，交给 callRinger.call）。回给模型的那句话 */
  ring: (toUid: string, reason: string) => Promise<string>;
}

export function createCallUserTool(deps: CallUserDeps): Tool {
  return {
    def: {
      name: CALL_USER_TOOL_NAME,
      description:
        "给叫起这一轮的那个人打电话（他的手机会响）。什么时候打：他说过「办完打给我」就一定打；" +
        "事情办了很久、他已经不在（挂了电话、离开了聊天），或者需要他拍板时可以打；别为小事打。" +
        "reason 写一句他在锁屏上一眼能看懂的话。他接起来之后你会先开口，把事情说清楚。",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "显示在他锁屏上的一句话（60 字以内，别换行），比如「部署完了，有个配置要你拍板」" },
        },
        required: ["reason"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const raw = (args as { reason?: unknown } | null)?.reason;
      if (typeof raw !== "string") throw new Error("call_user: 参数 reason 必须是字符串");
      const reason = normalizeRingReason(raw);
      if (reason === "") throw new Error("call_user: reason 不能是空的——写一句他在锁屏上能看懂的话");
      const to = deps.initiator();
      if (to === null || to === "" || to === "system") return "这一轮不是人叫起来的，没人可打。";
      return deps.ring(to, reason);
    },
  };
}
