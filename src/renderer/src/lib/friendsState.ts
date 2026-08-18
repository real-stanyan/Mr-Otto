// friendsState — DM 列表的纯函数投影(store 里只调,不摊逻辑,好测)。
// 列表恒定旧→新升序、按 id 唯一。

import type { DirectMessage } from "../../../shared/friends.js";

/** 单条消息按 id 去重升序插入(Realtime 推送 / 发送回显共用) */
export function mergeDm(list: DirectMessage[], msg: DirectMessage): DirectMessage[] {
  if (list.some((m) => m.id === msg.id)) return list;
  return [...list, msg].sort((a, b) => a.id - b.id);
}

/** 翻旧页:bridge 回的一页是新→旧,翻转拼到头部,与现有重叠去重 */
export function prependOlder(list: DirectMessage[], older: DirectMessage[]): DirectMessage[] {
  const have = new Set(list.map((m) => m.id));
  const fresh = [...older].reverse().filter((m) => !have.has(m.id));
  return [...fresh, ...list];
}
