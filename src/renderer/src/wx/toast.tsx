// toast —— 桌面微信式布局（#1386）底部那一句小提示（「申请已发出」「密码改好了」）。
// 一次只一句、2.2 秒自己走；新的一句顶掉旧的（两句叠着说，人哪句都读不完）。
// 模块级的一格 + useSyncExternalStore：弹它的人（弹窗、抽屉）往往正在卸载，挂在它们身上的 state 等不到画出来。

import { useSyncExternalStore } from "react";

interface Toast {
  id: number;
  text: string;
}

let current: Toast | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function toast(text: string): void {
  seq += 1;
  current = { id: seq, text };
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    timer = null;
    emit();
  }, 2200);
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function WxToaster() {
  const t = useSyncExternalStore(subscribe, () => current);
  if (t === null) return null;
  return (
    <div
      key={t.id}
      role="status"
      className="wx-toast pointer-events-none fixed bottom-7 left-1/2 z-[70] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-[10px] bg-popover px-3.5 py-2 text-[12.5px] text-popover-foreground shadow-lg ring-1 ring-foreground/[0.06]"
    >
      {t.text}
    </div>
  );
}
