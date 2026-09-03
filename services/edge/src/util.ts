// 整个 edge 目录共用的小工具。这一层与 edge.ts / billing.ts 同一纪律：
// 纯函数、不碰任何运行时（worker.ts 是唯一例外，它是装配层）。

/**
 * 恒时字符串比较，堵一个基于响应时间猜 secret 内容的边信道。
 * 长度不等时直接 false 是允许的短路 —— 长度本身不构成"猜中了多少字节"的信号，
 * 真正要防的是"等长时逐字节比对提前退出"那条时间差。
 *
 * 以前在 edge.ts 与 billing.ts 里各抄了一份（ADR-0203 已知未做）——两份逐字相同的
 * 安全代码比一份更危险：改一边忘另一边，差异安静地活下来。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
