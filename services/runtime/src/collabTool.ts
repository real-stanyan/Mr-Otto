// invite_collaborator —— A 的管理员把一个任务交给 B 的管理员协作（#1578，ADR-0368）。
//
// 只挂在公开车道里的管理员身上（sessionService 按 L0 + pair + facing both 挂）。做两件事：落一条 task_collab（任务还归这边，
// 对方是协作者；任务卡上写「协作：小红的管理员」），再走车道桥把邀请那句话发到对面——桥的目标固定是对方的管理员（laneBridge ④）。
// 桥本身的四道闸（深度 / 每小时封顶 / 对面车道与客人名单 / 点谁）原样，这里不复制。
// 只依赖注入的回调（硬规则「工具只依赖接口」）：不知道 store、不知道 Supabase。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { COLLAB_NOTE_MAX, INVITE_COLLABORATOR_TOOL_NAME, collabInviteText } from "../../../src/shared/collab.js";
import type { TaskRow } from "../../../src/shared/tasks.js";

export interface CollabToolDeps {
  /** 对面的主人（这条车道配对的那位朋友） */
  peer: () => { uid: string; name: string };
  ownerName: () => string;
  tasks: () => ReadonlyMap<string, TaskRow>;
  /** 落 task_collab */
  record: (taskId: string, withUid: string, withName: string) => void;
  /** 车道桥：发到对面（回的是桥那句人话，发没发成都在里面） */
  send: (text: string) => Promise<string>;
}

export function createCollabTool(deps: CollabToolDeps): Tool {
  return {
    def: {
      name: INVITE_COLLABORATOR_TOOL_NAME,
      description:
        "把一个任务交给对方的管理员协作（需要对方那边的信息或动作时）。任务还归你牵头，对方是协作者，可以拒。" +
        "先 create_task 再调；note 里写清要对方配合什么。不要直接找对方的别的智能体。",
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
      if (task.collaborator?.uid === peer.uid) return `「${task.title}」已经邀过${peer.name}的管理员了，等它回话就行。`;
      const sent = await deps.send(collabInviteText(task, deps.ownerName(), note));
      deps.record(task.id, peer.uid, peer.name);
      return `已邀请${peer.name}的管理员协作「${task.title}」。${sent}`;
    },
  };
}
