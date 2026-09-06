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

/** 这只 agent 在这个工作区里画哪张脸。名单取 ws.agents 的顺序（服务端 created_at 升序） */
export function agentAvatarSrc(ws: WorkspaceSnapshot, agentId: string): string {
  const roster = ws.agents.map((a) => a.agentId);
  return AGENT_AVATARS[agentAvatarSlot(agentId, roster)]!;
}
