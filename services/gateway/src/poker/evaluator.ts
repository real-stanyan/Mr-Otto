// 7 张里取最优 5 张，结果压成一个可直接比大小的整数。
//
// 为什么是整数而不是 {category, kickers[]} 结构：摊牌要在多个边池里反复比，
// 比较逻辑写一次错一次；压成整数之后"谁大"就是 a > b，没有第二种写法。
// 编码：cat * 16^5 + r1*16^4 + ... + r5。rank 值域 0..12 落在 4 bit 内，
// 最大值 8*16^5 ≈ 8.4e6，远在安全整数内。
//
// 算法就是暴力枚举 C(7,5)=21 种组合。有查表法能快两个数量级，
// 但这里一手牌最多算 10 次，21 次组合是微秒级——省下的时间买不到
// 一张 130 KB 查表的正确性。

import { rankOf, suitOf } from "./cards.js";

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
} as const;

export const CATEGORY_NAME = [
  "高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺",
] as const;

export const categoryOf = (score: number): number => Math.floor(score / 16 ** 5);

function pack(category: number, ranks: readonly number[]): number {
  let v = category;
  for (let i = 0; i < 5; i++) v = v * 16 + (ranks[i] ?? 0);
  return v;
}

/**
 * 去重降序的 rank 数组里找顺子，返回顺子的最大牌 rank；没有则 null。
 * A-2-3-4-5（轮子）单独判：A 在这里当 1 用，整手顺子的大小由 5 决定。
 */
function straightHigh(desc: readonly number[]): number | null {
  for (let i = 0; i + 4 < desc.length; i++) {
    if (desc[i]! - desc[i + 4]! === 4) return desc[i]!;
  }
  const has = (r: number) => desc.includes(r);
  if (has(12) && has(3) && has(2) && has(1) && has(0)) return 3;
  return null;
}

/** 给定正好 5 张牌打分 */
export function score5(cards: readonly number[]): number {
  if (cards.length !== 5) throw new Error(`score5 要 5 张牌，给了 ${cards.length} 张`);
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const suit0 = suitOf(cards[0]!);
  const isFlush = cards.every((c) => suitOf(c) === suit0);
  const uniqueDesc = [...new Set(ranks)];
  const sHigh = straightHigh(uniqueDesc);

  if (isFlush && sHigh !== null) return pack(CATEGORY.STRAIGHT_FLUSH, [sHigh]);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // 先按张数降序、同张数再按 rank 降序 —— 这正好就是踢脚的比较顺序
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join("");
  const byGroup = groups.map((g) => g[0]);

  if (shape === "41") return pack(CATEGORY.QUADS, byGroup);
  if (shape === "32") return pack(CATEGORY.FULL_HOUSE, byGroup);
  if (isFlush) return pack(CATEGORY.FLUSH, ranks);
  if (sHigh !== null) return pack(CATEGORY.STRAIGHT, [sHigh]);
  if (shape === "311") return pack(CATEGORY.TRIPS, byGroup);
  if (shape === "221") return pack(CATEGORY.TWO_PAIR, byGroup);
  if (shape === "2111") return pack(CATEGORY.PAIR, byGroup);
  return pack(CATEGORY.HIGH_CARD, ranks);
}

export interface Evaluated {
  readonly score: number;
  /** 组成最优牌型的那 5 张，给 UI 高亮用 */
  readonly best: readonly number[];
}

/** 5..7 张里取最优 5 张 */
export function evaluate(cards: readonly number[]): Evaluated {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate 要 5..7 张牌，给了 ${cards.length} 张`);
  }
  let best: readonly number[] = [];
  let score = -1;
  const n = cards.length;
  // 五重循环而不是递归生成组合：n 最大 7，展开后没有分配、没有闭包
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const hand = [cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!];
            const s = score5(hand);
            if (s > score) {
              score = s;
              best = hand;
            }
          }
  return { score, best };
}
