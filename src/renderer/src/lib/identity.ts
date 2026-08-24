// identity — "这个人叫什么、长什么样"的唯一裁决处。
//
// 同一个人有两份数据:AccountInfo 来自 auth.users(登录时 provider 给的),
// MyProfile 来自 profiles(用户自己改的)。**好友看到的是 profiles**,
// 所以自己看到的也必须是 profiles —— 否则用户改完名字,自己界面上没变,
// 只有好友那边变了,这是最难自证的一类 bug(ADR-0028)。
//
// 纯函数、无 React:显示身份的地方有四五处,规则只能有一份。

import type { AccountInfo } from "../../../shared/shellBridge.js";
import type { MyProfile } from "../../../shared/profile.js";
import { isOnboardingTestAccount } from "../../../shared/onboardingTestAccount.js";

export interface Identity {
  name: string;
  email: string;
  avatarUrl: string;
  /** 没有头像图时垫底的首字母(已大写);连名字都没有时是 "?" */
  initial: string;
}

/** 空串按"没有"处理:profiles 的 name/avatar_url 是 not null default '',
    没设过头像的行是空串而不是 null,不能拿它盖掉 provider 给的图 */
function pick(preferred: string, fallback: string): string {
  return preferred.trim() !== "" ? preferred : fallback;
}

export function displayIdentity(account: AccountInfo, profile: MyProfile | null): Identity {
  const name = pick(profile?.name ?? "", account.name);
  const email = pick(profile?.email ?? "", account.email);
  const avatarUrl = pick(profile?.avatarUrl ?? "", account.avatarUrl);
  // 取首个码点而不是 charAt:emoji 名字("🦦")按 UTF-16 切会得到半个代理对
  const first = [...name.trim()][0] ?? "";
  return { name, email, avatarUrl, initial: first.toUpperCase() || "?" };
}

/**
 * 该不该弹首登引导。
 *
 * 三个条件缺一不可:登录了、资料行已经读到了、这行还没盖过引导章。
 * 中间那条(profile 非 null)是防闪:资料是登录之后才异步拉回来的,
 * 少了它,每次登录都会先弹半秒引导再消失。
 *
 * 测试账号(issue #332)无视盖章每次都弹,但防闪条件照样要过——
 * 它重放的是真实新用户看到的东西,不该带上真实用户看不到的闪烁。
 */
export function needsOnboarding(account: AccountInfo, profile: MyProfile | null): boolean {
  if (!account.signedIn || profile === null) return false;
  return !profile.onboarded || isOnboardingTestAccount(account.email);
}
