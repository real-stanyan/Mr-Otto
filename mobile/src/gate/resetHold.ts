// 「找回密码验完验证码、新密码还没设」这笔记号（同桌面 store 的 RESET_PENDING_KEY，ADR-0194）。
//
// 落 kv-store 不落内存：验完码到设完新密码之间 app 可能被杀掉——冷启动回来时 session 在、
// 旧密码一个字没变，没有这笔记号闸门就抬了。和 supabase 的 session 存在同一个 kv-store 里
// （见 supabase.ts），同样 Expo Go 就有。
import AsyncStorage from "expo-sqlite/kv-store";

const KEY = "otto.gate.resetHold";

export async function readResetHold(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEY)) === "1";
}

export async function writeResetHold(on: boolean): Promise<void> {
  if (on) await AsyncStorage.setItem(KEY, "1");
  else await AsyncStorage.removeItem(KEY);
}
