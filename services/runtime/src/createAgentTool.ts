// create_agent —— 管理员替用户建一只 agent（#954，spec §10 切片 6）。
//
// 必须过审批门（同 ADR-0118 的 mcp_configure）：一条 instructions 会成为一只 agent 的
// 永久 system 提示、models/tools 决定它花谁的钱动谁的连接器——这不是「功能的一个选项」。
// 审批卡逐字段的文案由 sessionService 经 approvalRouter.summarizeArgs 挂上
// （createAgentApprovalSummary），这里只管参数校验与落库。
//
// 只依赖注入的 WorkspaceAgentWriter（硬规则「工具只依赖接口」在这把刀上的体现）：
// 不知道 supabase、不知道表名。created_by 是**点火的那个人**（spec §4.2 不给 agent
// 发伪 uid）——sessionService 把 currentInitiator 递进来，查不到就拒绝而不是伪造。

import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import {
  AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX, AGENT_MODELS_MAX, CREATE_AGENT_TOOL_NAME,
  parseCreateAgentArgs, scanCreateAgentThreat,
} from "../../../src/shared/createAgentDraft.js";
import { AGENT_NAME_MAX } from "../../../src/shared/workspaceAgents.js";
import { AgentNameError, type WorkspaceAgentWriter } from "./agentRegistry.js";

export function createCreateAgentTool(deps: {
  workspaceId: string;
  /** 此刻这条 turn 是谁点起来的（sessionService 的 currentInitiator）；null = 查不到，拒绝 */
  createdBy: () => string | null;
  writer: WorkspaceAgentWriter;
  /** 个人主场：审批门前一律放行（ADR-0298），这把刀调下去就直接落库（#1280 A5）。
      **必需、没有默认值**：说明里那句「会弹审批卡请用户确认」在主场是假的，而模型信的是
      说明——它会照着宣布一步确认，然后那一步不发生（#1206 那个形状：提示词与工具表说了
      两句话）。写成可选的话，忘接线那天它安静地继续说假话，而假话本身不会让任何东西报错 */
  approveAll: boolean;
}): Tool {
  // 主场里这一段是建错之前**唯一**的一道，所以两支各说各的实话：团队那支的闸是审批卡，
  // 主场那支的闸只剩「先问清」这句请求
  const gate = deps.approveAll
    ? "调用之后直接落库，不会再弹卡请用户确认——用户点开花名册就看得见它，也能单独跟它聊。"
    : "会弹审批卡请用户确认名字、职责、型号、连接器与提示词全文，用户批准后才落库；之后群里 @ 它就能让它干活。";
  return {
    def: {
      name: CREATE_AGENT_TOOL_NAME,
      description:
        "新建一只智能体（agent）。" + gate +
        "先看你 briefing 里的花名册，别用已有的名字。" +
        "用户没说清职责或提示词时先问清楚再建；提示词写成对那只 agent 说的话（它负责什么、怎么做、不该做什么）。" +
        "调用之前先问清两件事再建：它管哪一块、要用哪些连接器（别默认全给）。" +
        "建好之后用一两句话报告：名字、职责、给了哪些连接器；告诉用户不满意可以在它的设置里改。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `群里 @ 它用的名字，1–${AGENT_NAME_MAX} 字，不含 @` },
          description: { type: "string", description: `一句话职责，≤ ${AGENT_DESCRIPTION_MAX} 字；会进别人的花名册` },
          instructions: { type: "string", description: `它的 system 提示词，≤ ${AGENT_INSTRUCTIONS_MAX} 字` },
          models: { type: "array", items: { type: "string" }, description: `允许的型号 id，按优先顺序：网关供着的第一个生效；不传 = 用团队默认；最多 ${AGENT_MODELS_MAX} 个` },
          tools: {
            type: "array",
            description: "连接器白名单：[{serverId, tools:[工具名…]}]；条目 tools 为 [] = 那台整台放行；不传 = 全部连接器都能用",
            items: {
              type: "object",
              properties: { serverId: { type: "string" }, tools: { type: "array", items: { type: "string" } } },
              required: ["serverId", "tools"],
            },
          },
        },
        required: ["name"],
      },
    },
    exposure: "direct",
    requiresApproval: true,
    async run(args: unknown, _world: ExecutionWorld) {
      const draft = parseCreateAgentArgs(args);
      const threatHit = scanCreateAgentThreat(draft);
      if (threatHit) throw new Error(`${threatHit}，拒绝创建`);
      const createdBy = deps.createdBy();
      if (createdBy === null) throw new Error("查不到这次是谁发起的，无法记录创建者；请让发起人再 @ 我一次");
      try {
        const { agentId } = await deps.writer.create(deps.workspaceId, draft, createdBy);
        return `已创建智能体「${draft.name}」（id ${agentId}）。群里从下一句起可以 @${draft.name}；它第一次开口前会收到自己的提示词与花名册。`;
      } catch (err) {
        // 名字类的错误一家都翻同一句（同名 / 前缀冲突，#957 B-I2）——两种都是"换个名字"能解决的
        if (err instanceof AgentNameError) throw new Error(`${err.message}——换一个名字再试（先看花名册里已有谁）`);
        throw err;
      }
    },
  };
}
