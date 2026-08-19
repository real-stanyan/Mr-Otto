// friendsState — DM 列表的纯函数投影(store 里只调,不摊逻辑,好测)。
// 列表恒定旧→新升序、按 id 唯一。
//
// 这里还住着"聊天怎么排版"的全部规则(分组/日期分隔/时间文案):
// FriendChatView 只负责把这些行喂给 shadcn 的 Message/Bubble,不自己判断。

import type { DirectMessage } from "../../../shared/friends.js";

/** 渲染层的消息:比 DirectMessage 多一个本地发送态。
    status 缺席 = 已落库的实条(服务端回过真行) */
export interface ChatMessage extends DirectMessage {
  status?: "sending" | "failed";
}

/** 乐观气泡的临时 id 用负数:真 id 是 bigint identity,永远为正,两边不会撞 */
let tempSeq = 0;
export function nextTempId(): number {
  tempSeq += 1;
  return -tempSeq;
}

/** 单条消息按 id 去重升序插入(Realtime 推送 / 发送回显共用) */
export function mergeDm<T extends DirectMessage>(list: T[], msg: T): T[] {
  if (list.some((m) => m.id === msg.id)) return list;
  return [...list, msg].sort((a, b) => a.id - b.id);
}

/** 翻旧页:bridge 回的一页是新→旧,翻转拼到头部,与现有重叠去重 */
export function prependOlder<T extends DirectMessage>(list: T[], older: T[]): T[] {
  const have = new Set(list.map((m) => m.id));
  const fresh = [...older].reverse().filter((m) => !have.has(m.id));
  return [...fresh, ...list];
}

/** 按下回车立刻上屏的那一条(还没落库)。响应先于确认——Apple 的第一条:
    反馈发生在按下的瞬间,不是往返之后 */
export function optimisticMessage(
  tempId: number, sender: string, recipient: string, body: string, createdAt: string
): ChatMessage {
  return { id: tempId, sender, recipient, body, createdAt, status: "sending" };
}

/** 服务端回了真行:把占位换成实条(位置按 id 重排,它会落到列表最后) */
export function settleOptimistic(list: ChatMessage[], tempId: number, real: DirectMessage): ChatMessage[] {
  const without = list.filter((m) => m.id !== tempId);
  return mergeDm(without, { ...real });
}

/** 发送失败:占位留在原地标红,用户能看见"这条没发出去"(悄悄消失才是最坏的) */
export function failOptimistic(list: ChatMessage[], tempId: number): ChatMessage[] {
  return list.map((m) => (m.id === tempId ? { ...m, status: "failed" as const } : m));
}

/** 同一个人连着发、间隔在这个窗口内的消息摞成一组(只有组尾带时间/头像) */
export const GROUP_GAP_MS = 5 * 60 * 1000;

/** 聊天区要渲染的一行:日期分隔线,或一组同一个人的连续消息 */
export type ChatRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "group"; key: string; mine: boolean; messages: ChatMessage[] };

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 日期分隔线的文案:今天/昨天说人话,再往前给月日,跨年才带年份 */
export function dayLabel(iso: string, nowMs: number): string {
  const at = new Date(iso);
  const days = Math.round((startOfDay(nowMs) - startOfDay(at.getTime())) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (at.getFullYear() !== new Date(nowMs).getFullYear()) {
    return `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日`;
  }
  return `${at.getMonth() + 1}月${at.getDate()}日`;
}

/** 气泡下的时刻:24 小时制两位数(聊天里没人关心秒) */
export function timeLabel(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** 消息流 → 渲染行。分组条件三个都得满足:同一边说的、同一天、间隔不超过 GROUP_GAP_MS。
    "同一边"按 peerId 判(面板里只有两个人,非对方即自己)——不按 sender 字段判,
    因为乐观气泡还没有真 sender,按 sender 分组会让"发出去的那一条"自己单开一组 */
export function buildChatRows(list: ChatMessage[], peerId: string, nowMs: number): ChatRow[] {
  const rows: ChatRow[] = [];
  let day = "";
  let group: { kind: "group"; key: string; mine: boolean; messages: ChatMessage[] } | null = null;

  for (const msg of list) {
    const label = dayLabel(msg.createdAt, nowMs);
    if (label !== day) {
      day = label;
      group = null; // 跨天必断组:分隔线中间夹着的两条不该看起来像连着说的
      rows.push({ kind: "day", key: `day-${msg.id}`, label });
    }
    const mine = msg.sender !== peerId;
    const prev = group?.messages.at(-1);
    const continues =
      group !== null &&
      prev !== undefined &&
      group.mine === mine &&
      new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() <= GROUP_GAP_MS;
    if (continues && group) {
      group.messages.push(msg);
      continue;
    }
    group = { kind: "group", key: `g-${msg.id}`, mine, messages: [msg] };
    rows.push(group);
  }
  return rows;
}
