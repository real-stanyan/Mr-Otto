import { describe, expect, it } from "vitest";
import {
  applyAction, legalActions, startHand, type HandState,
} from "../../../services/gateway/src/poker/betting.js";
import { commitDeck } from "../../../services/gateway/src/poker/shuffle.js";
import { cardsIn, viewFor } from "../../../services/gateway/src/poker/view.js";

function seeded(seed: number): (max: number) => number {
  let x = seed >>> 0 || 1;
  return (max) => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x % max;
  };
}

function deal(seed: number, players = 3) {
  const rng = seeded(seed);
  const c = commitDeck(rng);
  const state = startHand(
    { tier: "flash", smallBlind: 25, bigBlind: 50 },
    Array.from({ length: players }, (_, i) => ({ userId: `p${i}`, stack: 200 + rng(1500) })),
    c.deck,
    rng(players)
  );
  return { state, src: (s: HandState) => ({ handId: "h", tableId: "t", state: s, commitment: c }) };
}

function playToEnd(state: HandState, rng: (m: number) => number): HandState {
  let s = state;
  while (!s.done) {
    const seat = s.seats[s.toAct]!;
    const opts = legalActions(s, seat.userId);
    const pick = opts[rng(opts.length)]!;
    s = applyAction(s, seat.userId, pick.type === "raise"
      ? { type: "raise", to: pick.minTo + rng(pick.maxTo - pick.minTo + 1) }
      : { type: pick.type });
  }
  return s;
}

describe("底牌可见性", () => {
  it("牌局进行中，只看得到自己的底牌", () => {
    const { state, src } = deal(11);
    const v = viewFor("p1", src(state));
    expect(v.seats.find((s) => s.userId === "p1")!.hole).toHaveLength(2);
    for (const s of v.seats) if (s.userId !== "p1") expect(s.hole).toBeNull();
  });

  it("进行中的视图里，出现过的牌恰好是「自己两张 + 公共牌」—— 一张多的都没有", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const { state, src } = deal(seed * 7);
      const rng = seeded(seed);
      let s = state;
      // 随机走几步，停在牌局中途
      for (let k = 0; k < 3 + rng(6) && !s.done; k++) {
        const seat = s.seats[s.toAct]!;
        const opts = legalActions(s, seat.userId);
        const pick = opts[rng(opts.length)]!;
        s = applyAction(s, seat.userId, pick.type === "raise"
          ? { type: "raise", to: pick.minTo + rng(pick.maxTo - pick.minTo + 1) }
          : { type: pick.type });
      }
      if (s.done) continue;
      for (const me of s.seats) {
        const v = viewFor(me.userId, src(s));
        const seen = [...cardsIn(v)].sort((a, b) => a - b);
        const expected = [...me.hole, ...s.board].sort((a, b) => a - b);
        expect(seen).toEqual(expected);
      }
    }
  });

  it("牌堆在摊牌前一律不给", () => {
    const { state, src } = deal(5);
    const v = viewFor("p0", src(state));
    expect(v.commitment.deck).toBeNull();
    expect(v.commitment.salt).toBeNull();
    expect(v.commitment.hash).toHaveLength(64);
  });

  it("摊牌后揭示牌堆与 salt，玩家能自己验", () => {
    const { state, src } = deal(9);
    const s = playToEnd(state, seeded(9));
    const v = viewFor("p0", src(s));
    expect(v.commitment.deck).toHaveLength(52);
    expect(typeof v.commitment.salt).toBe("string");
  });

  it("摊了牌的人亮牌，弃了牌的人到底也不亮", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const { state, src } = deal(seed * 13);
      const s = playToEnd(state, seeded(seed * 31));
      const showdownSeats = new Set(
        s.log.filter((e) => e.t === "showdown").map((e) => (e as { seat: number }).seat)
      );
      const v = viewFor("p0", src(s));
      v.seats.forEach((seat, i) => {
        if (seat.userId === "p0") return;
        if (showdownSeats.has(i)) expect(seat.hole).toHaveLength(2);
        else expect(seat.hole).toBeNull();
      });
      // 弃牌的人永远不在摊牌名单里
      for (const i of showdownSeats) expect(s.seats[i]!.folded).toBe(false);
    }
  });

  it("全员弃到只剩一个 —— 谁的底牌都不亮", () => {
    const { state, src } = deal(3, 2);
    let s = state;
    s = applyAction(s, s.seats[s.toAct]!.userId, { type: "fold" });
    expect(s.done).toBe(true);
    for (const me of ["p0", "p1"]) {
      const v = viewFor(me, src(s));
      for (const seat of v.seats) {
        if (seat.userId !== me) expect(seat.hole).toBeNull();
      }
    }
  });

  it("isMe 由服务端标 —— 客户端不自己判断身份", () => {
    const { state, src } = deal(33);
    for (const me of state.seats) {
      const v = viewFor(me.userId, src(state));
      expect(v.seats.filter((s) => s.isMe).map((s) => s.userId)).toEqual([me.userId]);
      // 标了 isMe 的那一座，正好也是唯一能看到底牌的那一座
      expect(v.seats.filter((s) => s.hole !== null).map((s) => s.userId)).toEqual([me.userId]);
    }
    // 外人一座都不标
    expect(viewFor("outsider", src(state)).seats.every((s) => !s.isMe)).toBe(true);
  });

  it("不在这桌上的人什么底牌都看不到", () => {
    const { state, src } = deal(21);
    const v = viewFor("outsider", src(state));
    for (const s of v.seats) expect(s.hole).toBeNull();
    expect(v.legal).toEqual([]);
  });
});

describe("视图其余字段", () => {
  it("只有轮到你时 legal 才非空", () => {
    const { state, src } = deal(17);
    const actor = state.seats[state.toAct]!.userId;
    expect(viewFor(actor, src(state)).legal.length).toBeGreaterThan(0);
    for (const s of state.seats) {
      if (s.userId !== actor) expect(viewFor(s.userId, src(state)).legal).toEqual([]);
    }
  });

  it("pot 是所有人本手投入之和，toAct 用 userId 而不是下标", () => {
    const { state, src } = deal(23);
    const v = viewFor("p0", src(state));
    expect(v.pot).toBe(state.seats.reduce((a, s) => a + s.committed, 0));
    expect(v.toAct).toBe(state.seats[state.toAct]!.userId);
  });

  it("deltas 只在牌局结束后才有", () => {
    const { state, src } = deal(29);
    expect(viewFor("p0", src(state)).deltas).toBeNull();
    const s = playToEnd(state, seeded(29));
    expect(viewFor("p0", src(s)).deltas).toEqual(s.deltas);
  });
});

describe("lastAction(行动气泡数据)", () => {
  it("开局只有盲注,大小盲的座位标 blind,其他座位 null", () => {
    const { state, src } = deal(21);
    const v = viewFor("p0", src(state));
    const blinds = v.seats.filter((s) => s.lastAction?.kind === "blind");
    expect(blinds).toHaveLength(2);
    expect(blinds.map((s) => s.lastAction!.amount).sort((a, b) => a - b)).toEqual([25, 50]);
    for (const s of v.seats) {
      if (s.lastAction) expect(s.lastAction.kind).toBe("blind");
    }
  });

  it("行动后覆盖该座位的气泡;call 报实付,raise 报加注到的目标", () => {
    const { state, src } = deal(22);
    const actor = state.seats[state.toAct]!;
    const opts = legalActions(state, actor.userId);
    const raise = opts.find((o) => o.type === "raise");
    if (!raise || raise.type !== "raise") throw new Error("测试局面该有加注选项");
    const s2 = applyAction(state, actor.userId, { type: "raise", to: raise.minTo });
    const v = viewFor("p0", src(s2));
    const seat = v.seats.find((s) => s.userId === actor.userId)!;
    expect(seat.lastAction).toEqual({ kind: "raise", amount: raise.minTo });
  });

  it("换街清空:发出翻牌后所有座位的气泡归 null(直到有人再动)", () => {
    const { state, src } = deal(23);
    // 翻前所有人跟到底/过牌,推进到翻牌
    let s = state;
    while (s.street === "preflop" && !s.done) {
      const seat = s.seats[s.toAct]!;
      const opts = legalActions(s, seat.userId);
      const call = opts.find((o) => o.type === "call") ?? opts.find((o) => o.type === "check");
      if (!call) throw new Error("没有跟注/过牌选项");
      s = applyAction(s, seat.userId, { type: call.type } as { type: "call" | "check" });
    }
    if (s.done) return; // 极端 all-in 跑完局面,不适用本断言
    const v = viewFor("p0", src(s));
    for (const seat of v.seats) expect(seat.lastAction).toBeNull();
  });
});
