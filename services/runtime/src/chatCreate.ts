// 建一条聊天之前的核对（#1280，spec §5.3 / §6.6）。纯函数：daemon.ts 一 import 就要连
// docker / Supabase，进不了 vitest，所以判断住在这儿、接线留在那儿（同 usageAttribution 的教训）。
import { CHAT_GROUP_CREATE_MIN, narrowRoster } from "../../../src/shared/chatRoster.js";
import type { CsChatSpec } from "../../../src/shared/remote/cloudSession.js";

/** message 是给人看的那句话：frameHandler 原样放进 create_failed */
export class ChatCreateError extends Error {}

type TeamAgent = { agentId: string; name: string; degraded?: boolean };
export type ChatCreatePlan =
  | {
      ok: true;
      chatKind: "dm" | "group";
      agentIds: string[];
      title: string;
      entries: { agentId: string; name: string }[];
    }
  | { ok: false; message: string };

export function planChatCreate(chat: CsChatSpec, team: readonly TeamAgent[]): ChatCreatePlan {
  if (team.some((a) => a.degraded)) return { ok: false, message: "智能体名单这会儿读不出来，稍后再试" };
  const wanted = chat.kind === "dm" ? [chat.agentId] : chat.agentIds;
  const members = narrowRoster(team, wanted); // 顺序跟团队名单走
  const missing = wanted.length - members.length;
  if (missing > 0) {
    return {
      ok: false,
      message:
        chat.kind === "dm"
          ? "这只智能体已经不在了（名单可能刚变过，刷新再试）"
          : `有 ${missing} 只智能体已经不在了（名单可能刚变过，刷新再试）`,
    };
  }
  if (chat.kind === "group" && members.length < CHAT_GROUP_CREATE_MIN) {
    return { ok: false, message: "群聊至少要两只智能体" };
  }
  return {
    ok: true,
    chatKind: chat.kind,
    title: chat.kind === "group" ? chat.name : "",
    agentIds: members.map((a) => a.agentId),
    entries: members.map((a) => ({ agentId: a.agentId, name: a.name })),
  };
}
