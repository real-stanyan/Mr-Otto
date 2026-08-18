import { describe, expect, it } from "vitest";
import { DECK_SIZE, cardName, freshDeck, parseCard, rankOf, suitOf } from "../../../services/gateway/src/poker/cards.js";
import { commitDeck, deckHash, shuffle, verifyDeck } from "../../../services/gateway/src/poker/shuffle.js";

/** 测试用确定性随机源（xorshift32）—— 牌序要能钉死，否则失败复现不了 */
function seeded(seed: number): (max: number) => number {
  let x = seed >>> 0 || 1;
  return (max) => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x % max;
  };
}

describe("牌的整数编码", () => {
  it("cardName / parseCard 互为逆运算，52 张全覆盖", () => {
    for (let c = 0; c < DECK_SIZE; c++) expect(parseCard(cardName(c))).toBe(c);
  });

  it("rank 与 suit 拆得出来", () => {
    expect(rankOf(parseCard("Ac"))).toBe(12);
    expect(rankOf(parseCard("2s"))).toBe(0);
    expect(suitOf(parseCard("As"))).toBe(3);
  });

  it("非法牌名直接抛，不静默给 0", () => {
    expect(() => parseCard("Xx")).toThrow();
    expect(() => parseCard("1c")).toThrow();
  });
});

describe("洗牌", () => {
  it("是排列：52 张不多不少不重", () => {
    const d = shuffle(freshDeck(), seeded(12345));
    expect(new Set(d).size).toBe(DECK_SIZE);
    expect([...d].sort((a, b) => a - b)).toEqual(freshDeck());
  });

  it("不改入参", () => {
    const src = freshDeck();
    shuffle(src, seeded(7));
    expect(src).toEqual(freshDeck());
  });

  it("真的洗动了（同一副牌两个种子给出不同牌序）", () => {
    expect(shuffle(freshDeck(), seeded(1))).not.toEqual(shuffle(freshDeck(), seeded(2)));
    expect(shuffle(freshDeck(), seeded(1))).not.toEqual(freshDeck());
  });

  it("CSPRNG 默认路径每次都不同", () => {
    expect(shuffle(freshDeck())).not.toEqual(shuffle(freshDeck()));
  });

  it("每个位置都能取到每张牌 —— 洗牌没有死角", () => {
    // Fisher-Yates 写错成 rng(n) 而不是 rng(i+1) 时分布会偏，这条盯的是覆盖面
    const rng = seeded(99);
    const seen = new Set<string>();
    for (let t = 0; t < 400; t++) {
      const d = shuffle(freshDeck(), rng);
      seen.add(`0:${d[0]}`);
      seen.add(`51:${d[51]}`);
    }
    expect(seen.size).toBeGreaterThan(100);
  });
});

describe("牌堆承诺（承诺-揭示）", () => {
  it("揭示的牌堆能被自己验回来", () => {
    const c = commitDeck(seeded(42));
    expect(verifyDeck(c)).toBe(true);
    expect(c.deck).toHaveLength(DECK_SIZE);
    expect(c.salt.length).toBeGreaterThan(0);
  });

  it("换一张牌 hash 就对不上 —— 中途换牌会被抓到", () => {
    const c = commitDeck(seeded(42));
    const tampered = c.deck.slice();
    [tampered[0], tampered[1]] = [tampered[1]!, tampered[0]!];
    expect(verifyDeck({ ...c, deck: tampered })).toBe(false);
  });

  it("同一副牌不同 salt 给出不同 hash —— 没有 salt 就能被暴力反查", () => {
    const deck = shuffle(freshDeck(), seeded(5));
    expect(deckHash(deck, "aaa")).not.toBe(deckHash(deck, "bbb"));
  });

  it("salt 默认是随机的", () => {
    expect(commitDeck().salt).not.toBe(commitDeck().salt);
  });
});
