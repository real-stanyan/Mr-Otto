// readReceipt —— 朋友私聊的已读回执画在哪、写什么（#1442）。数据是 friend_reads（0049）里对方那一行：
//
// · 没有那一行（undefined）：对方的 App 还不认得已读回执（或者还没打开过这个聊天）——什么都不画。
//   写「未读」的话，用旧版本 / 桌面看过消息的人在这边会一直挂着一句假话。
// · 那一行是 null：对方关了「让朋友看到我已读」——什么都不画。
// · 是一个数：读到了对方发来的那一条（messages.id）。
//
// 只画在**我发的最后一条**底下，而且只在它就是这条线的最后一条时画（对方已经回了话，「读没读」不用再问）。
import type { DirectMessage } from "./friends.js";

export interface ReceiptLabel {
  messageId: number;
  read: boolean;
}

export function receiptLabel(messages: readonly DirectMessage[], selfUid: string, peerLastRead: number | null | undefined): ReceiptLabel | null {
  if (peerLastRead === undefined || peerLastRead === null) return null;
  let last: DirectMessage | null = null;
  for (const m of messages) if (last === null || m.id > last.id) last = m;
  if (last === null || last.sender !== selfUid) return null;
  return { messageId: last.id, read: peerLastRead >= last.id };
}

/** 该报给服务端「读到了哪一条」：对方发来的里面 id 最大的那条；一条都没有回 0（见 0049：有这一行本身
    就是「我的 App 认得已读回执」）。已经报过的不再报 */
export function readUpTo(messages: readonly DirectMessage[], peerUid: string): number {
  let max = 0;
  for (const m of messages) if (m.sender === peerUid && m.id > max) max = m.id;
  return max;
}
