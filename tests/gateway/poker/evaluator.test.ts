import { describe, expect, it } from "vitest";
import { parseCards } from "../../../services/gateway/src/poker/cards.js";
import { CATEGORY, categoryOf, evaluate, score5 } from "../../../services/gateway/src/poker/evaluator.js";

const cat = (hand: string) => categoryOf(score5(parseCards(hand)));
const s = (hand: string) => evaluate(parseCards(hand)).score;

describe("score5 牌型识别", () => {
  it("认得全部九种牌型", () => {
    expect(cat("As Ks Qs Js Ts")).toBe(CATEGORY.STRAIGHT_FLUSH);
    expect(cat("9c 9d 9h 9s 2c")).toBe(CATEGORY.QUADS);
    expect(cat("9c 9d 9h 2s 2c")).toBe(CATEGORY.FULL_HOUSE);
    expect(cat("As Js 9s 5s 2s")).toBe(CATEGORY.FLUSH);
    expect(cat("9c 8d 7h 6s 5c")).toBe(CATEGORY.STRAIGHT);
    expect(cat("9c 9d 9h 6s 5c")).toBe(CATEGORY.TRIPS);
    expect(cat("9c 9d 6h 6s 5c")).toBe(CATEGORY.TWO_PAIR);
    expect(cat("9c 9d 7h 6s 5c")).toBe(CATEGORY.PAIR);
    expect(cat("Ac Jd 7h 6s 5c")).toBe(CATEGORY.HIGH_CARD);
  });

  it("轮子 A2345 是顺子，且按 5 算大小 —— 输给 6 高的顺子", () => {
    expect(cat("Ac 2d 3h 4s 5c")).toBe(CATEGORY.STRAIGHT);
    expect(s("Ac 2d 3h 4s 5c")).toBeLessThan(s("6c 2d 3h 4s 5c"));
  });

  it("同花轮子是同花顺，且是最小的那个同花顺", () => {
    expect(cat("Ac 2c 3c 4c 5c")).toBe(CATEGORY.STRAIGHT_FLUSH);
    expect(s("Ac 2c 3c 4c 5c")).toBeLessThan(s("6c 2c 3c 4c 5c"));
  });

  it("牌型大小严格递增", () => {
    const ladder = [
      "Ac Jd 7h 6s 5c", "9c 9d 7h 6s 5c", "9c 9d 6h 6s 5c", "9c 9d 9h 6s 5c",
      "9c 8d 7h 6s 5c", "As Js 9s 5s 2s", "9c 9d 9h 2s 2c", "9c 9d 9h 9s 2c",
      "As Ks Qs Js Ts",
    ];
    for (let i = 1; i < ladder.length; i++) {
      expect(s(ladder[i]!)).toBeGreaterThan(s(ladder[i - 1]!));
    }
  });

  it("同牌型比踢脚", () => {
    expect(s("Ac Ad Kh 7s 5c")).toBeGreaterThan(s("Ac Ad Qh 7s 5c"));
    expect(s("Kc Kd Qh Qs Ac")).toBeGreaterThan(s("Kc Kd Qh Qs Jc"));
    // 葫芦先比三条那张，跟对子无关
    expect(s("9c 9d 9h 2s 2c")).toBeGreaterThan(s("8c 8d 8h As Ac"));
  });

  it("完全同型不同花 = 平手", () => {
    expect(s("Ac Kd Qh Js 9c")).toBe(s("Ah Ks Qc Jd 9h"));
  });
});

describe("evaluate 七选五", () => {
  it("从 7 张里挑出最优的 5 张", () => {
    const ev = evaluate(parseCards("As Ks Qs Js Ts 2c 3d"));
    expect(categoryOf(ev.score)).toBe(CATEGORY.STRAIGHT_FLUSH);
    expect(ev.best).toHaveLength(5);
  });

  it("不会被多余的牌骗成更小的牌型", () => {
    // 手里 4 条 9，另有 AK：应当认四条而不是三条+A 踢脚
    expect(categoryOf(evaluate(parseCards("9c 9d 9h 9s Ac Kd 2h")).score)).toBe(CATEGORY.QUADS);
    // 六张同花色里取最大的五张
    const ev = evaluate(parseCards("As Ks 9s 5s 2s 3s 7d"));
    expect(categoryOf(ev.score)).toBe(CATEGORY.FLUSH);
    expect(ev.score).toBe(score5(parseCards("As Ks 9s 5s 3s")));
  });

  it("公共牌就是最大牌时两家打平", () => {
    const board = "As Ks Qs Js Ts";
    expect(evaluate(parseCards(`${board} 2c 3d`)).score)
      .toBe(evaluate(parseCards(`${board} 7h 8h`)).score);
  });

  it("张数不对直接抛", () => {
    expect(() => evaluate(parseCards("As Ks Qs Js"))).toThrow();
    expect(() => score5(parseCards("As Ks Qs Js Ts 9s"))).toThrow();
  });
});
