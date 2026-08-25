// 手机端的 Supabase 客户端。连的是**和桌面同一个项目**(src/shared/authConfig.ts):
// 「按账号配对」的前提就是两端在同一个账号体系里。
//
// session 要持久化(RN 没有 localStorage,不存的话每次冷启动都要重登)。
//
// 用 **expo-sqlite/kv-store** 而不是 @react-native-async-storage/async-storage:
// 后者在 Expo Go 57 里**根本不存在**,虚拟机上第一次跑就是
// `AsyncStorageError: Native module is null` —— 它不在 Expo Go 打包的模块清单里,
// 而 kv-store 是 Expo SDK 自己的,API 与 AsyncStorage 兼容。
//
// 也不用 SecureStore 存 session:它有 2KB 上限,JWT + refresh token 会顶破。
// 真正需要保密的是身份私钥,那个在 identity.ts 里走 SecureStore。

import "react-native-url-polyfill/auto";
import AsyncStorage from "expo-sqlite/kv-store";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../../src/shared/authConfig.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // RN 里没有浏览器地址栏可解析,关掉省得它去读 window.location
    detectSessionInUrl: false,
  },
});
