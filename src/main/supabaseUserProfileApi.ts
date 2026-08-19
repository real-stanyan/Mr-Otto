// supabaseUserProfileApi — UserProfileApi 的真 supabase 实现(对应
// supabaseFriendsApi.ts 之于 friends.ts)。查询链薄到无逻辑,错误原样上抛,
// 由 UserProfileManager 收敛成 ProfileResult。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MyProfileRow, UserProfileApi } from "./userProfile.js";

/** 每次都取全列:改完要拿改后的真行回渲染层(乐观 UI 的落地依据) */
const COLUMNS = "id,email,name,avatar_url,onboarded_at";

function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export function createSupabaseUserProfileApi(client: SupabaseClient): UserProfileApi {
  return {
    async getUserId() {
      const { data } = await client.auth.getUser();
      return data.user?.id ?? null;
    },

    async loadProfile(uid) {
      // maybeSingle 而不是 single:profiles 的行由 auth.users 的触发器建,
      // 注册那一瞬间可能还没到 —— 那是"还没有",不是错误
      const res = await client.from("profiles").select(COLUMNS).eq("id", uid).maybeSingle();
      return unwrap(res) as MyProfileRow | null;
    },

    async saveProfile(uid, patch) {
      // .eq("id", uid) 不是多余的:RLS 已经挡住改别人的行,但没有它这条 update
      // 会是全表更新,被 RLS 收成 0 行,然后 single() 报一个和"权限"无关的错
      const res = await client.from("profiles").update(patch).eq("id", uid)
        .select(COLUMNS).single();
      return unwrap(res) as MyProfileRow;
    },
  };
}
