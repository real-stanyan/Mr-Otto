import { useEffect, useState } from "react";

/** 跑着/等着的行需要一颗会走的表——日志在工具跑的时候可能纹丝不动(task 调用是
    await 的,父 turn 整段卡在那里,没有新事件可落),不挂个定时器 elapsed 就会在
    初次渲染的那个数字上钉死。intervalMs=null 时不走表(收口的行不需要再滴答)。

    从 Timeline.tsx 抽出来:工具时间线的折叠头(「工作中 12.4s」)要的是同一颗表 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
