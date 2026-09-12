// 闸门那一问的手机端实现：**盘上有没有一份 session**（判据在 src/shared/authSession.ts，两端共用）。
//
// 为什么不问 `supabase.auth.getSession()`：它会发网络，断网 + token 过期时回 `session: null`，
// 而盘上那份其实还在——照它判就是把人锁在自己的 app 外面（桌面 ADR-0183 早就判过同一件事）。
//
// 扫**整个** kv-store 而不是硬拼 `sb-<ref>-auth-token` 这把 key：硬拼更精确，但它的失败模式
// 无法接受——supabase 哪天改了 key 方案，用户会掉进「登录了也进不去」的死循环。
// 同步 API（getAllKeysSync / getItemSync）是 expo-sqlite/kv-store 自带的。
import AsyncStorage from "expo-sqlite/kv-store";
import { hasStoredSession } from "../../../src/shared/authSession.js";

/** 这台手机上有没有一份登录记录。不发网络、不看 token 过没过期 */
export function hasStoredSessionSync(): boolean {
  try {
    const keys = AsyncStorage.getAllKeysSync();
    return hasStoredSession(keys.map((k) => [k, AsyncStorage.getItemSync(k)] as const));
  } catch {
    // 读不动存储（第一次装、迁移中）不该把人挡在外面：退回「没有记录」，闸门画登录卡——
    // 那是它本来的行为，不是新增的失败面
    return false;
  }
}
