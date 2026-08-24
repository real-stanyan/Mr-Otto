// QA 测试账号（issue #332）：这些邮箱每次登录都强制重放完整新用户引导
// （profile 弹窗 + 模型弹窗），无视 onboarded_at / keyStatus / localStorage 章，
// 关闭也不盖章——同一台机器上的真账号不受它污染。
//
// 为什么是常量而不是 DB 标记：登录只有 OAuth，"测试账号"本质是一个真能
// OAuth 登录的备用邮箱；两个引导的"已看过"记号又分居两处（服务端
// onboarded_at / 本机 localStorage），只有代码里这一个开关能同时罩住两边。
const TEST_ONBOARDING_EMAILS = ["stan@herzpharmaceuticals.com"];

/** 邮箱不区分大小写；空串（未登录）永远不命中 */
export function isOnboardingTestAccount(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (normalized === "") return false;
  return TEST_ONBOARDING_EMAILS.includes(normalized);
}
