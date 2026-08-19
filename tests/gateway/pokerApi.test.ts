import { describe, expect, it, vi } from "vitest";
import { createPokerApi, parseAction, toSeatRow, toTableInfo } from "../../services/gateway/src/pokerApi.js";
import type { PokerStore } from "../../services/gateway/src/pokerStore.js";
import type { Rest } from "../../services/gateway/src/supabaseRpc.js";
import { commitDeck } from "../../services/gateway/src/poker/shuffle.js";
import { Tables } from "../../services/gateway/src/tables.js";

function seeded(seed: number): (max: number) => number {
  let x = seed >>> 0 || 1;
  return (max) => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x % max;
  };
}

const TABLE_ROW = {
  id: "t1", name: "家里桌", tier: "flash", small_blind: 25, big_blind: 50,
  min_buyin: 500, max_buyin: 5000, max_seats: 6, created_by: "a", closed_at: null,
};

function harness() {
  const calls: { join: unknown[]; leave: unknown[] } = { join: [], leave: [] };
  const store: PokerStore = {
    join: async (p) => { calls.join.push(p); return 0; },
    leave: async (p) => { calls.leave.push(p); return 1234; },
    buyin: async () => 0,
    cashout: async () => 0,
    settle: async () => true,
    rebuildStack: async () => 0,
  };
  const rest: Rest = {
    select: async (path) => {
      if (path.startsWith("poker_tables")) return [TABLE_ROW];
      // 只有 a、b 坐在 t1 上 —— 桩要跟真库一样按 user 过滤，
      // 否则"外人看不见"这条测的是桩而不是代码
      if (path.startsWith("poker_stacks?user_id")) {
        const who = /user_id=eq\.([^&]+)/.exec(path)?.[1];
        return who === "a" || who === "b" ? [{ table_id: "t1" }] : [];
      }
      if (path.startsWith("poker_stacks")) {
        return [
          { table_id: "t1", user_id: "a", seat_index: 0, stack_tokens: 1000 },
          { table_id: "t1", user_id: "b", seat_index: 1, stack_tokens: 1000 },
        ];
      }
      if (path.startsWith("friendships")) {
        const who = /(?:requester|addressee)\.eq\.([^,)]+)/.exec(path)?.[1];
        return who === "a" ? [{ requester: "a", addressee: "z" }] : [];
      }
      return [];
    },
    insert: async (_t, row) => ({ ...TABLE_ROW, ...row, id: "t2" }),
  };
  const tables = new Tables({
    store,
    loadTable: async () => toTableInfo(TABLE_ROW),
    loadSeats: async () => [
      { userId: "a", seatIndex: 0, stack: 1000 },
      { userId: "b", seatIndex: 1, stack: 1000 },
    ],
    commit: () => commitDeck(seeded(4)),
    newId: () => "hand-1",
  });
  const api = createPokerApi({ tables, store, rest, newId: () => "nonce" });
  return { api, tables, store, calls };
}

const post = (body?: unknown) =>
  new Request("http://x/", { method: "POST", body: JSON.stringify(body ?? {}) });
const get = () => new Request("http://x/");

describe("行数据转换", () => {
  it("snake_case 列名转成进程内的 camelCase", () => {
    expect(toTableInfo(TABLE_ROW)).toEqual({
      id: "t1", tier: "flash", smallBlind: 25, bigBlind: 50,
      minBuyin: 500, maxBuyin: 5000, maxSeats: 6,
    });
    expect(toSeatRow({ user_id: "a", seat_index: 2, stack_tokens: 900 }))
      .toEqual({ userId: "a", seatIndex: 2, stack: 900 });
  });
});

describe("动作解析", () => {
  it("只认引擎那四种", () => {
    expect(parseAction({ type: "fold" })).toEqual({ type: "fold" });
    expect(parseAction({ type: "raise", to: 300 })).toEqual({ type: "raise", to: 300 });
    for (const bad of [null, "fold", {}, { type: "muck" }, { type: "raise" },
                       { type: "raise", to: "300" }, { type: "raise", to: 1.5 }]) {
      expect(parseAction(bad)).toBeNull();
    }
  });
});

describe("路由", () => {
  it("列桌只列看得见的：自己建的 / 自己坐着的 / 好友建的", async () => {
    const { api } = harness();
    const res = await api.handle("a", get(), "");
    const body = await res.json() as { tables: { id: string; players: number; online: number }[] };
    expect(body.tables.map((t) => t.id)).toEqual(["t1"]);
    // 等桌页靠它画人数:players = 有筹码的座位,online = 正开着牌桌页的人
    expect(body.tables[0]!.players).toBe(2);
    expect(body.tables[0]!.online).toBe(0);

    // b 打开牌桌页(订上 SSE)后,在场人数变 1 —— 筹码在座不等于人在场
    const sse = await api.handle("b", get(), "t1/stream");
    const body2 = await (await api.handle("a", get(), "")).json() as { tables: { online: number }[] };
    expect(body2.tables[0]!.online).toBe(1);
    await sse.body!.cancel();

    // 与建桌人 a 无关的 outsider 看不到
    const res2 = await api.handle("outsider", get(), "");
    expect(((await res2.json()) as { tables: unknown[] }).tables).toEqual([]);
  });

  it("建桌把档位钉死，非法档位落回 flash", async () => {
    const { api } = harness();
    const res = await api.handle("a", post({ tier: "gold", bigBlind: 100 }), "");
    const body = await res.json() as { table: { tier: string; bigBlind: number } };
    expect(body.table.tier).toBe("flash");
    expect(body.table.bigBlind).toBe(100);
  });

  it("入座带幂等键，买入额要是正整数", async () => {
    const { api, calls } = harness();
    expect((await api.handle("a", post({ amount: 1000 }), "t1/join")).status).toBe(200);
    expect(calls.join[0]).toMatchObject({ userId: "a", tableId: "t1", amount: 1000 });
    expect(String((calls.join[0] as { requestId: string }).requestId)).toContain("nonce");

    for (const amount of [0, -1, 1.5, "1000"]) {
      const res = await api.handle("a", post({ amount }), "t1/join");
      expect(res.status).toBe(400);
    }
  });

  it("牌局进行中不许入座、也不许带钱走人", async () => {
    const { api, tables, calls } = harness();
    await tables.startHand("t1");
    expect((await api.handle("a", post({ amount: 1000 }), "t1/join")).status).toBe(409);
    expect((await api.handle("a", post(), "t1/leave")).status).toBe(409);
    expect(calls.join).toHaveLength(0);
    expect(calls.leave).toHaveLength(0);
  });

  it("离桌返回带走多少", async () => {
    const { api } = harness();
    const res = await api.handle("a", post(), "t1/leave");
    expect(await res.json()).toEqual({ taken: 1234 });
  });

  it("拿牌局状态是按人裁剪的", async () => {
    const { api, tables } = harness();
    await tables.startHand("t1");
    const res = await api.handle("a", get(), "t1");
    const body = await res.json() as { hand: { seats: { userId: string; hole: number[] | null }[] } };
    expect(body.hand.seats.find((s) => s.userId === "a")!.hole).toHaveLength(2);
    expect(body.hand.seats.find((s) => s.userId === "b")!.hole).toBeNull();
  });

  it("动作走引擎，非法的一律 400", async () => {
    const { api, tables } = harness();
    const state = await tables.startHand("t1");
    const actor = state.seats[state.toAct]!.userId;
    expect((await api.handle(actor, post({ action: { type: "muck" } }), "t1/action")).status).toBe(400);
    // 不是他的回合
    const other = state.seats.find((s) => s.userId !== actor)!.userId;
    const res = await api.handle(other, post({ action: { type: "fold" } }), "t1/action");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/回合/);
    expect((await api.handle(actor, post({ action: { type: "fold" } }), "t1/action")).status).toBe(200);
  });

  it("没有这个端点就 404，方法不对就 405", async () => {
    const { api } = harness();
    expect((await api.handle("a", post(), "t1/muck")).status).toBe(404);
    expect((await api.handle("a", get(), "t1/join")).status).toBe(405);
  });
});

describe("SSE", () => {
  it("连上先推一份自己的视图，之后每次变化各推各的", async () => {
    const { api, tables } = harness();
    await tables.startHand("t1");
    const res = await api.handle("b", new Request("http://x/"), "t1/stream");
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first.startsWith("data: ")).toBe(true);
    const view = JSON.parse(first.slice(6)) as { seats: { userId: string; hole: number[] | null }[] };
    // b 收到的是 b 那份：自己有牌，a 没有
    expect(view.seats.find((s) => s.userId === "b")!.hole).toHaveLength(2);
    expect(view.seats.find((s) => s.userId === "a")!.hole).toBeNull();
    await reader.cancel();
  });

  it("闲置时每 25s 发一行心跳注释,反代不会把静默流当死链掐掉", async () => {
    vi.useFakeTimers();
    try {
      const { api, tables } = harness();
      await tables.startHand("t1");
      const res = await api.handle("b", new Request("http://x/"), "t1/stream");
      const reader = res.body!.getReader();
      await reader.read(); // 初始视图
      vi.advanceTimersByTime(25_000);
      const hb = new TextDecoder().decode((await reader.read()).value);
      expect(hb).toContain(": hb");
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
