// Google / GitHub 登录。桌面那侧的对照物是 src/main/account.ts 的 signIn():
// 同一个 Supabase 项目、同一套 PKCE,只是"把浏览器打开"和"把 code 收回来"
// 在手机上是同一次调用(ASWebAuthenticationSession),不需要深链监听器。
//
// 为什么手机端必须有它:这个账号体系里**注册走的是 OAuth**,
// 邮箱密码那条路上很多账号根本没有密码 —— 只留密码登录的话,
// 用 Google 注册的人在手机上永远登不进来(实测报 "Invalid login credentials")。
//
// 与桌面**刻意分歧**的一点:桌面 redirectTo 指向网关的落地页
// (gatewayConfig.authLandingUrl),因为桌面浏览器渲染不了 mrotto:// 深链,
// 标签页会停在 Google 的旧页面上像卡死。手机上没有这个问题:
// openAuthSessionAsync 开的是 app 内嵌的授权会话,一跳到我们的 scheme
// 就整个关掉并把 URL 交回来 —— 中间加一页落地页只是多一次白屏。

import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "./supabase.js";

export type OAuthProvider = "google" | "github";

/**
 * 授权完成后回跳到 app 的地址。**两种运行形态给出的值不一样**,
 * 这正是它必须现算、不能写死的原因:
 *   Expo Go   → exp://<局域网 IP>:8081/--/auth-callback   (IP 随网络变)
 *   独立构建   → mrotto://auth-callback                    (app.json 的 scheme)
 * 两者都必须在 Supabase 的 Redirect URLs 白名单里,否则 GoTrue 会
 * 悄悄回落到 SITE_URL —— 表现为授权页转完圈却没回到 app。
 * 所以失败信息里要把这个地址原样打出来,让人知道该往白名单里加哪一行。
 */
export function redirectUri(): string {
  return Linking.createURL("auth-callback");
}

/**
 * 走完一整轮 OAuth 并把 session 落到本地存储。
 * 成功即已登录(supabase-js 内部已 setSession),调用方直接进下一屏。
 */
export async function signInWithProvider(provider: OAuthProvider): Promise<void> {
  const to = redirectUri();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    // skipBrowserRedirect:我们自己开浏览器。RN 里没有 window.location 可跳,
    // 让它自己跳等于什么都不会发生
    options: { redirectTo: to, skipBrowserRedirect: true },
  });
  if (error) throw new Error(error.message);
  if (!data.url) throw new Error("Supabase 没有返回授权 URL");

  const res = await WebBrowser.openAuthSessionAsync(data.url, to);
  if (res.type !== "success") {
    // cancel = 人点了"完成";dismiss = 会话被系统关掉。都不是错误,静默返回,
    // 但**不能**当成成功往下走
    throw new AuthCancelled();
  }

  // 用 Linking.parse 而不是 new URL:Expo Go 的回跳是 exp://host/--/path?code=…,
  // 那个 `/--/` 分隔符只有 expo-linking 认得
  const q = Linking.parse(res.url).queryParams ?? {};
  const err = first(q.error_description) ?? first(q.error);
  if (err) throw new Error(err);
  const code = first(q.code);
  if (!code) throw new Error(`回调里没有授权码。请确认 ${to} 在 Supabase 的 Redirect URLs 里`);

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) throw new Error(exchangeError.message);
}

/** 用户自己取消。调用方据此不报红 —— 取消不是故障 */
export class AuthCancelled extends Error {
  constructor() {
    super("已取消");
    this.name = "AuthCancelled";
  }
}

/** queryParams 的值可能是 string | string[](同名参数重复时) */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
