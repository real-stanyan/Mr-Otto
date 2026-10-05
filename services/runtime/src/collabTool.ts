// invite_collaborator —— A 的管理员把一个任务交给 B 的管理员协作（#1578 → #1605 第 1 期 b）。
//
// 第 1 期 b 换了落点：不再往 B 公开给 A 的车道里丢一句话（那一轮是客人轮，B 的管理员每把刀都要 B 批、又没有审批卡），
// 而是落一条 collab_request（镜像卡的事实：主人原话 + 说明 + 到目前的结果 + 24h）——A 这条会话一份（任务的协作者状态
// 从它折），B 家的管理员车道一份（B 看卡、点头之后 B 的管理员才动）。只依赖注入的回调（硬规则「工具只依赖接口」）。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { COLLAB_NOTE_MAX, INVITE_COLLABORATOR_TOOL_NAME } from "../../../src/shared/collab.js";
import type { TaskRow } from "../../../src/shared/tasks.js";

export interface CollabToolDeps {
  /** 对面的主人（这条车道配对的那位朋友） */
  peer: () => { uid: string; name: string };
  ownerName: () => string;
  tasks: () => ReadonlyMap<string, TaskRow>;
  /** 这条任务点起之前主人最近的那句原话（去掉 `[名字]: ` 前缀）；取不到回空串 */
  ownerLineBefore: (taskId: string) => string;
  /** 落 collab_request（本地一份 + 送到对面）；回拒绝的那句话或 null */
  request: (o: { task: TaskRow; note: string; ownerLine: string; result: string }) => Promise<string | null>;
}

export function createCollabTool(deps: CollabToolDeps): Tool {
  return {
    def: {
      name: INVITE_COLLABORATOR_TOOL_NAME,
      description:
        "把一个任务交给对方的管理员协作（需要对方那边的信息或动作时）。任务还归你牵头，对方是协作者，可以拒。" +
        "先 create_task 再调；note 里写清要对方配合什么。对方主人要先点头它的管理员才会动，不在线就得等（24 小时没回算失败）；" +
        "它的回复会落在这条对话里。不要直接找对方的别的智能体。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          note: { type: "string", description: `要对方配合什么，≤ ${COLLAB_NOTE_MAX} 字` },
        },
        required: ["taskId"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = (args ?? {}) as Record<string, unknown>;
      if (typeof a.taskId !== "string" || a.taskId.trim() === "") throw new Error("taskId 必填（先 create_task）");
      const task = deps.tasks().get(a.taskId.trim());
      if (task === undefined) throw new Error(`没有 id 为「${a.taskId}」的任务——先 create_task`);
      if (task.status === "done" || task.status === "failed") throw new Error(`「${task.title}」已经收口了，不用再邀人`);
      const note = typeof a.note === "string" ? a.note.replace(/\s+/g, " ").trim() : "";
      if (note.length > COLLAB_NOTE_MAX) throw new Error(`note 最多 ${COLLAB_NOTE_MAX} 字`);
      const peer = deps.peer();
      const st = task.collaborator?.uid === peer.uid ? task.collaborator.state : undefined;
      if (st === "pending") return `「${task.title}」已经交给${peer.name}的管理员了，等 ${peer.name} 点头，别重复发。`;
      if (st === "accepted") return `${peer.name}的管理员已经在办「${task.title}」了，等它回话就行。`;
      const refused = await deps.request({ task, note, ownerLine: deps.ownerLineBefore(task.id), result: task.summary ?? "" });
      if (refused !== null) throw new Error(refused);
      return `已把「${task.title}」交给${peer.name}的管理员，等 ${peer.name} 点头（24 小时没回算失败）；它答了会落在这条对话里。` +
        `告诉主人「已交给 ${peer.name} 的管理员，等那边回」，别说成已经在办。`;
    },
  };
}
