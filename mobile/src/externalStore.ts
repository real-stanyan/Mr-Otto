// 一个极小的外部 store（#1356 A1）：给 useSyncExternalStore 用。spec §3.2 定了不引 zustand——
// 手机端只有两份状态（名册、当前聊天），一个 set + 一组订阅者就够。
// `get` 在状态没变时必须回同一个引用（useSyncExternalStore 靠它判断要不要重画）。

export interface ExternalStore<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<S extends object>(initial: S): ExternalStore<S> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...p };
      for (const f of subs) f();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
