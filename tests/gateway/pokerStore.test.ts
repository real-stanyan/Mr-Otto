import { describe, expect, it } from "vitest";
import { applyAction, legalActions, startHand, type HandState } from "../../services/gateway/src/poker/betting.js";
import { commitDeck } from "../../services/gateway/src/poker/shuffle.js";
import {
  createSupabasePokerStore, toHandRecord, type PokerStore,
} from "../../services/gateway/src/pokerStore.js";

interface Call { url: string; init: RequestInit }

function stub(reply: unknown, status = 200): { store: PokerStore; calls: Call[] } {
  const calls: Call[] = [];
  const store = createSupabasePokerStore({
    url: "https://db.example.com/",
    serviceRoleKey: "service-role-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply), { status });
    },
  });
  return { store, calls };
}

const bodyOf = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

describe("买入", () => {
  it("打到 poker_buyin，带 service_role 头", async () => {
    const { store, calls } = stub(1000);
    expect(await store.buyin({
      userId: "u1", tableId: "t1", tier: "flash", amount: 1000, requestId: "r1",
    })).toBe(1000);
    expect(calls[0]!.url).toBe("https://db.example.com/rest/v1/rpc/poker_buyin");
    expect(bodyOf(calls[0]!)).toEqual({
      p_user: "u1", p_table: "t1", p_tier: "flash", p_amount: 1000, p_request_id: "r1",
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer service-role-secret");
    expect(headers["apikey"]).toBe("service-role-secret");
  });

  it("没有幂等键就不发请求 —— 重投会扣两遍", async () => {
    const { store, calls } = stub(0);
    await expect(store.buyin({
      userId: "u1", tableId: "t1", tier: "flash", amount: 10, requestId: "",
    })).rejects.toThrow(/幂等键/);
    expect(calls).toHaveLength(0);
  });

  it("买入额必须是正整数", async () => {
    const { store, calls } = stub(0);
    for (const amount of [0, -5, 1.5, Number.NaN]) {
      await expect(store.buyin({
        userId: "u1", tableId: "t1", tier: "flash", amount, requestId: "r",
      })).rejects.toThrow(/正整数/);
    }
    expect(calls).toHaveLength(0);
  });

  it("bigint 以字符串回来也认", async () => {
    const { store } = stub("9007199254740");
    expect(await store.buyin({
      userId: "u1", tableId: "t1", tier: "flash", amount: 1, requestId: "r",
    })).toBe(9007199254740);
  });

  it("DB 报错原样抬上来，不吞", async () => {
    const { store } = stub({ message: "flash 桶余额 5 不够买入 1000" }, 400);
    await expect(store.buyin({
      userId: "u1", tableId: "t1", tier: "flash", amount: 1000, requestId: "r",
    })).rejects.toThrow(/不够买入/);
  });
});

describe("离桌", () => {
  it("打到 poker_cashout", async () => {
    const { store, calls } = stub(1400);
    expect(await store.cashout({ userId: "u1", tableId: "t1", requestId: "r2" })).toBe(1400);
    expect(bodyOf(calls[0]!)).toEqual({ p_user: "u1", p_table: "t1", p_request_id: "r2" });
  });

  it("没有幂等键就不发请求", async () => {
    const { store, calls } = stub(0);
    await expect(store.cashout({ userId: "u1", tableId: "t1", requestId: "" }))
      .rejects.toThrow(/幂等键/);
    expect(calls).toHaveLength(0);
  });
});

describe("结算", () => {
  const record = {
    handId: "h1", tableId: "t1", tier: "flash", button: 0,
    deckHash: "abc", deck: [1, 2, 3], deckSalt: "s",
    seats: [{ userId: "u1", startStack: 1000, hole: [0, 1] }],
    board: [2, 3, 4], log: [], pots: [], deltas: { u1: 400, u2: -400 },
  };

  it("字段全量映射到 poker_settle", async () => {
    const { store, calls } = stub(true);
    expect(await store.settle(record)).toBe(true);
    expect(bodyOf(calls[0]!)).toEqual({
      p_hand_id: "h1", p_table: "t1", p_tier: "flash", p_button: 0,
      p_deck_hash: "abc", p_deck: [1, 2, 3], p_deck_salt: "s",
      p_seats: [{ userId: "u1", startStack: 1000, hole: [0, 1] }],
      p_board: [2, 3, 4], p_log: [], p_pots: [], p_deltas: { u1: 400, u2: -400 },
    });
  });

  it("重放回 false", async () => {
    const { store } = stub(false);
    expect(await store.settle(record)).toBe(false);
  });

  it("回了非布尔就抛 —— 结算成没成不能靠猜", async () => {
    const { store } = stub("true");
    await expect(store.settle(record)).rejects.toThrow(/非布尔/);
  });
});

describe("toHandRecord", () => {
  function playOut(seed: number): HandState {
    let x = seed >>> 0 || 1;
    const rng = (max: number) => {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      return x % max;
    };
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = 51; i > 0; i--) {
      const j = rng(i + 1);
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    let s = startHand(
      { tier: "flash", smallBlind: 25, bigBlind: 50 },
      [{ userId: "u1", stack: 1000 }, { userId: "u2", stack: 1000 }, { userId: "u3", stack: 400 }],
      deck
    );
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

  it("打完的牌整理成记录，deltas 和为 0", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const s = playOut(seed * 13);
      const r = toHandRecord("h", "t", s, commitDeck());
      expect(Object.values(r.deltas).reduce((a, b) => a + b, 0)).toBe(0);
      expect(r.tier).toBe("flash");
      expect(r.seats.map((x) => x.userId)).toEqual(["u1", "u2", "u3"]);
      expect(r.seats.every((x) => x.hole.length === 2)).toBe(true);
    }
  });

  it("没打完不给落库", () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const s = startHand({ tier: "flash", smallBlind: 25, bigBlind: 50 },
      [{ userId: "u1", stack: 1000 }, { userId: "u2", stack: 1000 }], deck);
    expect(() => toHandRecord("h", "t", s, commitDeck())).toThrow(/还没打完/);
  });

  it("零和被破坏就当场拦下 —— 不让它走到 DB 那一层才被发现", () => {
    const s = playOut(7);
    const tampered = { ...s, deltas: { ...s.deltas, u1: (s.deltas["u1"] ?? 0) + 1 } };
    expect(() => toHandRecord("h", "t", tampered, commitDeck())).toThrow(/不是 0/);
  });

  it("带上牌堆承诺，落库后还能自证没换牌", () => {
    const s = playOut(3);
    const c = commitDeck();
    const r = toHandRecord("h", "t", s, c);
    expect(r.deckHash).toBe(c.hash);
    expect(r.deck).toEqual(c.deck);
    expect(r.deckSalt).toBe(c.salt);
  });
});
