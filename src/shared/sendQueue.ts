// 发送队列（#1473）：输入框发出即清之后，人可以在上一句的回执还没回来时就发第二句；而云会话客户端
// 对「上一句还没有回执」的第二次 say 是直接拒的（cloudSessionClient 的 SAY_BUSY_MESSAGE——回执不带
// 请求 id，并发在客户端这一侧分不出谁是谁的）。所以排队放在手机的 store 那一层（chatStore / friendsStore 各一条）：一句一句发，前一句的结局
// （成功 / 失败 / 抛错）只交给它自己的调用方，不影响后一句。纯逻辑，不碰 RN，可测。

export interface SendQueue {
  /** 排到队尾；轮到它时才跑 fn。回的是 fn 自己的结果 / 错误 */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSendQueue(): SendQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      // 链上只记「落定了」，不记结果：失败的那一句不该把后面的全拖下水
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
