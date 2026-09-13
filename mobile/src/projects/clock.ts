// 会话列表与详情共用的两个小钟。从 App.tsx 拆出来（#1237 M0）：
// Fleet 与 SessionView 都要，放在任何一边都会让两者互相 import。

import { useEffect, useState } from "react";

/** 一秒一跳的钟。只在有会话真的在跑时才装 —— 空闲时不必让 JS 线程每秒醒一次 */
export function useTicker(active: boolean): number {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return Date.now();
}

export function elapsed(since: number, now: number): string {
  const sec = Math.max(0, Math.round((now - since) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

