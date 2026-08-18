import { describe, expect, it, vi } from "vitest";
import { legalActions } from "../../services/gateway/src/poker/betting.js";
import { commitDeck } from "../../services/gateway/src/poker/shuffle.js";
import type { HandRecord, PokerStore } from "../../services/gateway/src/pokerStore.js";
import { Tables, type SeatRow, type TableInfo } from "../../services/gateway/src/tables.js";

function seeded(seed: number): (max: number) => number {
  let x = seed >>> 0 || 1;
  return (max) => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x % max;
  };
}

const TABLE: TableInfo = {
  id: "t1", tier: "flash", smallBlind: 25, bigBlind: 50,
  minBuyin: 500, maxBuyin: 5000, maxSeats: 6,
};

function harness(seats: SeatRow[], seed = 1) {
  const settled: HandRecord[] = [];
  const store: PokerStore = {
    join: async () => 0,
    leave: async () => 0,
    buyin: async () => 0,
    cashout: async () => 0,
    settle: async (r) => { settled.push(r); return true; },
    rebuildStack: async () => 0,
  };
  const changes: string[] = [];
  let n = 0;
  const tables = new Tables({
    store,
    loadTable: async () => TABLE,
    loadSeats: async () => seats,
    newId: () => `hand-${++n}`,
    commit: () => commitDeck(seeded(seed)),
    onChange: (id) => changes.push(id),
  });
  return { tables, settled, changes, store };
}

const three: SeatRow[] = [
  { userId: "a", seatIndex: 0, stack: 1000 },
  { userId: "b", seatIndex: 1, stack: 1000 },
  { userId: "c", seatIndex: 2, stack: 1000 },
];

describe("开牌", () => {
  it("按座位号排座，庄位每手往后挪一位", async () => {
    const { tables, settled } = harness(three);
    const s1 = await tables.startHand("t1");
    expect(s1.seats.map((x) => x.userId)).toEqual(["a", "b", "c"]);
    expect(s1.button).toBe(0);
    // 打完再来一手
    let s = s1;
    while (!s.done) s = await tables.act("t1", s.seats[s.toAct]!.userId, { type: "fold" });
    expect(settled).toHaveLength(1);
    const s2 = await tables.startHand("t1");
    expect(s2.button).toBe(1);
  });

  it("同一张桌不能同时跑两手", async () => {
    const { tables } = harness(three);
    await tables.startHand("t1");
    await expect(tables.startHand("t1")).rejects.toThrow(/没打完/);
  });

  it("没筹码的人不入局，不够两人不开牌", async () => {
    const { tables } = harness([
      { userId: "a", seatIndex: 0, stack: 1000 },
      { userId: "b", seatIndex: 1, stack: 0 },
    ]);
    await expect(tables.startHand("t1")).rejects.toThrow(/至少要两个/);
  });

  it("桌不存在就抛，不静默开一张空桌", async () => {
    const { store } = harness(three);
    const tables = new Tables({ store, loadTable: async () => null, loadSeats: async () => three });
    await expect(tables.startHand("nope")).rejects.toThrow(/没有这张桌/);
  });
});

describe("行动与结算", () => {
  it("不是你的回合就拒绝 —— 服务端说了算", async () => {
    const { tables } = harness(three);
    const s = await tables.startHand("t1");
    const notActor = s.seats.find((x) => x.userId !== s.seats[s.toAct]!.userId)!.userId;
    await expect(tables.act("t1", notActor, { type: "fold" })).rejects.toThrow(/回合/);
  });

  it("非法动作被引擎挡下", async () => {
    const { tables } = harness(three);
    const s = await tables.startHand("t1");
    // 翻牌前面前有大盲，过牌不合法
    await expect(tables.act("t1", s.seats[s.toAct]!.userId, { type: "check" }))
      .rejects.toThrow(/不能过牌/);
  });

  it("打完自动结算一次，且只结算一次", async () => {
    const { tables, settled } = harness(three);
    let s = await tables.startHand("t1");
    while (!s.done) s = await tables.act("t1", s.seats[s.toAct]!.userId, { type: "fold" });
    expect(settled).toHaveLength(1);
    expect(settled[0]!.handId).toBe("hand-1");
    expect(Object.values(settled[0]!.deltas).reduce((a, b) => a + b, 0)).toBe(0);
    // 牌局结束后再动一下应当被拒，不会触发第二次结算
    await expect(tables.act("t1", "a", { type: "fold" })).rejects.toThrow(/没有进行中/);
    expect(settled).toHaveLength(1);
  });

  it("结算记录带着牌堆承诺，事后可验", async () => {
    const { tables, settled } = harness(three);
    let s = await tables.startHand("t1");
    while (!s.done) s = await tables.act("t1", s.seats[s.toAct]!.userId, { type: "fold" });
    const r = settled[0]!;
    expect(r.deck).toHaveLength(52);
    expect(r.deckHash).toHaveLength(64);
    expect(r.deckSalt.length).toBeGreaterThan(0);
    expect(r.seats.every((x) => x.hole.length === 2)).toBe(true);
  });

  it("随机对局：每手都结算一次，deltas 恒零和", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = seeded(seed * 17);
      const { tables, settled } = harness(three, seed);
      let s = await tables.startHand("t1");
      while (!s.done) {
        const seat = s.seats[s.toAct]!;
        const opts = legalActions(s, seat.userId);
        const pick = opts[rng(opts.length)]!;
        s = await tables.act("t1", seat.userId, pick.type === "raise"
          ? { type: "raise", to: pick.minTo + rng(pick.maxTo - pick.minTo + 1) }
          : { type: pick.type });
      }
      expect(settled).toHaveLength(1);
      expect(Object.values(settled[0]!.deltas).reduce((a, b) => a + b, 0)).toBe(0);
    }
  });
});

describe("视图", () => {
  it("每个人只拿到自己那一份", async () => {
    const { tables } = harness(three);
    await tables.startHand("t1");
    const va = tables.view("t1", "a")!;
    expect(va.seats.find((s) => s.userId === "a")!.hole).toHaveLength(2);
    expect(va.seats.find((s) => s.userId === "b")!.hole).toBeNull();
    expect(va.commitment.deck).toBeNull();
  });

  it("没开牌时返回 null", () => {
    const { tables } = harness(three);
    expect(tables.view("t1", "a")).toBeNull();
  });
});

describe("变更通知", () => {
  it("开牌、每次行动、结算都会叫一声", async () => {
    const { tables, changes } = harness(three);
    const before = changes.length;
    let s = await tables.startHand("t1");
    expect(changes.length).toBeGreaterThan(before);
    const mid = changes.length;
    s = await tables.act("t1", s.seats[s.toAct]!.userId, { type: "fold" });
    expect(changes.length).toBeGreaterThan(mid);
    expect(changes.every((c) => c === "t1")).toBe(true);
  });

  it("落库抛错不会被重试成两次结算", async () => {
    const settle = vi.fn(async () => { throw new Error("DB 挂了"); });
    const tables = new Tables({
      store: {
        join: async () => 0, leave: async () => 0, buyin: async () => 0,
        cashout: async () => 0, settle, rebuildStack: async () => 0,
      },
      loadTable: async () => TABLE,
      loadSeats: async () => three,
    });
    let s = await tables.startHand("t1");
    let err: unknown;
    try {
      while (!s.done) s = await tables.act("t1", s.seats[s.toAct]!.userId, { type: "fold" });
    } catch (e) { err = e; }
    expect(String(err)).toMatch(/DB 挂了/);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
