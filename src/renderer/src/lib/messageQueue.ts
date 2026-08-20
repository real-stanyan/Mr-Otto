// 消息队列 —— 一个 turn 在跑的时候，用户接着敲的下几条活。
//
// 为什么它**不是**事件:排队中的消息还不是这段对话里发生过的事,它是"待发出的
// 意图",和输入框里那半句没发的话是同一类东西(那半句也不落盘)。真正落进日志的
// 时刻是它发出去的那一刻 —— 那时会照常写一条 user_message。所以队列住在渲染层,
// 不进 SessionEvent:硬规则要求的是"模型看见的都得先落盘",不是"用户敲过的都得落盘"。
//
// 队列按会话记(和 statusBySession 同一个路子):A 在跑的时候你可能正看着 B,
// 排给 A 的活不该在 B 结束时飞出去。
//
// 这个文件只放不碰 React、不碰 window.otter 的那部分 —— 队列本身的增删。

/** 一条排着的活。skill = $ 指令注入的 skill 名(与 send 的第二参同义) */
export interface QueuedTask {
  id: string;
  text: string;
  skill?: string | undefined;
}

/** 排到队尾。先来先发 —— 用户敲下去的顺序就是他想要的顺序，不做优先级 */
export function pushTask(list: readonly QueuedTask[], task: QueuedTask): QueuedTask[] {
  return [...list, task];
}

/** × 掉一条。认不出的 id 原样返回:反手删掉"最像的那条"是拿用户的话赌 */
export function dropTask(list: readonly QueuedTask[], id: string): QueuedTask[] {
  return list.filter((t) => t.id !== id);
}

/** 取队首 + 剩下的。空队列 = [undefined, []]，调用方据此决定要不要发 */
export function takeNext(
  list: readonly QueuedTask[],
): [QueuedTask | undefined, QueuedTask[]] {
  const [head, ...rest] = list;
  return [head, rest];
}

/** 发失败时把它放回**队首**,不是队尾:它本来就该是下一条,
    失败不该让它排到后来者的后面去 */
export function unshiftTask(list: readonly QueuedTask[], task: QueuedTask): QueuedTask[] {
  return [task, ...list];
}
