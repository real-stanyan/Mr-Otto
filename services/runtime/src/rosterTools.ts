// bring_agent / dismiss_agent —— 管理员把一只专员拉进这条对话 / 请出去（#1571 第二轮拍板第 3 条，ADR-0366）。
//
// 新口径：人只对人和自己的管理员说话；谁在场由管理员定。拉进来之后，在这条对话里人可以直接回它
// （对话权跟着在场），管理员请出去之后又不能。只能拉 L1（专员）：L2 子工由它的上级在自己那条线上用，
// 不进主人的对话（ADR-0047 的「子 agent 不往上露」在这里的样子）。
// 不过审批门——拉人的是管理员，它那一轮已经付过价，而拉进来的后果人立刻看得见（名单多一只、时间线一行）。
//
// 只依赖注入的几个回调（硬规则「工具只依赖接口」）：不知道 store、不知道 Supabase。参数是**名字**：模型看得见的只有名字。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { TIER_LABEL, tierOf, type TieredAgent } from "../../../src/shared/agentTier.js";
import { ADMIN_AGENT_ID, normalizeAgentName } from "../../../src/shared/workspaceAgents.js";

export const BRING_AGENT_TOOL_NAME = "bring_agent";
export const DISMISS_AGENT_TOOL_NAME = "dismiss_agent";

export interface RosterToolDeps {
  /** 主场的全部智能体（现取、带等级），不是这条对话的名单 */
  team: () => Promise<(TieredAgent & { name: string; degraded?: true })[]>;
  /** 这条对话此刻的名单（agentId） */
  current: () => readonly string[];
  /** 落新名单。回错误句子 = 没改成（调用方翻成工具报错） */
  apply: (agentIds: string[]) => Promise<string | null>;
}

export function createRosterTools(deps: RosterToolDeps): { bring: Tool; dismiss: Tool } {
  const find = async (raw: unknown, what: string) => {
    if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${what}: 参数 name 必须是非空字符串`);
    const name = normalizeAgentName(raw);
    const team = await deps.team();
    if (team.some((a) => a.degraded)) throw new Error("智能体名单这会儿读不出来，稍后再试");
    const target = team.find((a) => normalizeAgentName(a.name) === name);
    if (!target) throw new Error(`没有叫「${name}」的智能体。没有合适的专员就用 create_agent 建一只（先说清域）`);
    return target;
  };
  const bring: Tool = {
    def: {
      name: BRING_AGENT_TOOL_NAME,
      description:
        "把一只专员拉进这条对话。拉进来之后在回复里 @ 它的名字就能把事交给它，主人也能直接跟它说话；" +
        "只能拉专员（不能拉子工——子工由它的上级在自己那条线上用）。事办完、不再需要它时用 dismiss_agent 请出去。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "专员的名字（花名册里的那个，不含 @）" } },
        required: ["name"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const target = await find((args as { name?: unknown } | null)?.name, BRING_AGENT_TOOL_NAME);
      if (target.agentId === ADMIN_AGENT_ID) return "你自己就在这条对话里。";
      if (tierOf(target) !== 1) throw new Error(`「${target.name}」是${TIER_LABEL[tierOf(target)]}，不能拉进对话——只能拉专员`);
      const cur = deps.current();
      if (cur.includes(target.agentId)) return `「${target.name}」已经在这条对话里了，直接 @${target.name} 就行。`;
      const err = await deps.apply([...cur, target.agentId]);
      if (err !== null) throw new Error(err);
      return `已把「${target.name}」拉进这条对话。在回复里 @${target.name} 把事交给它，说清要办什么、什么时候要。`;
    },
  };
  const dismiss: Tool = {
    def: {
      name: DISMISS_AGENT_TOOL_NAME,
      description: "把一只专员请出这条对话（事办完了、或拉错了）。请出去之后主人在这里 @ 不到它，它的事回到你手上。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "专员的名字（不含 @）" } },
        required: ["name"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const target = await find((args as { name?: unknown } | null)?.name, DISMISS_AGENT_TOOL_NAME);
      if (target.agentId === ADMIN_AGENT_ID) throw new Error("管理员不能把自己请出去");
      const cur = deps.current();
      if (!cur.includes(target.agentId)) return `「${target.name}」本来就不在这条对话里。`;
      const err = await deps.apply(cur.filter((id) => id !== target.agentId));
      if (err !== null) throw new Error(err);
      return `已把「${target.name}」请出这条对话。`;
    },
  };
  return { bring, dismiss };
}
