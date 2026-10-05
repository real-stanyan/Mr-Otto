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
  /** 对面的主人：车道里是配对的那位朋友（固定）；主人和自己管理员的私聊里（#1683）按模型给的 `friend` 现查好友名单——
      查不到回一句话（模型据此问主人是哪一位） */
  peer: (friend: string | undefined) => Promise<{ uid: string; name: string } | string>;
  /** 私聊里要模型说清找哪位朋友（schema 多一格 friend） */
  needsFriend?: boolean;
  ownerName: () => string;
  tasks: () => ReadonlyMap<string, TaskRow>;
  /** 这条任务点起之前主人最近的那句原话（去掉 `[名字]: ` 前缀）；取不到回空串 */
  ownerLineBefore: (taskId: string) => string;
  /** 先送到对面、送到了再落本地一份；回拒绝的那句话或 null */
  request: (o: { task: TaskRow; note: string; ownerLine: string; result: string; peer: { uid: string; name: string } }) => Promise<string | null>;
  /** 等点头的那条再送一次（对面按 requestId 去重；修好之前没送到的那条靠它补上）；回拒绝的那句话或 null */
  redeliver: (requestId: string) => Promise<string | null>;
}

export function createCollabTool(deps: CollabToolDeps): Tool {
  const friendProp = deps.needsFriend === true
    ? { friend: { type: "string", description: "找哪位朋友的管理员：朋友的名字（好友名单里的叫法）" } }
    : {};
  return {
    def: {
      name: INVITE_COLLABORATOR_TOOL_NAME,
      description:
        "把一个任务交给对方的管理员协作（需要对方那边的信息或动作时）。任务还归你牵头，对方是协作者，可以拒。" +
        "先 create_task 再调；note 里写清要对方配合什么（用主人说话的语言写，两边主人都会看到）。对方主人要先点头它的管理员才会动，不在线就得等（24 小时没回算失败）；" +
        "它的回复会落在这条对话里。不要直接找对方的别的智能体。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          note: { type: "string", description: `要对方配合什么，≤ ${COLLAB_NOTE_MAX} 字` },
          ...friendProp,
        },
        required: deps.needsFriend === true ? ["taskId", "friend"] : ["taskId"],
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
      const found = await deps.peer(typeof a.friend === "string" && a.friend.trim() !== "" ? a.friend.trim() : undefined);
      if (typeof found === "string") throw new Error(found);
      const peer = found;
      const st = task.collaborator?.uid === peer.uid ? task.collaborator.state : undefined;
      if (st === "pending") {
        const rid = task.collaborator?.requestId;
        const again = rid === undefined ? null : await deps.redeliver(rid);
        if (again !== null) throw new Error(`没送到：${again}。告诉主人没送到、为什么，别说已经交给了。`);
        return `「${task.title}」已经交给${peer.name}的管理员了（又确认送达了一次），等 ${peer.name} 点头，别重复发。`;
      }
      if (st === "accepted") return `${peer.name}的管理员已经在办「${task.title}」了，等它回话就行。`;
      const refused = await deps.request({ task, note, ownerLine: deps.ownerLineBefore(task.id), result: task.summary ?? "", peer });
      // 真机 2026-10-05：工具报了错，管理员照样说「交给了」——错误那句把该怎么说写死
      if (refused !== null) throw new Error(`没送到：${refused}。告诉主人没送到、为什么，别说已经交给了。`);
      return `已把「${task.title}」交给${peer.name}的管理员，等 ${peer.name} 点头（24 小时没回算失败）；它答了会落在这条对话里。` +
        `告诉主人「已交给 ${peer.name} 的管理员，等那边回」，别说成已经在办。`;
    },
  };
}
