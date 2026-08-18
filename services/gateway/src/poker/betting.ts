// 德州下注状态机。纯函数：(state, action) -> state，不碰时钟、随机数、DB。
//
// 为什么是纯的：钱的对错全在这一层，而这一层能被穷举测试。牌堆从外面注入，
// 结算只产出 deltas，落库和扣额度是上一层的事。任何一手牌都能靠
// 「初始 state + action 序列」逐帧重放出来 —— 与仓库的 append-only 事件日志同一条法理。
//
// !! state 里含所有人的底牌和整副牌堆，**不可以整个发给客户端**。
//    发给玩家的视图要按人裁剪，那是传输层的职责。

import { evaluate } from "./evaluator.js";

export type Street = "preflop" | "flop" | "turn" | "river";
export const STREETS = ["preflop", "flop", "turn", "river"] as const;

export interface TableConfig {
  /** 'flash' | 'pro' —— 引擎不解释它，只是原样带着，好让结算知道扣哪个桶 */
  readonly tier: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
}

export interface SeatInit {
  readonly userId: string;
  /** 带上桌的筹码。桌注制：这一手最多输这么多，不碰桌下余额 */
  readonly stack: number;
}

export type Action =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call" }
  /** to = 本轮想达到的总投注额（不是增量）。全下就是 to = bet + stack */
  | { readonly type: "raise"; readonly to: number };

export type ActionOption =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call"; readonly amount: number }
  | { readonly type: "raise"; readonly minTo: number; readonly maxTo: number };

export interface Seat {
  readonly userId: string;
  readonly startStack: number;
  readonly stack: number;
  /** 本轮已投 */
  readonly bet: number;
  /** 本手已投，算边池用 */
  readonly committed: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  /** 自上一次「足额加注」以来是否已行动过 */
  readonly acted: boolean;
  readonly hole: readonly number[];
}

export interface Pot {
  readonly amount: number;
  /** 有资格赢这一层的 seat 下标（摊牌时未弃牌且投够了这一层） */
  readonly eligible: readonly number[];
  /** 出资人 seat 下标。这一层若无人有资格，钱按出资原样退回 */
  readonly contributors: readonly number[];
}

export type LogEntry =
  | { readonly t: "blind"; readonly seat: number; readonly amount: number }
  | { readonly t: "deal"; readonly street: Street; readonly cards: readonly number[] }
  | { readonly t: "action"; readonly seat: number; readonly action: Action; readonly paid: number }
  | { readonly t: "showdown"; readonly seat: number; readonly score: number; readonly best: readonly number[] }
  | { readonly t: "award"; readonly pot: number; readonly seat: number; readonly amount: number }
  | { readonly t: "refund"; readonly pot: number; readonly seat: number; readonly amount: number };

export interface HandState {
  readonly config: TableConfig;
  readonly button: number;
  readonly seats: readonly Seat[];
  readonly board: readonly number[];
  readonly deck: readonly number[];
  /** 已从牌堆取走的张数 */
  readonly dealt: number;
  readonly street: Street;
  /** 轮到谁；-1 = 没人能行动（牌已结束或全员 all-in） */
  readonly toAct: number;
  readonly currentBet: number;
  /** 最小加注增量 */
  readonly lastRaise: number;
  readonly log: readonly LogEntry[];
  readonly done: boolean;
  readonly pots: readonly Pot[];
  /** 结算后每人的净变动，和恒为 0 */
  readonly deltas: Readonly<Record<string, number>>;
}

interface MutSeat {
  userId: string;
  startStack: number;
  stack: number;
  bet: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  hole: number[];
}

const cloneSeats = (seats: readonly Seat[]): MutSeat[] =>
  seats.map((s) => ({ ...s, hole: s.hole.slice() }));

function pay(seat: MutSeat, amount: number): void {
  const actual = Math.min(amount, seat.stack);
  seat.stack -= actual;
  seat.bet += actual;
  seat.committed += actual;
  if (seat.stack === 0) seat.allIn = true;
}

const canAct = (s: MutSeat): boolean => !s.folded && !s.allIn;

/** 从 from 的下一位开始找还需要行动的人；一圈内没有就返回 -1（本轮结束） */
function nextToAct(seats: readonly MutSeat[], from: number, currentBet: number): number {
  const n = seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    const s = seats[i]!;
    if (canAct(s) && (!s.acted || s.bet < currentBet)) return i;
  }
  return -1;
}

/** 翻牌后每轮从庄位左手第一个还能动的人开始 —— 单挑也适用（庄是小盲，左手就是大盲） */
function firstToAct(seats: readonly MutSeat[], button: number): number {
  const n = seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (button + k) % n;
    if (canAct(seats[i]!)) return i;
  }
  return -1;
}

export function startHand(
  config: TableConfig,
  players: readonly SeatInit[],
  deck: readonly number[],
  button = 0
): HandState {
  const n = players.length;
  if (n < 2 || n > 9) throw new Error(`一桌 2..9 人，给了 ${n} 人`);
  if (players.some((p) => p.stack <= 0)) throw new Error("有人带 0 筹码上桌");
  if (deck.length < n * 2 + 5) throw new Error("牌不够发");
  if (config.smallBlind <= 0 || config.bigBlind < config.smallBlind) {
    throw new Error("盲注设置不合法");
  }

  const seats: MutSeat[] = players.map((p) => ({
    userId: p.userId,
    startStack: p.stack,
    stack: p.stack,
    bet: 0,
    committed: 0,
    folded: false,
    allIn: false,
    acted: false,
    hole: [],
  }));

  // 一人一张发两轮，从庄位左手开始 —— 和现实一致，也让承诺牌堆的验证方
  // 能按同一顺序自己复现（不烧牌：牌堆已被 hash 钉死，烧牌只多一处对不上的可能）
  let dealt = 0;
  const log: LogEntry[] = [];
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= n; k++) {
      seats[(button + k) % n]!.hole.push(deck[dealt++]!);
    }
  }

  // 单挑：庄位就是小盲，且翻牌前先说话。三人以上：小盲在庄位左手，UTG 在大盲左手
  const headsUp = n === 2;
  const sbIdx = headsUp ? button : (button + 1) % n;
  const bbIdx = headsUp ? (button + 1) % n : (button + 2) % n;
  pay(seats[sbIdx]!, config.smallBlind);
  log.push({ t: "blind", seat: sbIdx, amount: seats[sbIdx]!.bet });
  pay(seats[bbIdx]!, config.bigBlind);
  log.push({ t: "blind", seat: bbIdx, amount: seats[bbIdx]!.bet });

  // 盲注不算「已行动」：大盲翻牌前有加注权（option）
  const start = headsUp ? sbIdx : (button + 3) % n;
  const state: HandState = {
    config,
    button,
    seats,
    board: [],
    deck,
    dealt,
    street: "preflop",
    // 落在 start 的**前一位**：advance 一律从 toAct 的下一位开始扫，
    // 这样开局与行动后走同一条路径（首位若已 all-in 会被自动跳过）
    toAct: (start - 1 + n) % n,
    // 大盲筹码不够时仍以完整大盲为跟注线，短出来的那部分靠边池退回
    currentBet: config.bigBlind,
    lastRaise: config.bigBlind,
    log,
    done: false,
    pots: [],
    deltas: {},
  };
  return advance(state);
}

export function legalActions(state: HandState, userId: string): ActionOption[] {
  if (state.done || state.toAct < 0) return [];
  const seat = state.seats[state.toAct]!;
  if (seat.userId !== userId) return [];

  const toCall = Math.min(state.currentBet - seat.bet, seat.stack);
  const out: ActionOption[] = [{ type: "fold" }];
  if (state.currentBet - seat.bet <= 0) out.push({ type: "check" });
  else out.push({ type: "call", amount: toCall });

  // 已行动过 = 上一次足额加注之后已经表过态。此后只碰到不足额的 all-in 加注，
  // 按规则不重开叫牌权，只能跟或弃（`acted` 会被足额加注清掉，所以这一个判断就够）
  const maxTo = seat.bet + seat.stack;
  if (!seat.acted && maxTo > state.currentBet) {
    out.push({ type: "raise", minTo: Math.min(state.currentBet + state.lastRaise, maxTo), maxTo });
  }
  return out;
}

export function applyAction(state: HandState, userId: string, action: Action): HandState {
  if (state.done) throw new Error("这手牌已经结束");
  if (state.toAct < 0) throw new Error("现在不轮到任何人行动");
  const idx = state.toAct;
  const seats = cloneSeats(state.seats);
  const seat = seats[idx]!;
  if (seat.userId !== userId) throw new Error(`现在是 ${seat.userId} 的回合，不是 ${userId}`);

  const log = state.log.slice();
  let currentBet = state.currentBet;
  let lastRaise = state.lastRaise;
  let paid = 0;

  switch (action.type) {
    case "fold":
      seat.folded = true;
      break;
    case "check":
      if (currentBet - seat.bet > 0) throw new Error("面前有注，不能过牌");
      break;
    case "call": {
      const toCall = Math.min(currentBet - seat.bet, seat.stack);
      if (currentBet - seat.bet <= 0) throw new Error("没有要跟的注，该用 check");
      paid = toCall;
      pay(seat, paid);
      break;
    }
    case "raise": {
      if (seat.acted) throw new Error("不足额 all-in 不重开叫牌权，这一轮只能跟或弃");
      const maxTo = seat.bet + seat.stack;
      if (!Number.isInteger(action.to)) throw new Error("加注额必须是整数");
      if (action.to <= currentBet) throw new Error(`加注要高于 ${currentBet}`);
      if (action.to > maxTo) throw new Error(`筹码只够加到 ${maxTo}`);
      const full = action.to >= currentBet + lastRaise;
      if (!full && action.to !== maxTo) {
        throw new Error(`最小加注到 ${currentBet + lastRaise}，或全下到 ${maxTo}`);
      }
      paid = action.to - seat.bet;
      pay(seat, paid);
      if (full) {
        lastRaise = action.to - currentBet;
        // 足额加注重开一轮：其他人先前的表态作废，得重新面对新的注
        for (const s of seats) if (s !== seat) s.acted = false;
      }
      currentBet = action.to;
      break;
    }
  }

  seat.acted = true;
  log.push({ t: "action", seat: idx, action, paid });
  return advance({ ...state, seats, currentBet, lastRaise, log });
}

function advance(state: HandState): HandState {
  const seats = state.seats as readonly MutSeat[];
  if (seats.filter((s) => !s.folded).length === 1) return settle({ ...state, toAct: -1 });
  const next = nextToAct(seats, state.toAct < 0 ? seats.length - 1 : state.toAct, state.currentBet);
  if (next >= 0) return { ...state, toAct: next };
  return advanceStreet(state);
}

function advanceStreet(state: HandState): HandState {
  const seats = cloneSeats(state.seats);
  for (const s of seats) {
    s.bet = 0;
    s.acted = false;
  }
  const board = state.board.slice();
  const log = state.log.slice();
  let street = state.street;
  let dealt = state.dealt;

  // 还能下注的人不足两个就一路发到河牌 —— 全下之后没有可下的注，只剩发牌
  for (;;) {
    if (street === "river") {
      return settle({ ...state, seats, board, dealt, street, toAct: -1, log });
    }
    const next = STREETS[STREETS.indexOf(street) + 1]!;
    const count = next === "flop" ? 3 : 1;
    const cards = state.deck.slice(dealt, dealt + count);
    dealt += count;
    board.push(...cards);
    log.push({ t: "deal", street: next, cards });
    street = next;

    if (seats.filter(canAct).length >= 2) {
      return {
        ...state,
        seats,
        board,
        dealt,
        street,
        currentBet: 0,
        lastRaise: state.config.bigBlind,
        toAct: firstToAct(seats, state.button),
        log,
      };
    }
  }
}

/** 按投入额分层建池：每一层只有投够那一层的人有资格 */
function buildPots(seats: readonly MutSeat[]): Pot[] {
  const levels = [...new Set(seats.filter((s) => s.committed > 0).map((s) => s.committed))].sort(
    (a, b) => a - b
  );
  const pots: Pot[] = [];
  let prev = 0;
  for (const lv of levels) {
    let amount = 0;
    const eligible: number[] = [];
    const contributors: number[] = [];
    seats.forEach((s, i) => {
      const put = Math.max(0, Math.min(s.committed, lv) - prev);
      amount += put;
      if (put > 0) contributors.push(i);
      if (s.committed >= lv && !s.folded) eligible.push(i);
    });
    if (amount > 0) pots.push({ amount, eligible, contributors });
    prev = lv;
  }
  return pots;
}

function settle(state: HandState): HandState {
  const seats = cloneSeats(state.seats);
  const log = state.log.slice();
  const pots = buildPots(seats);
  const n = seats.length;

  // 只剩一个人没弃牌就不摊牌 —— 此时公共牌可能还没发全，根本无从评估
  const live = seats.map((s, i) => i).filter((i) => !seats[i]!.folded);
  const scores = new Map<number, number>();
  if (live.length > 1) {
    for (const i of live) {
      const ev = evaluate([...seats[i]!.hole, ...state.board]);
      scores.set(i, ev.score);
      log.push({ t: "showdown", seat: i, score: ev.score, best: ev.best });
    }
  }

  // 平分余数给庄位左手起最近的赢家 —— token 是整数，除不尽必然发生，
  // 规则得钉死，不能看谁在数组里排前面
  const seatOrder = (i: number) => (i - state.button - 1 + n * 2) % n;

  pots.forEach((pot, pi) => {
    // 只剩一个人没弃牌 = 全部底池都归他，**不看边池资格**。
    // 资格只在摊牌时才有意义：别人弃了就是把钱送出去了，哪怕那部分钱
    // 是他们俩在一个短筹码够不着的边池里对打出来的。
    // （这条也顺带覆盖了「没被跟的注退回加注者」—— 他自己那份本来就在池子里）
    let winners = live.length === 1 ? live : pot.eligible.filter((i) => !seats[i]!.folded);

    // 这一层的出资人全弃了牌（而桌上还有活人）：这笔钱从来没被人跟过，
    // 原样退回出资人。层的定义保证同层每人出得一样多，所以除得尽、不产生零头
    if (winners.length === 0) {
      const back = pot.amount / pot.contributors.length;
      if (!Number.isInteger(back)) throw new Error(`边池 ${pi} 退款除不尽`);
      for (const c of pot.contributors) {
        seats[c]!.stack += back;
        log.push({ t: "refund", pot: pi, seat: c, amount: back });
      }
      return;
    }

    if (scores.size > 0) {
      const contenders = winners;
      const best = Math.max(...contenders.map((i) => scores.get(i) ?? -1));
      winners = contenders.filter((i) => scores.get(i) === best);
    }
    winners = winners.slice().sort((a, b) => seatOrder(a) - seatOrder(b));
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const w of winners) {
      const amount = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      seats[w]!.stack += amount;
      log.push({ t: "award", pot: pi, seat: w, amount });
    }
  });

  const deltas: Record<string, number> = {};
  for (const s of seats) deltas[s.userId] = (deltas[s.userId] ?? 0) + (s.stack - s.startStack);

  return { ...state, seats, log, pots, deltas, done: true, toAct: -1 };
}
