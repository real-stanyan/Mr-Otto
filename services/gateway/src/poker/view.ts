// 按人裁剪牌局视图。**这一层写错等于所有人开着底牌打。**
//
// HandState 里有全部底牌和整副牌堆（引擎要它们）。发给客户端的每一份数据
// 都必须先过这个函数，而这个函数是纯的、可穷举测的 —— 保密性不能靠
// "记得在那边别带上 deck"，得靠一个能被测试钉死的出口。
//
// 揭示规则只有两条：
//   1. 自己的底牌永远看得见
//   2. 别人的底牌只在**摊牌**之后看得见，且只限真的摊了牌的人
//      （弃牌的人从头到尾不亮牌，牌堆同理，摊牌后才随承诺一起揭示）

import type { ActionOption, HandState, Pot, Street } from "./betting.js";
import { legalActions } from "./betting.js";
import type { DeckCommitment } from "./shuffle.js";

export interface SeatView {
  userId: string;
  seatIndex: number;
  startStack: number;
  stack: number;
  bet: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  /** null = 看不到 */
  hole: readonly number[] | null;
}

export interface CommitmentView {
  /** 开局就公布 */
  hash: string;
  /** 摊牌后才给，玩家拿它自验庄家没换牌 */
  deck: readonly number[] | null;
  salt: string | null;
}

export interface HandView {
  handId: string;
  tableId: string;
  tier: string;
  button: number;
  street: Street;
  board: readonly number[];
  pot: number;
  currentBet: number;
  /** 轮到谁（userId）；null = 没人能行动 */
  toAct: string | null;
  seats: readonly SeatView[];
  /** 只有轮到你时才非空 */
  legal: readonly ActionOption[];
  done: boolean;
  pots: readonly Pot[];
  deltas: Readonly<Record<string, number>> | null;
  commitment: CommitmentView;
}

export interface ViewSource {
  handId: string;
  tableId: string;
  state: HandState;
  commitment: DeckCommitment;
}

/** 真摊了牌的座位下标（弃牌的人不在其中；全员弃到只剩一个也不在其中） */
function shownSeats(state: HandState): Set<number> {
  const out = new Set<number>();
  for (const e of state.log) if (e.t === "showdown") out.add(e.seat);
  return out;
}

export function viewFor(viewerId: string, src: ViewSource): HandView {
  const { state } = src;
  const shown = shownSeats(state);
  const revealed = state.done;

  return {
    handId: src.handId,
    tableId: src.tableId,
    tier: state.config.tier,
    button: state.button,
    street: state.street,
    board: state.board,
    pot: state.seats.reduce((a, s) => a + s.committed, 0),
    currentBet: state.currentBet,
    toAct: state.toAct >= 0 ? (state.seats[state.toAct]?.userId ?? null) : null,
    seats: state.seats.map((s, i) => ({
      userId: s.userId,
      seatIndex: i,
      startStack: s.startStack,
      stack: s.stack,
      bet: s.bet,
      committed: s.committed,
      folded: s.folded,
      allIn: s.allIn,
      hole: s.userId === viewerId || (revealed && shown.has(i)) ? s.hole : null,
    })),
    legal: legalActions(state, viewerId),
    done: state.done,
    pots: state.pots,
    deltas: state.done ? state.deltas : null,
    // hash 从头就给：玩家得先拿到承诺，事后揭示才有意义
    commitment: {
      hash: src.commitment.hash,
      deck: revealed ? src.commitment.deck : null,
      salt: revealed ? src.commitment.salt : null,
    },
  };
}

/** 视图里出现过的所有牌 —— 泄漏测试用它做全集比对 */
export function cardsIn(view: HandView): number[] {
  const out: number[] = [...view.board];
  for (const s of view.seats) if (s.hole) out.push(...s.hole);
  if (view.commitment.deck) out.push(...view.commitment.deck);
  return out;
}
