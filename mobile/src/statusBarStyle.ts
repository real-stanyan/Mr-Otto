// 状态栏字色跟着系统浅 / 深色走。全 app 只有这一处在管它。
//
// 为什么不是一句 `<StatusBar style="auto" />` 就完了(#1270):Expo Go 与 Expo 的打包模板都把
// `UIViewControllerBasedStatusBarAppearance` 写成 false,于是真正决定字色的是**应用级**的
// `UIApplication.statusBarStyle` —— expo-status-bar 和 RN 的 `StatusBar` 最后都落到它,
// react-native-screens 那套按屏给 `statusBarStyle` 的路子在这个前提下**一格都不生效**
// (它走的是 view controller 那条,而且在 Expo Go 里一碰就红屏,原因写在它的 assert 里)。
//
// 病在时序:系统外观实时切换时,JS 在**同一刻**就把新字色发下去了,而 iOS 自己的外观转场
// 里会把应用级字色重新应用一遍 —— 落在那个窗口里的调用被吞掉,状态栏就停在切换前的字色上
// (深色底配深色字 = 整条看不见)。冷启动看着正常,是因为那条路上没有转场。
//
// 实测(iPhone 17 Pro / iOS 26.5 / Expo Go 57.0.9,2026-09-16):切换后 400ms 发的那一发仍然
// 被吞,800ms 的留得住。所以这里发两次:**立刻一发**(没有转场的路径 —— 冷启动、后台回前台
// —— 这一发就够了),**转场结束后再补一发**。
//
// `REAPPLY_MS` 是量出来的数不是文档里的数,iOS 换个版本就该重新量;真要坏也是安静地坏
// (状态栏看不见,不报错),所以保鲜期只能是这段注释 + issue #1270 里那组截图。
import { useEffect } from "react";
import { StatusBar } from "react-native";

/** 补发的时刻。实测下界在 400(被吞)与 800(留得住)之间,取 1000 留余量 */
export const REAPPLY_MS = 1000;

/** 深色底配浅色字,浅色底配深色字 —— 反过来读不出来 */
export function barStyleFor(isDark: boolean): "light-content" | "dark-content" {
  return isDark ? "light-content" : "dark-content";
}

export function useStatusBarStyle(isDark: boolean): void {
  useEffect(() => {
    const style = barStyleFor(isDark);
    StatusBar.setBarStyle(style, false);
    const id = setTimeout(() => StatusBar.setBarStyle(style, false), REAPPLY_MS);
    return () => clearTimeout(id);
  }, [isDark]);
}
