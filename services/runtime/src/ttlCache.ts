// ttlCache —— 按 key 记忆化一条异步查询（#979 第 5 条，ADR-0232）。
//
// 每 turn 起模型之前 runtime 要先打几次网络：在籍（membershipCache 已缓存）、agent
// 名单（原来**每次现查**，一条会话里 say() / runJob / relayAfterTurn 各查一遍）、
// 记忆、成员名单（原来每 turn 现查，与在籍那条是**同一条 SQL**）、每个成员一次 edge
// 的授权拉取。「现读」的纪律没错，错的是每个读路径各打各的：读的该是一份短 TTL 的
// 快照，由本进程里的写路径（create_agent）失效、由人的动作（say）强刷。
//
// 三条规矩，同 membershipCache：
//   · 查询抛错**不写缓存**——一次抖动不该占 60s 的位；
//   · 同一 key 并发 get 只打一次（inflight 合并）；
//   · `refresh` 绕过缓存**也绕过 inflight**：它的语义是「此刻之后的事实」，
//     并进一次已经在路上的查询会拿到那次查询开始之前的快照。

export interface TtlCache<T> {
  /** 命中 TTL 内的缓存就回缓存，否则现查并写入 */
  get(key: string): Promise<T>;
  /** 无视缓存现查一次并写入（人刚做了动作、要看此刻的事实） */
  refresh(key: string): Promise<T>;
  /** 让下一次 get 现查（本进程里的写路径落库之后调） */
  invalidate(key: string): void;
}

export function createTtlCache<T>(
  query: (key: string) => Promise<T>,
  opts: { ttlMs: number; now?: () => number }
): TtlCache<T> {
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();

  function load(key: string): Promise<T> {
    const p = query(key)
      .then((value) => {
        entries.set(key, { at: now(), value });
        return value;
      })
      .finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  }

  return {
    get(key) {
      const e = entries.get(key);
      if (e && now() - e.at < opts.ttlMs) return Promise.resolve(e.value);
      return inflight.get(key) ?? load(key);
    },
    refresh(key) {
      entries.delete(key);
      return load(key);
    },
    invalidate(key) {
      entries.delete(key);
    },
  };
}
