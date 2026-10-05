// laneBridge —— 把 A 车道里智能体的一句话落进 B 主场里公开给 A 的那条车道（#1542，ADR-0358）。daemon 一个。
// 只依赖注入的回调（同 outreachHub 的纪律：daemon.ts 进不了 vitest，判断住在这儿、接线留在那儿）。
//
// 四道闸，顺序固定：① 深度（接力的同一个天花板 DEFAULT_RELAY_MAX_DEPTH，跨车道累加）→ ② 这一对每小时的封顶
// → ③ 对面有没有公开给 A 的车道、A 在不在它的客人名单里 → ④ 对面车道里点谁。全过了才以 **A（对面车道的客人）** 的身份
// `say` 一句进去，带 `relay: { fromAgentId, depth + 1 }`——对面那一轮是客人点起的（每一刀要 B 批），且是接力棒（连接器要点火者批）。
import { DEFAULT_RELAY_MAX_DEPTH } from "../../../src/shared/agentRelay.js";
import { ADMIN_AGENT_ID } from "../../../src/shared/workspaceAgents.js";
import {
  bridgeSentText, bridgeSpeakerLabel, bridgeWindowAllows, pruneBridgeWindow, resolveBridgeTarget, BRIDGE_PER_HOUR_MAX,
} from "../../../src/shared/laneBridge.js";

export interface LaneTarget {
  isGuest(uid: string): boolean;
  /** 对面车道此刻的名单（id + 名字） */
  roster(): Promise<{ agentId: string; name: string }[]>;
  say(fromUid: string, label: string, text: string, mentions: string[], relay: { fromAgentId: string; depth: number }): Promise<void>;
}

export interface LaneBridgeDeps {
  /** B（peerUid）主场里公开给 A（ownerUid）的那条车道；没有回 null。抛错 = 这一刻查不出来 */
  findPeerLane(peerUid: string, ownerUid: string): Promise<{ workspaceId: string; sessionId: string } | null>;
  /** 开（或拿到）那条车道的房；拿不到回 null */
  openLane(workspaceId: string, sessionId: string): Promise<LaneTarget | null>;
  labelOf(uid: string): Promise<string>;
  now(): number;
  log(m: string): void;
}

export interface LaneBridge {
  send(o: {
    ownerUid: string; peerUid: string; fromAgentId: string; fromAgentName: string;
    text: string; wanted: string | undefined;
    /** 这一轮开场白的接力深度（runJob 算出的 openingDepth） */
    depth: number;
  }): Promise<string>;
}

export function createLaneBridge(d: LaneBridgeDeps): LaneBridge {
  /** `${ownerUid}>${peerUid}` → 最近一小时发出去的时刻 */
  const windows = new Map<string, number[]>();
  return {
    async send(o) {
      // ① 深度：到顶硬停，与接力同一个数。跨车道累加——A 的智能体发过去是 depth+1，B 的智能体回来再 +1
      if (o.depth + 1 > DEFAULT_RELAY_MAX_DEPTH) {
        return `你们来回已经 ${o.depth} 棒了，到了上限，这一句没发。把结论告诉主人，让两位主人自己接着聊。`;
      }
      // ② 每一对每小时封顶
      const key = `${o.ownerUid}>${o.peerUid}`;
      const sent = pruneBridgeWindow(windows.get(key) ?? [], d.now());
      if (!bridgeWindowAllows(sent, d.now())) {
        return `这一小时给对方智能体发的话已经到 ${BRIDGE_PER_HOUR_MAX} 条了，这一句没发。等等再说，或者让主人自己发。`;
      }
      // ③ 对面的车道
      let lane: { workspaceId: string; sessionId: string } | null;
      try {
        lane = await d.findPeerLane(o.peerUid, o.ownerUid);
      } catch (err) {
        d.log(`找对面车道失败（peer=${o.peerUid}）：${String(err)}`);
        return "这会儿查不到对方有没有公开的智能体，这一句没发，稍后再试。";
      }
      const peerName = await d.labelOf(o.peerUid);
      if (lane === null) return `${peerName} 还没有把智能体公开到这条私聊里，发不过去。要对方那边的信息或动作，用 invite_collaborator 交给 ${peerName} 的管理员（先 create_task）；或者请主人让 ${peerName} 把智能体设成「公开」。`;
      const target = await d.openLane(lane.workspaceId, lane.sessionId);
      if (target === null) return "对面的车道这会儿开不起来，这一句没发，稍后再试。";
      if (!target.isGuest(o.ownerUid)) return `${peerName} 那条车道没有把你的主人加进去（可能刚收成了仅 TA 可见），发不过去。`;
      // ④ 点谁
      const roster = await target.roster();
      // 跨主场只有 L0 ↔ L0（#1578，ADR-0368）：对面车道里有管理员就一律交给它，点名别的只也改到管理员；
      // 老车道（名单里还没有管理员）照旧按名字找
      const admin = roster.find((a) => a.agentId === ADMIN_AGENT_ID);
      const who = admin !== undefined ? ({ kind: "one", agentId: admin.agentId, name: admin.name } as const) : resolveBridgeTarget(roster, o.wanted);
      if (who.kind === "none") {
        return who.names.length === 0
          ? `${peerName} 的车道里此刻没有智能体，发不过去。`
          : `${peerName} 那边没有叫「${o.wanted ?? ""}」的智能体。TA 公开的有：${who.names.join("、")}。`;
      }
      if (who.kind === "many") return `${peerName} 公开了 ${who.count} 只，说清楚发给哪一只（agent 填名字）。`;
      const ownerName = await d.labelOf(o.ownerUid);
      try {
        await target.say(o.ownerUid, bridgeSpeakerLabel(o.fromAgentName, ownerName), o.text, [who.agentId], { fromAgentId: o.fromAgentId, depth: o.depth + 1 });
      } catch (err) {
        d.log(`落话进对面车道失败（session=${lane.sessionId}）：${String(err)}`);
        return `这一句没发进去：${err instanceof Error ? err.message : String(err)}`;
      }
      windows.set(key, [...sent, d.now()]);
      return bridgeSentText(who.name, peerName);
    },
  };
}
