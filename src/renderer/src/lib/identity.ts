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

/**
 * 该不该把人拦在进门那道闸上（SignInScreen，ADR-0182）。
 *
 * 判据是「有没有登录记录」而不是「此刻登录着没有」——两条都不能少：
 *
 * - `authRecord` 单独就够放行：冷启动时 `getAccount()` 几乎必然先回未登录
 *   （主进程的 `restore()` 是 fire-and-forget，还要等一次 `auth.getUser()` 的网络
 *   往返），照 `signedIn` 判定的话已登录用户每次开 app 都会先闪一屏登录页；
 *   断网时 `restore()` 更是永远回不来，等于把人锁在自己的桌面软件外面。
 * - `signedIn` 也单独够放行：登录成功那一刻 `onAccountChanged` 先到，
 *   `authRecord` 由同一次 set 一起翻，但顺序不该由这里假设。
 *
 * 代价说清楚：session 被服务端吊销、而 auth.json 还躺在本地的用户仍然进得来，
 * 只是进去之后处处是未登录态（账号页画的还是登录卡）。用「锁不住少数过期
 * session」换「断网不锁人」，这笔账是故意这么算的。
 */
export function needsSignIn(account: AccountInfo, authRecord: boolean): boolean {
  return !account.signedIn && !authRecord;
}

/**
 * 闸门那一屏到底画不画。= 「还没进来」**或**「正在门口把重置走完」（issue #744）。
 *
 * 后半句解释一下。忘记密码填完验证码那一刻，人**已经是登录态**了 —— recovery OTP
 * 换到的是一个真 session，`needsSignIn` 立刻变 false，闸门自己抬起来。于是出现了
 * 维护者截图里那一幕：整个 app 已经在背后铺开，前面压着一张「设一个新密码」，
 * 而「以后再说」等于让一个**旧密码一个字没变**的人就这么进去了。
 *
 * 重置该在门外走完。做法不是让那张弹窗跨过闸门活着（那要两个挂载点 + 一份搬进
 * store 的状态），而是反过来 —— **让闸门先别抬**，等这一步结束再放行。
 *
 * `holdForPasswordReset` 只在「从闸门进来的那条路」上为真：账号页也渲染同一张登录卡
 * （有记录但没验上的人落在那儿），那些人本来就在 app 里，把他们的界面换成登录屏
 * 是另一种意外。所以这个判据由**发起方**给，不从 `resetPending` 反推。
 */
export function showsSignInScreen(
  account: AccountInfo,
  authRecord: boolean,
  holdForPasswordReset: boolean,
): boolean {
  return needsSignIn(account, authRecord) || holdForPasswordReset;
}
