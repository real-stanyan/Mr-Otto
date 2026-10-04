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
      chatKind: "dm" | "group" | "pair";
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
          ?"这只智能体已经不在了（名单可能刚变过，刷新再试）"
          : `有 ${missing} 只智能体已经不在了（名单可能刚变过，刷新再试）`,
    };
  }
  // 下限按「拉进来的」算（#1393）：智能体 + 群主的朋友合起来至少两位。只有智能体时这句话与改动前相同
  if (chat.kind === "group" && members.length + (chat.humans?.length ?? 0) < CHAT_GROUP_CREATE_MIN) {
    return { ok: false, message: (chat.humans?.length ?? 0) > 0 ? "群聊至少要拉两位进来（智能体或朋友）" : "群聊至少要两只智能体" };
  }
  return {
    ok: true,
    chatKind: chat.kind,
    title: chat.kind === "group" ? chat.name : "",
    agentIds: members.map((a) => a.agentId),
    entries: members.map((a) => ({ agentId: a.agentId, name: a.name })),
  };
}

/** 私密车道（#1461 P1，ADR-0343）能不能建：只在**我自己的主场**里（智能体是我的、在我的云电脑上跑、花我的额度——
    团队的智能体不归我一个人带出去），只对**已接受的朋友**（`friends` 由调用方现查 `friendships`，查不到由调用方
    说「稍后再试」，不在这里读成「不是朋友」），不能和自己配对。回 null = 可以；回字符串 = 给人看的那句话 */
export function pairCreateProblem(o: { byUid: string; peerUid: string; home: boolean; friends: ReadonlySet<string> }): string | null {
  if (!o.home) return "私人智能体只能从你自己的主场里带。";
  if (o.peerUid === o.byUid) return "不能和自己配对。";
  if (!o.friends.has(o.peerUid)) return "只能在和朋友的私聊里带智能体。";
  return null;
}
