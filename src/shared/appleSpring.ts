// Apple 的弹簧口径 → 物理三元组。
//
// Apple 把「质量 / 劲度 / 阻尼」换成了两个给设计师用的量：
//   damping ratio ζ —— 1.0 是临界阻尼（不过冲），< 1 会回弹
//   response —— 到达目标的快慢（秒），不是时长（弹簧没有固定时长）
// RN 的 Animated.spring 只吃物理量，这里做换算（质量取 1）：
//   ω₀ = 2π / response，stiffness = ω₀²，damping = 2ζω₀
//
// 从 mobile/src/theme.ts 挪到 src/shared：手机端的类型检查不在门禁里（#422），
// 纯函数放这儿才有测试跟着根门禁跑。
export interface SpringPhysics {
  stiffness: number;
  damping: number;
  mass: number;
}

export function appleSpring(response: number, dampingRatio = 1): SpringPhysics {
  const w0 = (2 * Math.PI) / response;
  return { stiffness: Math.round(w0 * w0), damping: Math.round(2 * dampingRatio * w0), mass: 1 };
}
