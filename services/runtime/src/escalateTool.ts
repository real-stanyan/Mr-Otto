// escalate_to_admin（#1659 第二轮）：专员往上转的那条路。只在「这条对话里没有管理员」时挂（sessionService 判），
// 话由 daemon 送进主人和管理员的私聊、叫起管理员那一轮（room.runEscalation）。这里只管参数、频率与回执。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { ESCALATE_TOOL_NAME, ESCALATION_PER_HOUR_MAX, ESCALATION_TEXT_MAX, escalationSentText } from "../../../src/shared/escalation.js";

export type EscalateOutcome = { ok: true; adminName: string } | { ok: false; message: string };

export interface EscalateDeps {
  agentId: string;
  agentName: () => string;
  /** taskId → 任务标题（认不出回 null，照转，只是不带标题） */
  taskTitle: (taskId: string) => string | null;
  deliver: (e: { fromAgentId: string; fromName: string; text: string; taskTitle: string | null }) => Promise<EscalateOutcome>;
  now: () => number;
  available?: () => boolean;
}

export function createEscalateTool(deps: EscalateDeps): Tool {
  const sent: number[] = [];
  return {
    def: {
      name: ESCALATE_TOOL_NAME,
      description:
        "把一件要管理员办的事转给它（管理员不在这条对话里时用）：域外的事，或你手上没有那把工具的事（排定时、给别人打电话发消息、建新的专员）。" +
        "先把你能做的那半截做完，再把要它办的写清楚：要什么、什么时候、前因（它看不到这条对话）。转完回主人一句已转，别再自己接着做这件。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: `要管理员办的事，写清楚、自己能看懂，≤ ${ESCALATION_TEXT_MAX} 字` },
          taskId: { type: "string", description: "关联的任务 id（有就带）" },
        },
        required: ["text"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    ...(deps.available ? { available: deps.available } : {}),
    async run(args: unknown, _world: ExecutionWorld) {
      const a = (args ?? {}) as Record<string, unknown>;
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (text === "") throw new Error("text 必填：写清楚要管理员办什么");
      if ([...text].length > ESCALATION_TEXT_MAX) throw new Error(`text 最多 ${ESCALATION_TEXT_MAX} 字，挑要紧的说`);
      const now = deps.now();
      while (sent.length > 0 && now - sent[0]! > 3_600_000) sent.shift();
      if (sent.length >= ESCALATION_PER_HOUR_MAX) throw new Error(`这一小时已经转了 ${ESCALATION_PER_HOUR_MAX} 次，先把手上的做完；要紧的直接跟主人说`);
      const taskTitle = typeof a.taskId === "string" && a.taskId !== "" ? deps.taskTitle(a.taskId) : null;
      const r = await deps.deliver({ fromAgentId: deps.agentId, fromName: deps.agentName(), text, taskTitle });
      if (!r.ok) throw new Error(`没转过去：${r.message}。别说已经转了——跟主人说清楚，请他去管理员那边说一声`);
      sent.push(now);
      return escalationSentText(r.adminName);
    },
  };
}
