// collab —— 管理员与管理员跨主场协作（#1578，ADR-0368）的纯逻辑：授权档位怎么说成提示词、邀请那句话怎么拼。
//
// 跨主场只有 L0 ↔ L0：A 的管理员牵头、判断要不要 B 的信息或动作，要就把任务交给 B 的管理员（走车道桥，目标固定是对方的
// 管理员）；B 的管理员按 B 给 A 的好友档位回应——仅聊天 / 可协作 / 全部开放——随时可拒。任务归 A，B 的管理员是协作者。
import type { FriendTier } from "./friendTier.js";
import { promptSafe } from "./promptSafe.js";
import type { TaskRow } from "./tasks.js";

export const INVITE_COLLABORATOR_TOOL_NAME = "invite_collaborator";
export const COLLAB_NOTE_MAX = 500;

/** B 的管理员在公开车道里对 A 能说多少、做多少（spec §2.6 第 2 条）：按两边取小的那一档 */
export function collabAuthPrompt(tier: FriendTier, peerName: string): string {
  const p = promptSafe(peerName);
  switch (tier) {
    case "chat":
      return `\n[对 ${p} 的授权：仅聊天。${p} 那边的管理员带来的任务，你只能转述主人公开说过的话，不查主人的日程 / 文件 / 记忆，不替主人答应任何事；办不了就直说「这个我得问主人」。]\n`;
    case "agents":
      return `\n[对 ${p} 的授权：可协作。${p} 那边的管理员带来的任务，主人的日程、偏好这类事实你可以直接答；要动手（订票、改文件、花钱）的先回主人批，批了才做；别替主人拍板。]\n`;
    case "full":
      return `\n[对 ${p} 的授权：全部开放。${p} 那边的管理员带来的任务，事实直接答；主人不在时小事你可以替主人定（花钱、承诺时间这类仍要主人批），定了告诉主人。]\n`;
  }
}

/** 车道里管理员的牵头 / 协作者那一段（两边都加：谁牵头看任务从哪边起） */
export function collabRolePrompt(ownerName: string, peerName: string): string {
  const w = promptSafe(ownerName);
  const p = promptSafe(peerName);
  return (
    `\n[协作：${w} 交给你的任务你牵头——要 ${p} 那边的信息或动作时用 invite_collaborator 把任务交给 ${p} 的管理员（不要直接找 ${p} 的别的智能体，` +
    `也不要自己替 ${p} 答）；对方说不方便就按没有继续，并告诉 ${w}。${p} 的管理员带来的任务你是协作者：按对 ${p} 的授权答，不方便直说，别抢着牵头。]\n`
  );
}

/** 邀请对方管理员那句话：任务标题 + 简述 + 牵头人 + 附言；对方管理员读到就知道这是协作、不是主人的新要求 */
export function collabInviteText(t: Pick<TaskRow, "id" | "title" | "brief">, ownerName: string, note: string): string {
  const w = promptSafe(ownerName);
  const brief = t.brief === "" ? "" : `：${promptSafe(t.brief)}`;
  const extra = note === "" ? "" : ` ${promptSafe(note)}`;
  return `[协作邀请 ${t.id}] ${w} 这边在办「${promptSafe(t.title)}」${brief}。${w} 的管理员牵头，需要你这边配合一下——能答的答、要动手的回你主人批、不方便就直说。${extra}`.trim();
}
