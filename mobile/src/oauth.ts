// Google / GitHub 登录。桌面那侧的对照物是 src/main/account.ts 的 signIn():
// 同一个 Supabase 项目、同一套 PKCE、**同一个 redirectTo**。
//
// 为什么手机端必须有它:这个账号体系里**注册走的是 OAuth**,
// 邮箱密码那条路上很多账号根本没有密码 —— 只留密码登录的话,
// 用 Google 注册的人在手机上永远登不进来(实测报 "Invalid login credentials")。
//
// ── redirectTo 为什么指网关落地页,而不是 app 自己的深链 ──
//
// 第一版指的是 Linking.createURL("auth-callback"),也就是
// Expo Go 下的 exp://<局域网 IP>:8081/--/auth-callback。虚拟机实测:Google 登完之后
// GoTrue **悄悄回落到 SITE_URL**(浏览器停在落地页上),因为那个地址不在
// Supabase 的 Redirect URLs 白名单里 —— 而它带局域网 IP + 端口 + 路径,
// 只能靠通配去配,配错了不报错,只是"转完圈没回来"。
//
// 落地页是**桌面每天都在走的那条路**,天然已经在白名单里,零配置。
// 代价只有一次白屏:授权会话里会闪过一下"登录成功,本页可以关掉了"。
// 拿一次闪烁换掉一个会静默失败的配置步骤,划算。
//
// 会合点因此变成 scheme 拦截:落地页的 JS 做 location.replace("mrotto://auth-callback?code=…"),
// ASWebAuthenticationSession 认得我们传进去的 callbackURLScheme,一跳到它就整个关掉
// 并把 URL 交回来。**深链不需要在 Info.plist 里注册** —— 拦截依据是传进去的那个字符串,
// 不是系统的 URL 注册表,所以 Expo Go 里也成立。

import * as WebBrowser from "expo-web-browser";
import { authLandingUrl } from "../../src/shared/gatewayConfig.js";
import { supabase } from "./supabase.js";

export type OAuthProvider = "google" | "github";

/**
 * 授权完成后浏览器去的地方。**和桌面同一个值** —— 它已经在 Supabase 的
 * Redirect URLs 白名单里,不需要为手机端再配一条。
 *
 * env 传空对象:RN 里没有 process.env,而这个函数只在没设 OTTO_GATEWAY_URL 时
 * 走默认分支 —— 手机端本来也没有"本地起网关调试"这个场景。
 */
const LANDING = authLandingUrl({} as never);

/**
 * 落地页转发的深链,也是授权会话的拦截目标。必须和
 * services/gateway/src/authLanding.ts 里的 DEEP_LINK 一致 ——
 * 那边改了这边不改,表现是"授权完成后会话不关,停在落地页上"。
 */
const DEEP_LINK = "mrotto://auth-callback";

/**
 * 走完一整轮 OAuth 并把 session 落到本地存储。
 * 成功即已登录(supabase-js 内部已 setSession),调用方直接进下一屏。
 */
export async function signInWithProvider(provider: OAuthProvider): Promise<void> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    // skipBrowserRedirect:我们自己开浏览器。RN 里没有 window.location 可跳,
    // 让它自己跳等于什么都不会发生
    options: { redirectTo: LANDING, skipBrowserRedirect: true },
  });
  if (error) throw new Error(error.message);
  if (!data.url) throw new Error("Supabase 没有返回授权 URL");

  const res = await WebBrowser.openAuthSessionAsync(data.url, DEEP_LINK);
  if (res.type !== "success") {
    // cancel = 人点了"完成";dismiss = 会话被系统关掉。都不是错误,静默返回,
    // 但**不能**当成成功往下走
    throw new AuthCancelled();
  }

  const q = queryOf(res.url);
  const err = q.get("error_description") ?? q.get("error");
  if (err) throw new Error(err);
  const code = q.get("code");
  if (!code) throw new Error("回调里没有授权码");

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

/**
 * 从 mrotto://auth-callback?code=… 里取 query。
 * 不用 new URL:自定义 scheme 在 whatwg-url 里是 non-special scheme,
 * 各实现对 host/path 的切法不一致,而我们只要 '?' 后面那一截 —— 自己切最稳。
 */
function queryOf(url: string): URLSearchParams {
  const i = url.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : url.slice(i + 1));
}
