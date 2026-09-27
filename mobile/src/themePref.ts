// 外观偏好（#1356 A5，spec §5.8 的「设置」）：跟随系统 / 浅色 / 深色。存在这台手机的 kv-store 里（同 supabase 的
// session 那一份），生效靠 RN 的 Appearance.setColorScheme——theme.ts 的 usePalette 读的 useColorScheme 跟着它走，
// 原生那几样（键盘、状态栏、SFSafariViewController）也跟着走。偏好属于这台手机，不跟账号走、登出不清。
import AsyncStorage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";
import { colorSchemeOf, parseThemePref, type ThemePref } from "../../src/shared/mobileAccount.js";
import { createStore } from "./externalStore.js";

const KEY = "otto.themePref";
const store = createStore<{ pref: ThemePref }>({ pref: "system" });

export function useThemePref(): ThemePref {
  return useSyncExternalStore(store.subscribe, () => store.get().pref);
}

function apply(pref: ThemePref): void {
  store.set({ pref });
  Appearance.setColorScheme(colorSchemeOf(pref));
}

/** 冷启动时读一次（App.tsx 模块顶层调）：读到之前跟随系统；读不到也跟随系统 */
export async function loadThemePref(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch {
    // 读不到 = 跟随系统
  }
  apply(parseThemePref(raw));
}

export async function setThemePref(pref: ThemePref): Promise<void> {
  apply(pref);
  try {
    if (pref === "system") await AsyncStorage.removeItem(KEY);
    else await AsyncStorage.setItem(KEY, pref);
  } catch {
    // 存不下：这一次照样生效，下次冷启动回到跟随系统
  }
}
