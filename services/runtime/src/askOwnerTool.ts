// ask_owner —— 群座位里别人使唤管理员、要动手时向它的主人要点头（#1682，ADR-0376）。
//
// 客人轮里管理员手上只有这一把刀：聊天不用它，动手之前用它。落一张点头卡（座位那份是正本、群里镜像一份、推给主人），
// 这一轮就该收了——主人点了头会落一条 seat_grant 开场白重新叫醒它，那一轮才是按主人的规矩动手的一轮。
// 只依赖注入的回调（硬规则「工具只依赖接口」）。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";

export const ASK_OWNER_TOOL_NAME = "ask_owner";
export const ASK_OWNER_SUMMARY_MAX = 200;

export interface AskOwnerDeps {
  /** 落卡、送群、推主人。回给模型读的那句（成功是「已经请…」，失败 / 重复是原因） */
  request: (summary: string) => Promise<string>;
}

export function createAskOwnerTool(deps: AskOwnerDeps): Tool {
  return {
    def: {
      name: ASK_OWNER_TOOL_NAME,
      description:
        "群里别人让你动手（查、读、写、跑命令、用应用、联系谁）时，先用它请你的主人点头。纯聊天不用它。" +
        "写清要做什么、会动到什么（一两句）。调完这一轮就在群里用对方说话的语言说一句在等主人点头，然后结束；主人点了头会再叫你。",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: `要做什么、会动到什么，${ASK_OWNER_SUMMARY_MAX} 字以内，主人看得懂的大白话——用主人平时说话的语言写（他说英文就写英文）` },
        },
        required: ["summary"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const raw = (args as { summary?: unknown } | null)?.summary;
      if (typeof raw !== "string") throw new Error("ask_owner: 参数 summary 必须是字符串");
      const summary = raw.replace(/\s+/gu, " ").trim();
      if (summary === "") throw new Error("ask_owner: summary 不能是空的");
      return deps.request([...summary].slice(0, ASK_OWNER_SUMMARY_MAX).join(""));
    },
  };
}
