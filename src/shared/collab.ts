// collab —— 管理员与管理员跨主场协作（#1578，ADR-0368）的纯逻辑：授权档位怎么说成提示词、邀请那句话怎么拼。
//
// 跨主场只有 L0 ↔ L0：A 的管理员牵头、判断要不要 B 的信息或动作，要就把任务交给 B 的管理员（走车道桥，目标固定是对方的
// 管理员）；B 的管理员按 B 给 A 的好友档位回应——仅聊天 / 可协作 / 全部开放——随时可拒。任务归 A，B 的管理员是协作者。
import type { CollabDecisionEvent, CollabRequestEvent } from "../session/events.js";
import type { FriendTier } from "./friendTier.js";
import { promptSafe } from "./promptSafe.js";
import type { TaskRow } from "./tasks.js";

export const INVITE_COLLABORATOR_TOOL_NAME = "invite_collaborator";
export const COLLAB_NOTE_MAX = 500;
/** 对面主人多久没点头算失败（#1605，维护者拍的 24 小时） */
export const COLLAB_EXPIRE_MS = 24 * 3_600_000;
/** 还在等点头的请求，同一条隔多久才再推一次提醒（#1605） */
export const COLLAB_REMIND_MS = 3_600_000;
export const COLLAB_DECISION_LABEL: Record<CollabDecisionEvent["decision"], string> = { accepted: "接了", declined: "不接", expired: "没回" };

/** 镜像卡上 / 对面管理员读到的那段：谁找、为什么（主人原话）、说明、到目前的结果 */
export function collabRequestText(e: Pick<CollabRequestEvent, "requestId" | "title" | "fromAgentName" | "quote" | "result">): string {
  const a = promptSafe(e.fromAgentName);
  const w = promptSafe(e.quote.ownerName);
  const parts = [`[协作请求 ${e.requestId}] ${w} 的管理员「${a}」找你配合「${promptSafe(e.title)}」。`];
  if (e.quote.ownerLine !== "") parts.push(`${w} 的原话：「${promptSafe(e.quote.ownerLine)}」。`);
  if (e.quote.note !== "") parts.push(`${a} 的说明：${promptSafe(e.quote.note)}。`);
  if (e.result !== "") parts.push(`到目前的结果：${promptSafe(e.result)}。`);
  parts.push("你主人点了头才轮到你动；按对方的授权答，不方便直说。");
  return parts.join("");
}
export function collabDecisionText(e: Pick<CollabDecisionEvent, "requestId" | "decision" | "via">): string {
  if (e.via === "tier_chat") return `[协作 ${e.requestId}] 对面给你的权限是「仅聊天」，它的管理员不接这类事。按没有继续，照实告诉主人对方没开这个权限。`;
  if (e.via !== undefined) return `[协作 ${e.requestId}] 对面按好友权限直接接了，它的管理员会在这里回你。`;
  const tail = e.decision === "accepted" ? "它的管理员会在管理员车道里回你。" : e.decision === "declined" ? "按没有继续，告诉主人。" : "24 小时没回，按没有继续，告诉主人「对面没回」。";
  return `[协作 ${e.requestId}] 对面主人：${COLLAB_DECISION_LABEL[e.decision]}。${tail}`;
}

/** 按好友权限自动接的那一轮里多的一句（tier_agents）：只答，不碰主人的东西 */
export const COLLAB_AGENTS_TIER_LINE = "对方给的权限是「可带智能体」：用对方给的信息答、帮着想，不动你主人的数据 / 文件 / 日程、不花钱、不替主人对外发消息；真要动这些，回一句「这个要我主人点头」，别动手。";

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
    `也不要自己替 ${p} 答）；对方说不方便就按没有继续，并告诉 ${w}。${p} 的管理员带来的任务你是协作者：按对 ${p} 的授权答，不方便直说，别抢着牵头。` +
    // 真机 2026-10-05（#1605）：管理员嘴上说「已经发给对方了」而工具根本没调——发没发只认回执
    `没调 invite_collaborator 就等于没发，不许说「已经发给 ${p} 的管理员了」；回执说发到了，才告诉 ${w}「已交给 ${p} 的管理员，那边要 ${p} 看到并点头才动，等回话」。]\n`
  );
}

/** 邀请对方管理员那句话：任务标题 + 简述 + 牵头人 + 附言；对方管理员读到就知道这是协作、不是主人的新要求 */
export function collabInviteText(t: Pick<TaskRow, "id" | "title" | "brief">, ownerName: string, note: string): string {
  const w = promptSafe(ownerName);
  const brief = t.brief === "" ? "" : `：${promptSafe(t.brief)}`;
  const extra = note === "" ? "" : ` ${promptSafe(note)}`;
  return `[协作邀请 ${t.id}] ${w} 这边在办「${promptSafe(t.title)}」${brief}。${w} 的管理员牵头，需要你这边配合一下——能答的答、要动手的回你主人批、不方便就直说。${extra}`.trim();
}

/** 主人点了「接」之后替主人落的开场白（#1605）：它读到的就是对面要它配合什么 */
export function collabAcceptText(e: Pick<CollabRequestEvent, "requestId" | "title" | "fromAgentName" | "quote" | "result">): string {
  const a = promptSafe(e.fromAgentName);
  const w = promptSafe(e.quote.ownerName);
  const parts = [`[系统] 你的主人接了 ${w} 的管理员「${a}」的协作请求 ${e.requestId}「${promptSafe(e.title)}」。`];
  if (e.quote.ownerLine !== "") parts.push(`${w} 的原话：「${promptSafe(e.quote.ownerLine)}」。`);
  if (e.quote.note !== "") parts.push(`${a} 的说明：${promptSafe(e.quote.note)}。`);
  if (e.result !== "") parts.push(`到目前的结果：${promptSafe(e.result)}。`);
  parts.push(`现在轮到你：按对 ${w} 的授权配合——事实直接答，要动手的按主人的规矩；回复写在这里，会原样送到「${a}」那边。`);
  return parts.join("");
}

/** 按好友权限自动接（#1605）：开场白换掉「你的主人接了」那一句 */
export function collabAutoAcceptText(e: Pick<CollabRequestEvent, "requestId" | "title" | "fromAgentName" | "quote" | "result">, tier: "full" | "agents"): string {
  const base = collabAcceptText(e).replace("你的主人接了", "按好友权限直接接了");
  return tier === "agents" ? `${base}${COLLAB_AGENTS_TIER_LINE}` : base;
}

/** 管理员车道里管理员的那一段（deriveMessages 用） */
export function adminsLaneText(ownerName: string, peerName: string): string {
  const w = promptSafe(ownerName);
  const p = promptSafe(peerName);
  return (
    `这是 ${w} 和朋友 ${p} 两家管理员之间的车道：${p} 的管理员找你配合的请求会到这里。${w} 点头之前你不动；点头之后你在这里回它，` +
    `回的每一句会原样送到对面。${p} 本人在这里只看不说，两位主人都看得到全文——别说 ${w} 没授权给 ${p} 的事。\n`
  );
}
