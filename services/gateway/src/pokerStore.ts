// 牌桌的持久层 —— 走 Supabase 的四个 security definer 函数（migration 0004）。
//
// 桶余额和桌上筹码是两个不相交的容器（ADR-0023）：同一个 token 要么能买推理，
// 要么已经推到桌面上，不会同时算两遍。容器之间只有买入/离桌两个入口，
// 两边在同一个事务里一起改。
//
// 手牌之间的输赢不进 token_ledger —— 那些 token 从没离开牌桌。它们的
// append-only 记录是 poker_hands，投影是 poker_stacks。

import type { HandState } from "./poker/betting.js";
import type { DeckCommitment } from "./poker/shuffle.js";
import { asBoolean, asNumber, createRpc, type RpcOptions } from "./supabaseRpc.js";

export interface BuyinParams {
  userId: string;
  tableId: string;
  /** poker_join 不需要它（档位由桌子定），poker_buyin 需要 */
  tier?: string;
  amount: number;
  /** 幂等键。重投同一次买入不会扣两遍 */
  requestId: string;
}

export interface HandRecord {
  handId: string;
  tableId: string;
  tier: string;
  button: number;
  deckHash: string;
  deck: readonly number[];
  deckSalt: string;
  /** 每个座位的起始筹码与底牌 —— 牌已经摊完了才落库 */
  seats: readonly { userId: string; startStack: number; hole: readonly number[] }[];
  board: readonly number[];
  log: unknown;
  pots: unknown;
  deltas: Readonly<Record<string, number>>;
}

export interface PokerStore {
  /** 好友门 + 分座位 + 买入，一个事务（migration 0005）。返回座位号 */
  join(p: BuyinParams): Promise<number>;
  /** 带走全部筹码 + 空出座位。返回带走了多少 */
  leave(p: { userId: string; tableId: string; requestId: string }): Promise<number>;
  /** 桶 → 桌。返回买入后的桌上筹码 */
  buyin(p: BuyinParams): Promise<number>;
  /** 桌 → 桶，把整个栈带走。返回带走了多少 */
  cashout(p: { userId: string; tableId: string; requestId: string }): Promise<number>;
  /** 记一手牌并按 deltas 改各家的栈。false = 重放（这手早就结算过了） */
  settle(record: HandRecord): Promise<boolean>;
  /** 从手牌记录 + 转移记录重算某人在某张桌上的栈（对账用） */
  rebuildStack(userId: string, tableId: string): Promise<number>;
}

/**
 * 把打完的一手牌整理成落库记录。
 *
 * 这里再验一遍零和，而不是"引擎已经保证了"就算了：引擎、这一层、DB
 * 各自独立断言同一条不变量，任意一层写错都会被另外两层挡住。
 * 三道墙里最贵的一道（DB 那道）也最不该是唯一一道 —— 它挡下来的时候
 * 事务已经开了、网络已经走了一趟。
 */
export function toHandRecord(
  handId: string,
  tableId: string,
  state: HandState,
  commitment: DeckCommitment
): HandRecord {
  if (!state.done) throw new Error("这手牌还没打完，不能落库");
  const sum = Object.values(state.deltas).reduce((a, b) => a + b, 0);
  if (sum !== 0) throw new Error(`这手牌的净变动和是 ${sum}，不是 0`);
  return {
    handId,
    tableId,
    tier: state.config.tier,
    button: state.button,
    deckHash: commitment.hash,
    deck: commitment.deck,
    deckSalt: commitment.salt,
    seats: state.seats.map((s) => ({
      userId: s.userId,
      startStack: s.startStack,
      hole: s.hole,
    })),
    board: state.board,
    log: state.log,
    pots: state.pots,
    deltas: state.deltas,
  };
}

export function createSupabasePokerStore(opts: RpcOptions): PokerStore {
  const call = createRpc(opts);

  return {
    async join(p) {
      if (!p.requestId) throw new Error("入座必须带幂等键");
      if (!Number.isInteger(p.amount) || p.amount <= 0) {
        throw new Error(`买入额必须是正整数，给了 ${p.amount}`);
      }
      return asNumber(
        await call("poker_join", {
          p_user: p.userId,
          p_table: p.tableId,
          p_amount: p.amount,
          p_request_id: p.requestId,
        }),
        "poker_join"
      );
    },

    async leave(p) {
      if (!p.requestId) throw new Error("离桌必须带幂等键");
      return asNumber(
        await call("poker_leave", {
          p_user: p.userId,
          p_table: p.tableId,
          p_request_id: p.requestId,
        }),
        "poker_leave"
      );
    },

    async buyin(p) {
      if (!p.requestId) throw new Error("买入必须带幂等键");
      if (!Number.isInteger(p.amount) || p.amount <= 0) {
        throw new Error(`买入额必须是正整数，给了 ${p.amount}`);
      }
      return asNumber(
        await call("poker_buyin", {
          p_user: p.userId,
          p_table: p.tableId,
          p_tier: p.tier ?? "",
          p_amount: p.amount,
          p_request_id: p.requestId,
        }),
        "poker_buyin"
      );
    },

    async cashout(p) {
      if (!p.requestId) throw new Error("离桌必须带幂等键");
      return asNumber(
        await call("poker_cashout", {
          p_user: p.userId,
          p_table: p.tableId,
          p_request_id: p.requestId,
        }),
        "poker_cashout"
      );
    },

    async settle(r) {
      return asBoolean(
        await call("poker_settle", {
          p_hand_id: r.handId,
          p_table: r.tableId,
          p_tier: r.tier,
          p_button: r.button,
          p_deck_hash: r.deckHash,
          p_deck: r.deck,
          p_deck_salt: r.deckSalt,
          p_seats: r.seats,
          p_board: r.board,
          p_log: r.log,
          p_pots: r.pots,
          p_deltas: r.deltas,
        }),
        "poker_settle"
      );
    },

    async rebuildStack(userId, tableId) {
      return asNumber(
        await call("rebuild_stack", { p_user: userId, p_table: tableId }),
        "rebuild_stack"
      );
    },
  };
}
