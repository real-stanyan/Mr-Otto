// 手机端的 Supabase 客户端。连的是**和桌面同一个项目**(src/shared/authConfig.ts):
// 「按账号配对」的前提就是两端在同一个账号体系里。
//
// session 落 AsyncStorage:RN 没有 localStorage,而不持久化的话每次冷启动都要重登。
// 不用 SecureStore 存 session —— 它有 2KB 上限,JWT + refresh token 会顶破;
// 真正需要保密的是身份私钥,那个在 identity.ts 里走 SecureStore。

import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
