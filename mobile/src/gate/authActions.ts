// 进门的动作，逐个对照桌面 src/main/account.ts 的 AccountManager：同一个 Supabase 项目、
// 同一个 redirectTo（边缘服务的落地页）。报错一律把 supabase 的原文抛出去，
// 由界面交给 shared/authError.ts 的 authNoticeOf 翻成人话。
// 这一份先放登录；注册（Task 7）与找回密码（Task 8）接着往下加。
import { authLandingUrl } from "../../../src/shared/edgeConfig.js";
import { NAME_MAX } from "../../../src/shared/profile.js";
import { supabase } from "../supabase.js";

/** 和桌面同一个 redirectTo（边缘服务的落地页），天然在 Supabase 的 Redirect URLs 白名单里（见 oauth.ts 顶部） */
const LANDING = authLandingUrl({} as never);

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/** 等确认信那张弹窗的探测：邮箱还没点时失败是预期，不抛、只回布尔 */
export async function trySignIn(email: string, password: string): Promise<boolean> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return !error;
}

/**
 * 注册。两种正常结局（同桌面 signUpWithPassword）："signed-in" = 项目免邮箱确认、注册即登录；
 * "confirm-email" = 有 user 没 session，要去邮箱点确认链接。名字走 options.data，
 * profiles 那一行由 migration 0007 的触发器取它填；空名字不传（触发器退回邮箱前缀）
 */
export async function signUp(
  email: string, password: string, name: string,
): Promise<"signed-in" | "confirm-email"> {
  const trimmed = name.trim().slice(0, NAME_MAX);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: LANDING, ...(trimmed === "" ? {} : { data: { name: trimmed } }) },
  });
  if (error) throw new Error(error.message);
  return data.session ? "signed-in" : "confirm-email";
}
