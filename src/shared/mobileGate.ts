// 手机端进门那道闸：此刻该画冷启动、登录、「设新密码」还是主界面（#1237 M1）。
//
// 纯函数、四个输入，顺序就是优先级：
//   1. 冷启动没做完（身份库 + 读 session），或进度条没到头 → 冷启动。进度条是
//      「真实完成数 × 最短停留」两半合成（splashProgress），两边都满才放行
//   2. 没有 session → 登录
//   3. 有 session，但忘记密码那条路验完验证码、新密码还没设（也没明说跳过）→ 按住闸门。
//      同桌面 lib/identity.ts 的 showsSignInScreen（ADR-0194）：recovery OTP 换到的是
//      真 session，不按住的话一个旧密码原封不动的人就这么进去了
//   4. 其余 → 主界面
export type GateView = "splash" | "signIn" | "resetHold" | "app";

export interface GateInput {
  /** 冷启动那几步做完没有 */
  booted: boolean;
  /** 冷启动进度条到头没有（splashProgress === 1） */
  splashDone: boolean;
  hasSession: boolean;
  /** 找回密码验完验证码、新密码还没设完 */
  resetHold: boolean;
}

export function gateView(s: GateInput): GateView {
  if (!s.booted || !s.splashDone) return "splash";
  if (!s.hasSession) return "signIn";
  if (s.resetHold) return "resetHold";
  return "app";
}
