// 洗牌。用 node:crypto 的 randomInt，不用 Math.random。
//
// Math.random 是可预测的 PRNG：拿到几手牌的输出就能反推内部状态，
// 之后每一手的底牌都是明牌。筹码是真额度，这不是理论风险。
// randomInt 走 CSPRNG 且做了拒绝采样，取模偏差也一并没有了
// （naive 的 rand % n 会让小索引概率偏高，等于牌堆前半段被洗得更松）。

import { createHash, randomBytes, randomInt } from "node:crypto";
import { freshDeck } from "./cards.js";

/** 注入随机源：测试要能钉死牌序，生产走 CSPRNG */
export type RandomInt = (maxExclusive: number) => number;

const cryptoRandomInt: RandomInt = (max) => randomInt(max);

/** Fisher-Yates，从后往前。返回新数组，不改入参 */
export function shuffle(cards: readonly number[], rng: RandomInt = cryptoRandomInt): number[] {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

/**
 * 牌堆承诺：开局公布 hash，摊牌后公布 deck + salt。
 *
 * 为什么值这三十行：服务端权威解决的是"别人看不到我的底牌"，
 * 但没解决"庄家自己会不会看"。承诺-揭示让任何一个玩家事后能自己算一遍
 * ——牌堆在开局那一刻就已经定死，庄家中途换牌会对不上 hash。
 * 把"相信我"换成"你自己验"。
 */
export interface DeckCommitment {
  readonly deck: readonly number[];
  readonly salt: string;
  readonly hash: string;
}

/** salt 必须是随机的：牌堆只有 52! 种但 hash 是确定的，没有 salt 就能被暴力反查 */
export function commitDeck(rng: RandomInt = cryptoRandomInt, salt?: string): DeckCommitment {
  const deck = shuffle(freshDeck(), rng);
  const s = salt ?? randomBytes(16).toString("hex");
  return { deck, salt: s, hash: deckHash(deck, s) };
}

export function deckHash(deck: readonly number[], salt: string): string {
  return createHash("sha256").update(`${salt}:${deck.join(",")}`).digest("hex");
}

/** 玩家事后自验用的同一个函数 —— 验证方与生成方共用一份代码，免得两边算法漂移 */
export function verifyDeck(c: DeckCommitment): boolean {
  return deckHash(c.deck, c.salt) === c.hash;
}
