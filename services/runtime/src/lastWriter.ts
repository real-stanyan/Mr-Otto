// lastWriter —— 名册「最后一句」写库的节流（#1356 A1，spec §7.1）。
//
// 首尾两沿：距上一次**写**已经够久就当场写（人刚说完的那句立刻顶上名册）；否则记下
// 这一句、排一个定时器到窗口末尾再写（3 秒内说了好几句时，最后那句一定写到）。窗口
// 从上一次写算起，不从上一次 push 算起——否则一句接一句地说，尾沿会被无限往后推。
// 只排一个定时器：窗口里再来几句只换掉待写的那一格。
//
// 写的是日志的投影：失败只丢这一格（CloudSessionMeta 的实现自己记日志），下一句盖掉。
// 时钟与定时器可注入，测试不必动 vi 的假定时器。

import type { SessionLast } from "../../../src/shared/sessionLast.js";

export interface LastWriter {
  push(l: SessionLast): void;
}

export function createLastWriter(o: {
  write: (l: SessionLast) => Promise<void>;
  throttleMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}): LastWriter {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number): unknown => {
    const t = setTimeout(fn, ms);
    // 一个待写的名册投影不该拖着进程不退（daemon 收摊、测试结束时）
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let pending: SessionLast | null = null;
  let armed = false;

  const fire = (): void => {
    armed = false;
    if (pending === null) return;
    const l = pending;
    pending = null;
    lastWriteAt = now();
    void o.write(l).catch(() => undefined);
  };

  return {
    push(l) {
      pending = l;
      if (armed) return;
      const wait = lastWriteAt + o.throttleMs - now();
      if (wait <= 0) {
        fire();
        return;
      }
      armed = true;
      setTimer(fire, wait);
    },
  };
}
