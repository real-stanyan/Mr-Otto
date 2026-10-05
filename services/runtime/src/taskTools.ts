// create_task / assign_task / report_task —— 任务那三把刀（#1571 第 3 步，ADR-0365 §2.4）。
//
// 任务是事件：这三把刀只落事件（task_created / task_assigned / task_progress / task_needs_owner / task_done / task_failed），
// 投影表由 sessionService 的 notify 折出来写。谁能干什么跟等级走（ADR-0365 §2.1）：
//   · create_task：L0（拆主人的要求）与 L1（拆给自己子工的）；L2 不建；
//   · assign_task：只能派给「派活方向」允许的那只（canDispatch：L0→L1、L1→自己的 L2），对方得在这条对话里；
//   · report_task：被派的那只报进度 / 收口 / 要主人拍板；建任务的那只也能收口（派不出去时自己做完）。
// 不过审批门：落的是记账事件，不动手。参数里的「人」是名字（模型看得见的只有名字）。
// 只依赖注入的几个回调（硬规则「工具只依赖接口」）：不知道 store、不知道 Supabase。
import { randomBytes } from "node:crypto";
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { canDispatch, tierOf, type TieredAgent } from "../../../src/shared/agentTier.js";
import { TASK_BRIEF_MAX, TASK_NOTE_MAX, TASK_TITLE_MAX, TASK_STATUS_TEXT, type TaskRow } from "../../../src/shared/tasks.js";
import { normalizeAgentName } from "../../../src/shared/workspaceAgents.js";
import type { TaskAssignedEvent, TaskCreatedEvent, TaskDoneEvent, TaskFailedEvent, TaskNeedsOwnerEvent, TaskProgressEvent } from "../../../src/session/events.js";

export const CREATE_TASK_TOOL_NAME = "create_task";
export const ASSIGN_TASK_TOOL_NAME = "assign_task";
export const REPORT_TASK_TOOL_NAME = "report_task";

type Loose<E> = Omit<E, "sessionId" | "seq" | "ts" | "ignorable" | "byAgentId">;
export type TaskAppend =
  | Loose<TaskCreatedEvent> | Loose<TaskAssignedEvent> | Loose<TaskProgressEvent>
  | Loose<TaskNeedsOwnerEvent> | Loose<TaskDoneEvent> | Loose<TaskFailedEvent>;

export interface TaskToolDeps {
  /** 这把刀挂在哪只的 engine 上 */
  agentId: string;
  /** 这条对话此刻的名单（带等级、带名字）：派给谁要在名单里 */
  roster: () => readonly (TieredAgent & { name: string })[];
  /** 此刻的任务（从日志折出来的那份） */
  tasks: () => ReadonlyMap<string, TaskRow>;
  /** 落一条任务事件（byAgentId 由 sessionService 填成 deps.agentId） */
  append: (e: TaskAppend) => void;
  newId?: () => string;
}

export function newTaskId(): string {
  return "t_" + randomBytes(4).toString("hex");
}

function text(v: unknown, what: string, max: number, required: boolean): string {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${what} 必填`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`${what} 必须是字符串`);
  const t = v.replace(/\s+/g, " ").trim();
  if (required && t === "") throw new Error(`${what} 不能为空`);
  if (t.length > max) throw new Error(`${what} 最多 ${max} 字`);
  return t;
}

export function createTaskTools(deps: TaskToolDeps): Tool[] {
  const me = (): TieredAgent & { name: string } => deps.roster().find((a) => a.agentId === deps.agentId) ?? { agentId: deps.agentId, name: deps.agentId };
  const taskOf = (raw: unknown): TaskRow => {
    if (typeof raw !== "string" || raw.trim() === "") throw new Error("taskId 必填");
    const t = deps.tasks().get(raw.trim());
    if (t === undefined) throw new Error(`没有 id 为「${raw}」的任务——看时间线里「[任务 t_…]」那几行`);
    return t;
  };
  const create: Tool = {
    def: {
      name: CREATE_TASK_TOOL_NAME,
      description:
        "建一个任务（记账，不动手）。主人的要求不是一句话能答完的，先拆成任务再派；子任务带 parentTaskId。" +
        "建完用 assign_task 派给专员，派不出去的自己做、做完 report_task。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: `一句话标题，≤ ${TASK_TITLE_MAX} 字` },
          brief: { type: "string", description: `要办什么、什么时候要、有什么前提，≤ ${TASK_BRIEF_MAX} 字` },
          parentTaskId: { type: "string", description: "属于哪个任务（拆出来的子任务才带）" },
        },
        required: ["title"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      if (tierOf(me()) === 2) throw new Error("子工不建任务——做完 report_task 报给上级就行");
      const a = (args ?? {}) as Record<string, unknown>;
      const title = text(a.title, "title", TASK_TITLE_MAX, true);
      const brief = text(a.brief, "brief", TASK_BRIEF_MAX, false);
      let parentTaskId: string | undefined;
      if (a.parentTaskId !== undefined && a.parentTaskId !== null && a.parentTaskId !== "") parentTaskId = taskOf(a.parentTaskId).id;
      const taskId = (deps.newId ?? newTaskId)();
      deps.append({ type: "task_created", taskId, title, ...(brief === "" ? {} : { brief }), ...(parentTaskId === undefined ? {} : { parentTaskId }) });
      return `任务「${title}」已建（id ${taskId}）。派给谁用 assign_task，自己做就做完 report_task。`;
    },
  };
  const assign: Tool = {
    def: {
      name: ASSIGN_TASK_TOOL_NAME,
      description:
        "把一个任务派给一只在这条对话里的智能体（只能往下一级：管理员派专员、专员派自己的子工）。" +
        "派完**一定要在回复里 @ 它的名字**并说清要办什么——派是记账，@ 才是把话交出去。对方不在对话里先 bring_agent。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          to: { type: "string", description: "派给谁（名字，不含 @）" },
        },
        required: ["taskId", "to"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = (args ?? {}) as Record<string, unknown>;
      const task = taskOf(a.taskId);
      if (task.status === "done" || task.status === "failed") throw new Error(`「${task.title}」已经${TASK_STATUS_TEXT[task.status]}，不能再派`);
      const name = normalizeAgentName(text(a.to, "to", 64, true));
      const roster = deps.roster();
      const target = roster.find((x) => normalizeAgentName(x.name) === name);
      if (target === undefined) {
        // 只有管理员有 bring_agent（#1659）：专员撞到这里，告诉它往上转的路是主人，别让它去找一把没有的刀
        const self = roster.find((x) => x.agentId === deps.agentId);
        const canBring = self === undefined || tierOf(self) === 0;
        throw new Error(canBring
          ? `「${name}」不在这条对话里——先 bring_agent 把它拉进来（只能拉专员）`
          : `「${name}」不在这条对话里，你也拉不了人：要管理员办的用 escalate_to_admin 转过去（没有那把就告诉主人，写好一句让主人转的话）；这个任务你能做的那半截做完就 report_task`);
      }
      if (target.agentId === deps.agentId) throw new Error("不用派给自己：直接做，做完 report_task");
      if (!canDispatch(deps.agentId, target.agentId, roster)) throw new Error(`不能派给「${target.name}」——派活只能往下一级（管理员派专员、专员派自己的子工）`);
      deps.append({ type: "task_assigned", taskId: task.id, toAgentId: target.agentId });
      return `「${task.title}」已派给${target.name}。现在在回复里 @${target.name}，说清要办什么、什么时候要。`;
    },
  };
  const report: Tool = {
    def: {
      name: REPORT_TASK_TOOL_NAME,
      description:
        "报任务的进展：progress（干到哪了）/ done（做完，写结果）/ failed（没办成，写原因）/ needs_owner（要主人拍板，写问题）。" +
        "做完一定报 done——不报，派活的那只不知道你完了。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string", enum: ["progress", "done", "failed", "needs_owner"] },
          text: { type: "string", description: `进展 / 结果 / 原因 / 要主人答的问题，≤ ${TASK_NOTE_MAX} 字` },
        },
        required: ["taskId", "status", "text"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = (args ?? {}) as Record<string, unknown>;
      const task = taskOf(a.taskId);
      const note = text(a.text, "text", TASK_NOTE_MAX, true);
      const mine = task.assigneeAgentId === deps.agentId || task.createdByAgent === deps.agentId || tierOf(me()) === 0;
      if (!mine) throw new Error(`「${task.title}」不是派给你的，也不是你建的`);
      if (task.status === "done" || task.status === "failed") throw new Error(`「${task.title}」已经${TASK_STATUS_TEXT[task.status]}了`);
      switch (a.status) {
        case "progress": deps.append({ type: "task_progress", taskId: task.id, note }); return `记下了：「${task.title}」${note}`;
        case "done": deps.append({ type: "task_done", taskId: task.id, summary: note }); return `「${task.title}」完成。${task.assigneeAgentId === deps.agentId && task.createdByAgent !== deps.agentId ? "在回复里 @ 派给你的那只，把结果交回去。" : ""}`;
        case "failed": deps.append({ type: "task_failed", taskId: task.id, reason: note }); return `「${task.title}」记为没办成。`;
        case "needs_owner": deps.append({ type: "task_needs_owner", taskId: task.id, question: note }); return `「${task.title}」等主人拍板：${note}`;
        default: throw new Error("status 只能是 progress / done / failed / needs_owner");
      }
    },
  };
  return [create, assign, report];
}
