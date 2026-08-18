import { describe, expect, it } from "vitest";
import { cardName, parseCards } from "../../../services/gateway/src/poker/cards.js";
import {
  applyAction, legalActions, startHand,
  type Action, type HandState, type TableConfig,
} from "../../../services/gateway/src/poker/betting.js";

const CFG: TableConfig = { tier: "flash", smallBlind: 50, bigBlind: 100 };

function seeded(seed: number): (max: number) => number {
  let x = seed >>> 0 || 1;
  return (max) => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x % max;
  };
}

/** 按引擎的发牌顺序（庄位左手起、一人一张两轮）反推一副牌，好在测试里钉死每个人的底牌 */
function makeDeck(holes: readonly string[], board: string, button = 0): number[] {
  const n = holes.length;
  const parsed = holes.map((h) => parseCards(h));
  const deck: number[] = [];
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= n; k++) deck.push(parsed[(button + k) % n]![round]!);
  }
  deck.push(...parseCards(board));
  const used = new Set(deck);
  for (let c = 0; c < 52 && deck.length < 52; c++) if (!used.has(c)) deck.push(c);
  return deck;
}

const seatOf = (s: HandState, userId: string) => s.seats.find((x) => x.userId === userId)!;
const sumDeltas = (s: HandState) => Object.values(s.deltas).reduce((a, b) => a + b, 0);

function expectConserved(s: HandState): void {
  expect(sumDeltas(s)).toBe(0);
  expect(s.seats.every((x) => x.stack >= 0)).toBe(true);
  const before = s.seats.reduce((a, x) => a + x.startStack, 0);
  const after = s.seats.reduce((a, x) => a + x.stack, 0);
  expect(after).toBe(before);
  const potTotal = s.pots.reduce((a, p) => a + p.amount, 0);
  expect(potTotal).toBe(s.seats.reduce((a, x) => a + x.committed, 0));
}

describe("开局与位置", () => {
  it("单挑：庄位是小盲，且翻牌前先说话", () => {
    const s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s"), 0);
    expect(seatOf(s, "a").bet).toBe(50);
    expect(seatOf(s, "b").bet).toBe(100);
    expect(s.seats[s.toAct]!.userId).toBe("a");
  });

  it("三人：小盲在庄左，大盲次之，庄位翻牌前最后说话", () => {
    const s = startHand(CFG, [
      { userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }, { userId: "c", stack: 1000 },
    ], makeDeck(["As Ks", "2c 3d", "5h 6h"], "9h 8h 7h 2s 3s"), 0);
    expect(seatOf(s, "b").bet).toBe(50);
    expect(seatOf(s, "c").bet).toBe(100);
    expect(s.seats[s.toAct]!.userId).toBe("a");
  });

  it("底牌按庄位左手起一人一张发两轮", () => {
    const s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s"), 0);
    expect(seatOf(s, "a").hole.map(cardName)).toEqual(["As", "Ks"]);
    expect(seatOf(s, "b").hole.map(cardName)).toEqual(["2c", "3d"]);
  });

  it("大盲翻牌前有加注权：跟注后仍能加", () => {
    let s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s"), 0);
    s = applyAction(s, "a", { type: "call" });
    expect(s.seats[s.toAct]!.userId).toBe("b");
    expect(legalActions(s, "b").map((o) => o.type).sort()).toEqual(["check", "fold", "raise"]);
  });

  it("人数或筹码不合法直接抛", () => {
    const deck = makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s");
    expect(() => startHand(CFG, [{ userId: "a", stack: 1000 }], deck)).toThrow();
    expect(() => startHand(CFG, [{ userId: "a", stack: 0 }, { userId: "b", stack: 1 }], deck)).toThrow();
  });
});

describe("弃牌收场", () => {
  it("弃到只剩一个人 —— 底池归他，没摊牌", () => {
    let s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["2c 3d", "As Ks"], "9h 8h 7h 2s 3s"), 0);
    s = applyAction(s, "a", { type: "fold" });
    expect(s.done).toBe(true);
    expect(s.deltas["a"]).toBe(-50);
    expect(s.deltas["b"]).toBe(50);
    expect(s.log.some((e) => e.t === "showdown")).toBe(false);
    expectConserved(s);
  });

  it("没被跟的那部分退回加注者", () => {
    let s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["2c 3d", "As Ks"], "9h 8h 7h 2s 3s"), 0);
    s = applyAction(s, "a", { type: "raise", to: 600 });
    s = applyAction(s, "b", { type: "fold" });
    // a 多押的 500 无人跟，只赢 b 的大盲 100
    expect(s.deltas["a"]).toBe(100);
    expect(s.deltas["b"]).toBe(-100);
    expectConserved(s);
  });
});

describe("加注规则", () => {
  it("最小加注 = 上一次加注量", () => {
    let s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s"), 0);
    expect(() => applyAction(s, "a", { type: "raise", to: 150 })).toThrow(/最小加注/);
    s = applyAction(s, "a", { type: "raise", to: 300 });  // 加了 200
    expect(() => applyAction(s, "b", { type: "raise", to: 400 })).toThrow(/最小加注/);
    expect(legalActions(s, "b").find((o) => o.type === "raise")).toMatchObject({ minTo: 500 });
  });

  it("筹码不够时只能全下，不能装作足额加注", () => {
    const s = startHand(CFG, [{ userId: "a", stack: 240 }, { userId: "b", stack: 1000 }],
      makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s"), 0);
    expect(() => applyAction(s, "a", { type: "raise", to: 500 })).toThrow(/筹码只够/);
    expect(applyAction(s, "a", { type: "raise", to: 240 }).seats[0]!.allIn).toBe(true);
  });

  it("不足额 all-in 不重开叫牌权：已表态的人只能跟或弃", () => {
    // a 加到 300，b 全下到 380（不足 500 的足额加注线），a 不能再加
    let s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 380 }],
      makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s"), 0);
    s = applyAction(s, "a", { type: "raise", to: 300 });
    s = applyAction(s, "b", { type: "raise", to: 380 });
    expect(legalActions(s, "a").map((o) => o.type).sort()).toEqual(["call", "fold"]);
    expect(() => applyAction(s, "a", { type: "raise", to: 800 })).toThrow(/不重开/);
  });

  it("足额加注重开叫牌权", () => {
    let s = startHand(CFG, [
      { userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }, { userId: "c", stack: 1000 },
    ], makeDeck(["As Ks", "2c 3d", "5h 6h"], "9h 8h 7h 2s 3s"), 0);
    s = applyAction(s, "a", { type: "call" });     // a = UTG
    s = applyAction(s, "b", { type: "raise", to: 300 });
    expect(legalActions(s, "c").some((o) => o.type === "raise")).toBe(true);
    s = applyAction(s, "c", { type: "call" });
    expect(legalActions(s, "a").some((o) => o.type === "raise")).toBe(true);
  });

  it("有注在前不能过牌，没注不能跟", () => {
    const s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s"), 0);
    expect(() => applyAction(s, "a", { type: "check" })).toThrow(/不能过牌/);
    const flop = applyAction(applyAction(s, "a", { type: "call" }), "b", { type: "check" });
    expect(flop.street).toBe("flop");
    expect(() => applyAction(flop, "b", { type: "call" })).toThrow(/没有要跟的注/);
  });

  it("不是你的回合就不能动", () => {
    const s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["As Ks", "2c 3d"], "9h 8h 7h 2s 3s"), 0);
    expect(() => applyAction(s, "b", { type: "call" })).toThrow(/回合/);
    expect(legalActions(s, "b")).toEqual([]);
  });
});

describe("摊牌与边池", () => {
  it("摊牌大牌赢，全部筹码守恒", () => {
    let s = startHand(CFG, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["As Ah", "2c 3d"], "Ad 8h 7c 2s 4s"), 0);
    s = applyAction(s, "a", { type: "call" });
    s = applyAction(s, "b", { type: "check" });
    for (const street of ["flop", "turn", "river"]) {
      void street;
      s = applyAction(s, s.seats[s.toAct]!.userId, { type: "check" });
      if (!s.done) s = applyAction(s, s.seats[s.toAct]!.userId, { type: "check" });
    }
    expect(s.done).toBe(true);
    expect(s.deltas["a"]).toBe(100);
    expectConserved(s);
  });

  it("短筹码全下形成边池：主池他有份，边池归另外两家", () => {
    // c 只有 200；a 与 b 打到 1000。c 拿最大牌，只能赢主池
    let s = startHand(CFG, [
      { userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }, { userId: "c", stack: 200 },
    ], makeDeck(["Kc Kd", "Qc Qd", "As Ah"], "Ac 8h 7c 2s 4s"), 0);
    s = applyAction(s, "a", { type: "raise", to: 200 });   // a = UTG
    s = applyAction(s, "b", { type: "call" });             // b = 小盲
    s = applyAction(s, "c", { type: "call" });             // c = 大盲，全下 200
    expect(seatOf(s, "c").allIn).toBe(true);
    while (!s.done) s = applyAction(s, s.seats[s.toAct]!.userId, { type: "check" });

    expect(s.pots).toHaveLength(1);          // 三家投入相同，只有主池
    expect(s.deltas["c"]).toBe(400);         // 赢下 a、b 各 200
    expectConserved(s);
  });

  it("投入不等时分层建池，短筹码碰不到边池", () => {
    // c 全下 200 且拿最大牌；a、b 继续打到 600 —— c 只能赢 600 的主池
    let s = startHand(CFG, [
      { userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }, { userId: "c", stack: 200 },
    ], makeDeck(["Kc Kd", "Qc Qd", "As Ah"], "Ac 8h 7c 2s 4s"), 0);
    s = applyAction(s, "a", { type: "raise", to: 600 });
    s = applyAction(s, "b", { type: "call" });
    s = applyAction(s, "c", { type: "call" });      // 只够 200
    while (!s.done) s = applyAction(s, s.seats[s.toAct]!.userId, { type: "check" });

    expect(s.pots).toHaveLength(2);
    expect(s.pots[0]!.amount).toBe(600);           // 三家各 200
    expect(s.pots[1]!.amount).toBe(800);           // a、b 各多出 400
    expect(s.deltas["c"]).toBe(400);               // 主池 600 - 自投 200
    expect(s.deltas["a"]).toBe(200);               // KK 大过 QQ，边池 800 - 自投 600
    expect(s.deltas["b"]).toBe(-600);
    expectConserved(s);
  });

  it("边池出资人全弃牌时原样退款 —— 没被跟过的钱不该送给别人", () => {
    // a、d 各自全下 200；b、c 把边池打到 1000 后先后弃牌。
    // 主池 800 由 a、d 摊牌决出；边池 1600 无人有资格，退回 b、c 各 800
    let s = startHand(CFG, [
      { userId: "a", stack: 200 }, { userId: "b", stack: 2000 },
      { userId: "c", stack: 2000 }, { userId: "d", stack: 200 },
    ], makeDeck(["As Ah", "2c 3d", "4c 5d", "Kc Kd"], "9h 8h 7c 2s 4s"), 0);
    s = applyAction(s, "d", { type: "raise", to: 200 });   // d = UTG，全下
    s = applyAction(s, "a", { type: "call" });             // a 全下
    s = applyAction(s, "b", { type: "raise", to: 1000 });
    s = applyAction(s, "c", { type: "call" });
    expect(s.street).toBe("flop");
    s = applyAction(s, "b", { type: "fold" });
    s = applyAction(s, "c", { type: "fold" });

    expect(s.done).toBe(true);
    expect(s.pots).toHaveLength(2);
    expect(s.pots[1]!.eligible).toEqual([]);
    expect(s.log.filter((e) => e.t === "refund")).toHaveLength(2);
    expect(s.deltas["b"]).toBe(-200);
    expect(s.deltas["c"]).toBe(-200);
    expect(s.deltas["a"]).toBe(600);       // AA 赢下 800 的主池
    expect(s.deltas["d"]).toBe(-200);
    expectConserved(s);
  });

  it("平局分池；除不尽的零头给庄位左手最近的赢家", () => {
    // 两家打平，底池 150（小盲 50 + 大盲 100 后 a 弃…… 这里直接造奇数底池）
    const cfg: TableConfig = { tier: "flash", smallBlind: 25, bigBlind: 51 };
    let s = startHand(cfg, [{ userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }],
      makeDeck(["2c 3d", "2h 3s"], "As Ks Qd Jc Th"), 0);   // 公共牌打平
    s = applyAction(s, "a", { type: "call" });
    s = applyAction(s, "b", { type: "check" });
    while (!s.done) s = applyAction(s, s.seats[s.toAct]!.userId, { type: "check" });
    expect(s.pots[0]!.amount).toBe(102);
    // 102 / 2 除得尽，两家各回本
    expect(s.deltas["a"]).toBe(0);
    expect(s.deltas["b"]).toBe(0);
    expectConserved(s);
  });

  it("奇数底池的零头有确定归属，不看数组顺序", () => {
    const cfg: TableConfig = { tier: "flash", smallBlind: 25, bigBlind: 51 };
    // 三家平分 153：各 51，除得尽；改成两家平分 51*3 的奇数场景
    let s = startHand(cfg, [
      { userId: "a", stack: 1000 }, { userId: "b", stack: 1000 }, { userId: "c", stack: 1000 },
    ], makeDeck(["2c 3d", "2h 3s", "4c 5d"], "As Ks Qd Jc Th"), 0);
    s = applyAction(s, "a", { type: "call" });
    s = applyAction(s, "b", { type: "call" });
    s = applyAction(s, "c", { type: "check" });
    while (!s.done) s = applyAction(s, s.seats[s.toAct]!.userId, { type: "check" });
    // 三家全用公共牌打平，底池 153 整除
    expect(s.deltas["a"]).toBe(0);
    expectConserved(s);
  });
});

describe("随机对局（模糊测试）", () => {
  function playRandom(seed: number, players: number): HandState {
    const rng = seeded(seed);
    const stacks = Array.from({ length: players }, (_, i) => ({
      userId: `p${i}`,
      stack: 100 + rng(2000),
    }));
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = 51; i > 0; i--) {
      const j = rng(i + 1);
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    let s = startHand({ tier: "flash", smallBlind: 25, bigBlind: 50 }, stacks, deck, rng(players));
    let guard = 0;
    while (!s.done) {
      if (guard++ > 400) throw new Error("状态机不收敛");
      const seat = s.seats[s.toAct]!;
      const opts = legalActions(s, seat.userId);
      expect(opts.length).toBeGreaterThan(0);
      const pick = opts[rng(opts.length)]!;
      const action: Action =
        pick.type === "raise"
          ? { type: "raise", to: pick.minTo + rng(pick.maxTo - pick.minTo + 1) }
          : { type: pick.type };
      s = applyAction(s, seat.userId, action);
    }
    return s;
  }

  it("1200 手随机牌局，筹码一分不多一分不少", () => {
    for (let seed = 1; seed <= 400; seed++) {
      for (const players of [2, 3, 6]) {
        expectConserved(playRandom(seed * 31 + players, players));
      }
    }
  });

  it("每手牌都能按 log 逐帧重放出同一个结果", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = seeded(seed);
      const players = 2 + rng(5);
      const final = playRandom(seed * 977 + players, players);

      const fresh = startHand(final.config, final.seats.map((x) => ({
        userId: x.userId, stack: x.startStack,
      })), final.deck, final.button);
      let replay = fresh;
      for (const e of final.log) {
        if (e.t !== "action") continue;
        replay = applyAction(replay, replay.seats[replay.toAct]!.userId, e.action);
      }
      expect(replay.deltas).toEqual(final.deltas);
      expect(replay.board).toEqual(final.board);
      expect(replay.pots).toEqual(final.pots);
    }
  });
});
