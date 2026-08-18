// 牌局房间 —— 进行中的一手牌活在网关进程内存里，结算才落库。
//
// 为什么不每一步都落库：一手牌是一个原子的钱事件，中途的下注不是。
// 进程崩在半手牌上，桌上筹码回到开手前的样子（什么都没结算），
// 这是安全的失败方向 —— 反过来（半截状态落了库）才要命。
// 代价写明：崩溃会丢掉进行中的那手牌，玩家要重开一手。
//
// 庄位轮转也只在内存里。重启后从 0 号座重来，对钱没有影响，
// 只影响谁先当庄 —— 用一张表存它换不来等值的东西。

import { randomUUID } from "node:crypto";
import {
  applyAction as applyEngineAction, startHand as startEngineHand,
  type Action, type HandState, type TableConfig,
} from "./poker/betting.js";
import { commitDeck, type DeckCommitment } from "./poker/shuffle.js";
import { viewFor, type HandView } from "./poker/view.js";
import { toHandRecord, type PokerStore } from "./pokerStore.js";

export interface TableInfo {
  id: string;
  tier: string;
  smallBlind: number;
  bigBlind: number;
  minBuyin: number;
  maxBuyin: number;
  maxSeats: number;
}

export interface SeatRow {
  userId: string;
  seatIndex: number;
  stack: number;
}

export interface TablesDeps {
  store: PokerStore;
  loadTable(tableId: string): Promise<TableInfo | null>;
  loadSeats(tableId: string): Promise<SeatRow[]>;
  /** 注入：测试要能钉死 handId */
  newId?: () => string;
  /** 注入：测试要能钉死牌序 */
  commit?: () => DeckCommitment;
  /** 状态变了就叫一声，SSE 那层据此推送 */
  onChange?: (tableId: string) => void;
}

interface LiveHand {
  handId: string;
  commitment: DeckCommitment;
  state: HandState;
  /** 结算过没有 —— 结算是一次性的，重复调用只会被 DB 的幂等挡住，但没必要走那一趟 */
  settled: boolean;
}

export class Tables {
  private readonly live = new Map<string, LiveHand>();
  private readonly button = new Map<string, number>();
  private readonly deps: Required<Pick<TablesDeps, "newId" | "commit" | "onChange">> & TablesDeps;

  constructor(deps: TablesDeps) {
    this.deps = {
      ...deps,
      newId: deps.newId ?? (() => randomUUID()),
      commit: deps.commit ?? (() => commitDeck()),
      onChange: deps.onChange ?? (() => {}),
    };
  }

  hasLiveHand(tableId: string): boolean {
    const h = this.live.get(tableId);
    return h !== undefined && !h.state.done;
  }

  /** 开一手牌。桌上有牌在打就拒绝 —— 同一张桌不能同时跑两手 */
  async startHand(tableId: string): Promise<HandState> {
    if (this.hasLiveHand(tableId)) throw new Error("这张桌上还有一手牌没打完");
    const table = await this.deps.loadTable(tableId);
    if (!table) throw new Error(`没有这张桌：${tableId}`);

    const seats = (await this.deps.loadSeats(tableId))
      .filter((s) => s.stack > 0)
      .sort((a, b) => a.seatIndex - b.seatIndex);
    if (seats.length < 2) throw new Error("至少要两个有筹码的人才能开牌");

    // 庄位按**在座人数**轮转，不是按座位号：有人离桌后座位号会有洞
    const next = ((this.button.get(tableId) ?? -1) + 1) % seats.length;
    this.button.set(tableId, next);

    const config: TableConfig = {
      tier: table.tier,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
    };
    const commitment = this.deps.commit();
    const state = startEngineHand(
      config,
      seats.map((s) => ({ userId: s.userId, stack: s.stack })),
      commitment.deck,
      next
    );
    this.live.set(tableId, { handId: this.deps.newId(), commitment, state, settled: false });
    this.deps.onChange(tableId);
    // 开局就可能已经结束（全员盲注 all-in 直接跑完）
    await this.settleIfDone(tableId);
    return this.live.get(tableId)!.state;
  }

  /** 走一步。服务端权威：动作由引擎判定合法性，客户端说了不算 */
  async act(tableId: string, userId: string, action: Action): Promise<HandState> {
    const hand = this.live.get(tableId);
    if (!hand || hand.state.done) throw new Error("这张桌上没有进行中的牌局");
    hand.state = applyEngineAction(hand.state, userId, action);
    this.deps.onChange(tableId);
    await this.settleIfDone(tableId);
    return hand.state;
  }

  /** 按人裁剪的视图。没有进行中的牌局返回 null */
  view(tableId: string, viewerId: string): HandView | null {
    const hand = this.live.get(tableId);
    if (!hand) return null;
    return viewFor(viewerId, {
      handId: hand.handId,
      tableId,
      state: hand.state,
      commitment: hand.commitment,
    });
  }

  private async settleIfDone(tableId: string): Promise<void> {
    const hand = this.live.get(tableId);
    if (!hand || !hand.state.done || hand.settled) return;
    // 先置标记再落库：落库抛错时不该被重试成两次结算
    // （DB 那侧按 handId 幂等，这里只是不白跑一趟）
    hand.settled = true;
    await this.deps.store.settle(
      toHandRecord(hand.handId, tableId, hand.state, hand.commitment)
    );
    this.deps.onChange(tableId);
  }
}
