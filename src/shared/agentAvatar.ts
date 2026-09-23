// agentAvatar —— 「这一格头像画什么」（#971 / #1007 / #1345）。
//
// 坑位算法在 agentAvatarSlot.ts（纯逻辑），像素脸在 lib/ottoFace/（纯数据 + 一层 canvas）。
// 这个文件只回答一个问题：**给定一只 agent（或一个人），这一格画什么**。
//
// 原来它回答的是「哪一张 png 的 URL」（13 张 128px 静态图）。#1345 把那 13 张换成
// 13 个会动的像素角色之后，返回值不再是一个 URL —— 而这一格的答案本来就有**三种**，
// 一个 `string` 表达不了：
//
// · 内置像素脸（agent）
// · 一张真图（人：`profiles.avatar_url`）
// · 什么都查不到 —— 退回首字母
//
// 所以改成一个三选一的联合类型 `AvatarRef`。原来的编码是「空串 = 不给脸」，那是把
// 第三种情形挤进第二种的取值里；换成 `null` 之后 tsc 会当场指出每一个没分清的地方。
//
// **坑位数和顺序都不动，仍然是 13**：`fnv1a(agentId) % 13` 是已经落库的派生，改 13
// 就是给所有没手动挑过头像的 agent 换一张脸（见 ottoFace/sprites.ts 法理 ③）。

import type { WorkspaceSnapshot } from "./workspaces.js";
import { AGENT_AVATAR_COUNT, agentAvatarSlot } from "./agentAvatarSlot.js";

/** 内置像素脸的那一档，单独一个名字：`agentFace` / `agentFaceIfKnown` 回它而不是
    回整个 `AvatarRef` —— 它们**结构上只可能是脸**，回联合类型就得让每个调用点
    再判一次一个永远不成立的分支 */
export type FaceAvatar = { kind: "face"; slot: number };

/** 一格头像画什么。三个答案互斥；`null` = **不给脸**，调用方退回首字母 */
export type AvatarRef = FaceAvatar | { kind: "image"; src: string } | null;

/** 这只 agent 在这个工作区里画哪个坑位。
    **自己挑过的优先**（`avatarSlot`，#1007）；没挑过（null）才按 agentId 哈希从
    名单里派生，名单取 ws.agents 的顺序（服务端 created_at 升序）。

    挑中的坑位**不参与派生那套顺延避让**：有人手动挑到别人派生到的那个坑时两只会
    撞脸——那是用户自己挑的，不该反过来把别人的脸换掉。

    坑位越界（旧客户端读到新版才有的那个）**退回派生**，不取模：取模会安静地
    映射到另一张脸，看起来像「他挑了这张」，而事实是「这一版没有那个坑位」。 */
export function agentFaceSlot(ws: WorkspaceSnapshot, agentId: string): number {
  const picked = ws.agents.find((a) => a.agentId === agentId)?.avatarSlot ?? null;
  if (picked !== null && picked >= 0 && picked < AGENT_AVATAR_COUNT) return picked;
  const roster = ws.agents.map((a) => a.agentId);
  return agentAvatarSlot(agentId, roster);
}

/** 这只 agent 的脸。**永远给得出来**——被删掉的 agent 在旧消息上照样要有张脸，
    派生对陌生 id 也有定义。「名册里查不到就不给脸」是另一回事，走 `agentFaceIfKnown` */
export function agentFace(ws: WorkspaceSnapshot, agentId: string): FaceAvatar {
  return { kind: "face", slot: agentFaceSlot(ws, agentId) };
}

/** 名册里查得到才给脸，查不到回 `null`。
    这是仓里重复了六遍的那条纪律（ADR-0264 用量表 / ADR-0286 通话那一行 / 选人名单…）：
    派生对陌生 id 也会算出一张脸，画上去等于宣称它还在名册里，而那一行的名字恰恰是
    「查不到，只剩 id」。收在这一个函数里，免得每个调用点各写一遍 `known ? … : ""` */
export function agentFaceIfKnown(ws: WorkspaceSnapshot, agentId: string): FaceAvatar | null {
  if (!ws.agents.some((a) => a.agentId === agentId)) return null;
  return agentFace(ws, agentId);
}

/** 人的那一格：一张真图，**空串 = 没设过 / 已退群**，退回首字母（同 `memberAvatarOf`） */
export function imageAvatar(src: string | null | undefined): AvatarRef {
  if (src === null || src === undefined || src === "") return null;
  return { kind: "image", src };
}

/**
 * 编辑弹窗里那一格头像该画哪个坑位（#1013）。
 *
 * `null` = **画不出来**，不是「没有头像」：新建时派生用的 `agentId` 还没铸出来
 * （`a_` + 12 hex 是主进程在落库那一刻生成的），表单里无从得知它将来会分到哪张脸。
 * 这时候随便挑一张顶上是撒谎——人会以为头像已经定了。调用方该画的是一句
 * 「保存后自动分配」。
 *
 * `slot` 取的是**表单里此刻的选择**不是库里那份：改了还没保存时，预览要跟着手走。
 */
export function avatarPreviewSlot(
  ws: WorkspaceSnapshot,
  agentId: string | null,
  slot: number | null
): number | null {
  if (slot !== null && slot >= 0 && slot < AGENT_AVATAR_COUNT) return slot;
  if (agentId === null) return null;
  return agentFaceSlot(ws, agentId);
}
