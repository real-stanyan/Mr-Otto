// forgotPassword — 「忘记密码」那张弹窗的纯规则：验证码长什么样、什么时候能提交、
// 重发按钮什么时候解冻。
//
// 抽出来的理由和 signInForm.ts 一样：这些判断**随步骤变**，写在组件里就是一串三元
// 表达式；而它们恰好都是纯函数，值得单独钉住。

/**
 * 验证码位数。
 *
 * **8 不是随手挑的**：真值在 Supabase 项目的 `mailer_otp_length`（本项目实测 = 8，
 * GoTrue 默认是 6）。这里只是把那个远端配置抄了一份下来 —— 抄错的后果很轻但很烦：
 * 输入框的 maxLength 会把最后两位吃掉，用户看着自己打完的码提交不了。
 * 改那边的话记得改这里（这条耦合没有办法在本地断掉：签发方在服务端）。
 */
export const OTP_LENGTH = 8;

/** 重发冷却。GoTrue 自己对同一邮箱有 60 秒的 `For security purposes…` 限制 ——
    按钮冻住的时间对齐它，省得用户点了才被服务端骂一句 */
export const RESEND_COOLDOWN_S = 60;

export type ForgotStep = "email" | "code";

/**
 * 用户打进去的东西 → 一串验证码。
 *
 * **只留数字、砍到 6 位**：人从邮件里复制，十有八九会带上空格、换行，或者把
 * 「验证码：123456」整句粘进来。与其在提交那一刻报「码不对」，不如在输入框里就把
 * 它收拾干净 —— 这一步不是校验，是替用户擦桌子。
 */
export function normalizeOtp(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, OTP_LENGTH);
}

/** 「提交」亮不亮：位数够了、且没在飞 */
export function canSubmitOtp(code: string, busy: boolean): boolean {
  return !busy && normalizeOtp(code).length === OTP_LENGTH;
}

/**
 * 重发按钮上写什么。
 *
 * 冷却期内**把秒数写出来**而不是只把按钮灰掉：一个没有理由的灰按钮会让人反复去点，
 * 一个在倒数的按钮告诉他「等就行」。
 */
export function resendLabel(secondsLeft: number): string {
  return secondsLeft > 0 ? `重新发送（${secondsLeft}s）` : "重新发送";
}
