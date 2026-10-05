// 群座位的桥（#1682，ADR-0376）：群（正本，建群人的主场）与各成员的座位（各自主场）之间互相送话。
//
// 形状照管理员车道的 adminsBridge（daemon.ts）：所有主场都在同一个 runtime 进程里，桥是进程内调用。
// 送什么：群 → 座位：「谁 @ 了你、说了什么」+ 这个座位上次之后群里的每一句（镜像，给管理员当背景）；
//         座位 → 群：管理员说的每一句、点头卡与它的结局。
// 判断都在两头的 CloudSession 里（谁在籍、谁能点、要不要弹卡），这里只负责找到房间、把东西递过去。
// 依赖注入：开房 / 建座位由 daemon 给（它握着 Supabase），测试给两条真 CloudSession 就能把整条链跑通。
import type { SeatDecisionEvent, SeatRequestEvent } from "../../../src/session/events.js";
import type { SeatPolicy } from "../../../src/shared/groupSeats.js";
import type { CloudSession } from "./sessionService.js";

export interface GroupRef {
  workspaceId: string;
  sessionId: string;
}

/** 送进座位的那一句：谁说的（人，或别家管理员的主人）、怎么称呼、原话、接力深度、这个座位此刻的策略 */
export interface SeatOpening {
  fromUid: string;
  fromName: string;
  text: string;
  depth: number;
  policy: SeatPolicy;
  /** 叫醒它的那一句在群日志里的 seq：座位按它把镜像与开场白排对顺序，这一句不再重复镜像 */
  groupSeq: number;
  /** 说话人设备的时区（#1283 那一格）：座位里的开场白带上它，模型才算得出「十分钟后」是几点。缺席 = 不知道 */
  tz?: string;
}

export interface SeatHub {
  /** 群 → 座位：有人 @ 了这个座位的管理员。回 null = 送到了；字符串 = 没送到的那句人话（群里说给大家听） */
  deliver(o: { group: GroupRef; seatUid: string; opening: SeatOpening }): Promise<string | null>;
  /** 群 → 座位：座位主人在群里点了头卡 */
  decide(o: { group: GroupRef; seatUid: string; requestId: string; byUid: string; decision: "accepted" | "declined"; note?: string }): Promise<string | null>;
  /** 座位 → 群：管理员说了一句。`toUid` = 叫醒它的那个人（推送给他） */
  reply(o: { group: GroupRef; seatUid: string; text: string; model: string; toUid: string | null; depth: number; worker?: { agentId: string; name: string } }): Promise<void>;
  /** 座位 → 群：管理员正在吐的半句话（流式预览，不落日志）。fire-and-forget */
  delta(o: { group: GroupRef; seatUid: string; text: string }): void;
  /** 座位 → 群：点头卡与它的结局（镜像） */
  request(o: { group: GroupRef; event: SeatRequestEvent }): Promise<void>;
  decision(o: { group: GroupRef; event: SeatDecisionEvent }): Promise<void>;
}

export interface SeatHubDeps {
  /** 群那间房（关着就开）。null = 这个群不在了 / 开不出来 */
  group(ref: GroupRef): Promise<CloudSession | null>;
  /** 这个人在这个群里的座位（没有就建、关着就开）。字符串 = 建不出来的那句人话 */
  seat(seatUid: string, ref: GroupRef): Promise<CloudSession | string>;
  log(m: string): void;
}

export function createSeatHub(deps: SeatHubDeps): SeatHub {
  const groupOf = async (ref: GroupRef): Promise<CloudSession | null> => {
    try {
      return await deps.group(ref);
    } catch (err) {
      deps.log(`群座位：群开不出来（session=${ref.sessionId}）：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  const seatOf = async (seatUid: string, ref: GroupRef): Promise<CloudSession | string> => {
    try {
      return await deps.seat(seatUid, ref);
    } catch (err) {
      deps.log(`群座位：座位开不出来（group=${ref.sessionId} uid=${seatUid}）：${err instanceof Error ? err.message : String(err)}`);
      return "这会儿接不住，稍后再 @ 一次";
    }
  };
  return {
    async deliver({ group: ref, seatUid, opening }) {
      const group = await groupOf(ref);
      if (group === null || group.seatLinesFor === undefined) return "这个群这会儿打不开";
      if (group.seatMember?.(seatUid) !== true) return "TA 已经不在这个群里了";
      const seat = await seatOf(seatUid, ref);
      if (typeof seat === "string") return seat;
      if (seat.seatDeliver === undefined) return "这会儿接不住，稍后再 @ 一次";
      const lines = group.seatLinesFor(seatUid, seat.mirroredUpTo?.() ?? null);
      return seat.seatDeliver({ lines, opening });
    },
    async decide({ group: ref, seatUid, requestId, byUid, decision, note }) {
      const seat = await seatOf(seatUid, ref);
      if (typeof seat === "string") return seat;
      if (seat.seatDecide === undefined) return "这会儿接不住，稍后再点";
      return seat.seatDecide(requestId, byUid, decision, note);
    },
    async reply({ group: ref, seatUid, text, model, toUid, depth, worker }) {
      const group = await groupOf(ref);
      group?.receiveSeatReply?.({ seatUid, text, model, toUid, depth, ...(worker !== undefined ? { worker } : {}) });
    },
    delta({ group: ref, seatUid, text }) {
      void groupOf(ref).then((group) => group?.receiveSeatDelta?.(seatUid, text));
    },
    async request({ group: ref, event }) {
      const group = await groupOf(ref);
      group?.receiveSeatRequest?.(event);
    },
    async decision({ group: ref, event }) {
      const group = await groupOf(ref);
      group?.receiveSeatDecision?.(event);
    },
  };
}
