// 牌桌座位的纯计算：旋转与身份映射。抽出来是为了让 vitest（node 环境）测得到 ——
// 组件本体要 DOM，测试栈里没有。

import type { FriendshipEntry } from "../../../shared/friends.js";
import type { PokerSeatView } from "../../../shared/shellBridge.js";

/**
 * 座位在牌桌椭圆上的位置（百分比）。
 *
 * 以"我"为锚旋转：我永远在正下方（角度 π/2），其他人按原座次顺时针排开。
 * 桌上看牌的人心智模型就是"我在下家位"，跟物理牌桌坐下后的视角一致；
 * 服务端的 seatIndex 不动，动的只是渲染角度。
 */
export function seatPosition(
  index: number,
  meIndex: number,
  count: number
): { left: number; top: number } {
  const anchor = meIndex >= 0 ? meIndex : 0;
  const rotated = ((index - anchor) % count + count) % count;
  const angle = Math.PI / 2 + (rotated / count) * Math.PI * 2;
  return {
    left: 50 + Math.cos(angle) * 41,
    top: 50 + Math.sin(angle) * 42,
  };
}

/** 座位显示身份。同桌必为好友（服务端规则），好友快照里有真名和头像 */
export function seatIdentity(
  seat: Pick<PokerSeatView, "userId" | "isMe">,
  friends: readonly FriendshipEntry[],
  myName: string,
  myAvatarUrl: string
): { name: string; avatarUrl: string } {
  if (seat.isMe) return { name: myName || "你", avatarUrl: myAvatarUrl };
  const hit = friends.find((f) => f.profile.id === seat.userId);
  if (hit && hit.profile.name) return { name: hit.profile.name, avatarUrl: hit.profile.avatarUrl };
  // 兜底：快照没跟上（刚加好友/离线）。截 ID 至少还能区分人
  return { name: seat.userId.slice(0, 6), avatarUrl: hit?.profile.avatarUrl ?? "" };
}
