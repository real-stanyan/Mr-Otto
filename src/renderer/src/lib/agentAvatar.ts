// agentAvatar —— 内置像素头像的图片清单 + 「这只 agent 画哪张」（#971）。
// 坑位算法在 agentAvatarSlot.ts（纯逻辑，单测在那边）；这个文件只负责把
// 图片 import 进来——vite 把 png 当 URL 处理，在 vitest 里也能 import，
// 但坑位那层刻意不依赖它，免得测纯逻辑要先过一遍资源管线。
//
// 13 张来自维护者提供的像素人像，统一裁成脸居中的 128px 方图（ADR-0229）。
// 顺序即坑位：01 → 0 … 13 → 12，改顺序等于给所有 agent 换脸，别动。

import a01 from "../assets/agent-avatars/01.png";
import a02 from "../assets/agent-avatars/02.png";
import a03 from "../assets/agent-avatars/03.png";
import a04 from "../assets/agent-avatars/04.png";
import a05 from "../assets/agent-avatars/05.png";
import a06 from "../assets/agent-avatars/06.png";
import a07 from "../assets/agent-avatars/07.png";
import a08 from "../assets/agent-avatars/08.png";
import a09 from "../assets/agent-avatars/09.png";
import a10 from "../assets/agent-avatars/10.png";
import a11 from "../assets/agent-avatars/11.png";
import a12 from "../assets/agent-avatars/12.png";
import a13 from "../assets/agent-avatars/13.png";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { agentAvatarSlot } from "./agentAvatarSlot.js";

export const AGENT_AVATARS: readonly string[] = [a01, a02, a03, a04, a05, a06, a07, a08, a09, a10, a11, a12, a13];

/** 这只 agent 在这个工作区里画哪张脸。
    **自己挑过的优先**（`avatarSlot`，#1007）；没挑过（null）才按 agentId 哈希从
    名单里派生，名单取 ws.agents 的顺序（服务端 created_at 升序）。

    挑中的坑位**不参与派生那套顺延避让**：有人手动挑到别人派生到的那张时两只会
    撞脸——那是用户自己挑的，不该反过来把别人的脸换掉。

    坑位越界（旧客户端读到新版才有的那张）**退回派生**，不取模：取模会安静地
    映射到另一张脸，看起来像「他挑了这张」，而事实是「这一版没有那张图」。 */
export function agentAvatarSrc(ws: WorkspaceSnapshot, agentId: string): string {
  const picked = ws.agents.find((a) => a.agentId === agentId)?.avatarSlot ?? null;
  if (picked !== null && picked >= 0 && picked < AGENT_AVATARS.length) return AGENT_AVATARS[picked]!;
  const roster = ws.agents.map((a) => a.agentId);
  return AGENT_AVATARS[agentAvatarSlot(agentId, roster)]!;
}

/**
 * 编辑弹窗里那一格头像该画什么（#1013）。
 *
 * `null` = **画不出来**，不是「没有头像」：新建时派生用的 `agentId` 还没铸出来
 * （`a_` + 12 hex 是主进程在落库那一刻生成的），表单里无从得知它将来会分到哪张脸。
 * 这时候随便挑一张顶上是撒谎——人会以为头像已经定了。调用方该画的是一句
 * 「保存后自动分配」。
 *
 * `slot` 取的是**表单里此刻的选择**不是库里那份：改了还没保存时，预览要跟着手走。
 */
export function avatarPreviewSrc(
  ws: WorkspaceSnapshot,
  agentId: string | null,
  slot: number | null
): string | null {
  if (slot !== null && slot >= 0 && slot < AGENT_AVATARS.length) return AGENT_AVATARS[slot]!;
  if (agentId === null) return null;
  return agentAvatarSrc(ws, agentId);
}
