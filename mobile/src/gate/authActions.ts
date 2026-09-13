// 进门的动作，逐个对照桌面 src/main/account.ts 的 AccountManager：同一个 Supabase 项目、
// 同一个 redirectTo（边缘服务的落地页）。报错一律把 supabase 的原文抛出去，
// 由界面交给 shared/authError.ts 的 authNoticeOf 翻成人话。
// 登录、注册、找回密码三组动作都在这一个文件里。
import { NAME_MAX } from "../../../src/shared/profile.js";
import { LANDING } from "../oauth.js";
import { supabase } from "../supabase.js";

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/** 等确认信那张弹窗的探测：邮箱还没点时失败是预期，不抛、只回布尔。断网这类异常也收成 false——
    轮询那条 setTimeout 链与「我已确认」的转圈都靠这句「不抛」：抛一次，前者断在半路、后者转个不停 */
export async function trySignIn(email: string, password: string): Promise<boolean> {
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return !error;
  } catch {
    return false;
  }
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

/** 发重置邮件。「查无此人」不报错是故意的（同桌面 resetPassword 的注释）：
    不然等于把「这个邮箱注册过没有」做成一个人人可查的接口 */
export async function sendReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: LANDING });
  if (error) throw new Error(error.message);
}

/** 验重置邮件里那串码。验过就是登录态（recovery OTP 换到真 session）——所以调用方要先按住闸门 */
export async function verifyReset(email: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "recovery" });
  if (error) throw new Error(error.message);
}

/** 设新密码。调用方保证此刻有 session（验码换来的那个就算） */
export async function setNewPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error(error.message);
}
