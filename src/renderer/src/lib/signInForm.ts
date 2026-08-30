// signInForm — 登录/注册那张表单「能不能提交」「该不该念叨」的两条规则。
//
// 抽出来是因为它们**随 mode 变**：注册多一个「再输一遍密码」，登录没有。
// 写在组件里就是一串串起来的三元表达式，改一处忘一处；而这两条恰好是纯函数。

import { NAME_MAX } from "../../../shared/profile.js";

export type SignInMode = "sign-in" | "sign-up";

export { NAME_MAX };

export interface SignInFormState {
  mode: SignInMode;
  /** 用户名。只有注册态有这一格；上限沿用 `NAME_MAX`（24，理由见 shared/profile.ts：
      那是**版面**的上限，侧栏/会话头部/好友列表都只有一行宽） */
  name: string;
  email: string;
  password: string;
  /** 「再输一遍」那格。登录态下无意义，传空串即可 */
  confirm: string;
  /** 正在提交 */
  busy: boolean;
}

/** 密码下限。与 supabase 项目设置一致（GoTrue 默认 6）—— 本地先拦一道，
    省得为一个一眼可见的问题跑一趟网络 */
export const MIN_PASSWORD = 6;

/**
 * 提交键亮不亮。
 *
 * 注册比登录多一条：两次输入必须一致。这一条**故意做成"按不动"而不是"按了报错"**——
 * 密码是看不见的，用户没法回头核对自己打了什么，让他在按之前就知道对不上，
 * 比按下去再告诉他有用得多。
 *
 * 邮箱这里只作最粗的判断（有 @），真正的形状检查在提交那一刻走
 * `localEmailProblem`：把「@qq 少个 .com」做成按不动的话，用户会盯着一个
 * 灰按钮猜自己哪儿错了。**能说清原因的错，让它可提交然后说话；说不清的，才拦在门外。**
 */
export function canSubmitSignIn(s: SignInFormState): boolean {
  if (s.busy) return false;
  if (!s.email.includes("@")) return false;
  if (s.password.length < MIN_PASSWORD) return false;
  if (s.mode === "sign-up") {
    // 名字必填:留空虽然有兜底(触发器退回邮箱前缀),但表单上摆着一个可以空着的格子
    // 会让人以为"填不填都行",然后在好友列表里看到自己叫 1464729020
    if (s.name.trim() === "") return false;
    if (s.password !== s.confirm) return false;
  }
  return true;
}

/**
 * 「再输一遍」那格底下要不要念一句、念什么。
 *
 * 只在**已经打了字**之后才念：一格还空着就红着说"不一样"，那不是提示，是催促。
 * 同理，只在注册态下有意义。
 */
export function confirmHint(s: SignInFormState): string | null {
  if (s.mode !== "sign-up") return null;
  if (s.confirm === "") return null;
  return s.password === s.confirm ? null : "两次输入不一样";
}
