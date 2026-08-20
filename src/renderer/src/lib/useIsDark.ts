// 当前是不是深色。主题不走 React state（theme.ts 直接在 <html> 上开关 .dark 类，
// UI 偏好不是会话事实，不进 store 也不进日志），所以要反应式地知道它，
// 只能盯着那个类看 —— MutationObserver 就是为这种"别人改了 DOM"准备的。

import { useEffect, useState } from "react";

const isDark = () => document.documentElement.classList.contains("dark");

export function useIsDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const o = new MutationObserver(() => setDark(isDark()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    // 挂载和首次渲染之间主题可能已经变过（跟随系统时开机那一下）
    setDark(isDark());
    return () => o.disconnect();
  }, []);
  return dark;
}
