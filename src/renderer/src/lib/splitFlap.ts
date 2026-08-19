// split-flap（机场翻牌板）的逐帧计算。底池跳数字时,每一位像翻牌板一样
// 滚过一串字符再停在目标上。纯函数,组件只负责 setInterval 驱动 tick。

/** 每一位翻满多少帧才落定 */
export const FLAP_FRAMES = 8;
/** 相邻位错开的帧数 —— 翻牌板从左到右一列列停下来,不是齐刷刷一起停 */
export const FLAP_STAGGER = 2;

/**
 * 第 tick 帧该显示什么。
 * 没变的位原地不动;变了的位先按住旧字符,轮到自己后滚 charset,滚满落定。
 */
export function splitFlapFrame(from: string, to: string, tick: number, charset: string): string {
  let out = "";
  for (let i = 0; i < to.length; i++) {
    const target = to[i]!;
    const source = from[i] ?? " ";
    if (source === target) {
      out += target;
      continue;
    }
    const steps = tick - i * FLAP_STAGGER;
    if (steps <= 0) out += source;
    else if (steps >= FLAP_FRAMES) out += target;
    else out += charset[(steps + i * 3) % charset.length]!;
  }
  return out;
}

/** 全部落定所需的帧数（最后一位的错开 + 翻满） */
export function splitFlapTotalTicks(to: string): number {
  return Math.max(0, to.length - 1) * FLAP_STAGGER + FLAP_FRAMES;
}
