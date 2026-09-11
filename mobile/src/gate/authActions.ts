// 进门的动作，逐个对照桌面 src/main/account.ts 的 AccountManager：同一个 Supabase 项目、
// 同一个 redirectTo（边缘服务的落地页）。报错一律把 supabase 的原文抛出去，
// 由界面交给 shared/authError.ts 的 authNoticeOf 翻成人话。
// 这一份先放登录；注册（Task 7）与找回密码（Task 8）接着往下加。
import { supabase } from "../supabase.js";

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}
