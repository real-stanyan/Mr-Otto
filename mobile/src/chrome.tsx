// 页签栏的两件共享状态：此刻收着没有、屏幕底下要给它让出多少。
//
// 页签栏是浮在内容上的毛玻璃（demo 的 .tabbar），内容从它底下滚过去——所以滚动容器
// 要自己让出这么高（ui.tsx 的 Page 读 useTabInset()）。根栈里的屏（账号、好友、配对）
// 在 Provider 外面，拿到的是默认值 0。
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** 页签栏高度，不含底部安全区。49pt 是 iOS 底栏的标准高度 */
export const TAB_BAR_HEIGHT = 49;

interface TabChrome {
  /** 翻进会话详情这种「推进一层」的屏时收起来 */
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  /** 收起时为 0 */
  inset: number;
}

const Ctx = createContext<TabChrome>({ hidden: false, setHidden: () => {}, inset: 0 });

export function TabChromeProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [hidden, setHidden] = useState(false);
  const value = useMemo(
    () => ({ hidden, setHidden, inset: hidden ? 0 : TAB_BAR_HEIGHT + insets.bottom }),
    [hidden, insets.bottom],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTabChrome(): TabChrome {
  return useContext(Ctx);
}

export function useTabInset(): number {
  return useContext(Ctx).inset;
}
