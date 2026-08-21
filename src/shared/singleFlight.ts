// singleFlight —— 同一个 key 的并发调用只真正跑一次，后到的等前一次的结果。
//
// 存在的理由是一类很安静的 bug：一段"先检查再落地"的代码中间被塞进了一个
// await，于是它不再是原子的（issue #155：resumeSession 的 agents.has() 与
// agents.set() 之间隔着 await mcpHub.ready()，同一个会话的两次 resume 会
// 双双穿过守卫、各建一个 agent）。Node 单线程只保证同步代码原子，await
// 一进来这条保证就没了——而写下守卫的那个人往往是在它还同步的时候写的。
//
// 不是缓存：结果不留存，promise 一 settle 就把 key 释放掉，下一次是全新的一次。

export function singleFlight<K, T>(): (key: K, build: () => Promise<T>) => Promise<T> {
  const inflight = new Map<K, Promise<T>>();
  return (key, build) => {
    const cur = inflight.get(key);
    // 前一次可能以失败告终——原样把同一个错误还给这一次。
    // 同一个 key 的并发调用该得到同一个答案，成功失败都是
    if (cur) return cur;
    // 登记必须发生在第一个 await 之前那段同步代码里，后到的调用才一定看得到它。
    // async 包一层顺带把 build() 的同步抛错也变成 rejection
    const p = (async () => build())().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  };
}
