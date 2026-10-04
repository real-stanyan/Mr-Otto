// outreachHub —— 把「原聊天」与「外联会话」两头接起来（#1441）。daemon 一个。只依赖注入的回调：
// daemon.ts 进不了 vitest，判断住在这儿、接线留在那儿（同 chatCreate / chatHumans 的做法）。
import { outreachTierProblem, type FriendTier } from "../../../src/shared/friendTier.js";
import type { OutreachLine, OutreachOutcome } from "../../../src/session/events.js";
import { outreachReportText, resolveFriend } from "../../../src/shared/outreach.js";
import type { OutreachEnded, OutreachStart, OutreachStartResult } from "./outreachRun.js";

export interface OutreachHubDeps {
  /** `tier` = 这位朋友与主人之间生效的那一档（#1494）；缺席 = 不按档位拦（老调用方 / 测试） */
  friendsOf(ownerUid: string): Promise<{ uid: string; name: string; tier?: FriendTier }[]>; // 抛错 = 这一刻查不出来
  deviceCount(uid: string): Promise<number>;
  ownerBlocked(workspaceId: string, ownerUid: string): Promise<string | null>; // 额度：null = 能跑
  /** 这只此刻在它任一条外联会话里有没有一通没收尾（终审 M2）；抛错 = 这一刻查不出来 */
  activeFor(workspaceId: string, agentId: string): Promise<boolean>;
  ensureSession(
    workspaceId: string, ownerUid: string, ownerName: string,
    agent: { agentId: string; name: string }, peer: { uid: string; name: string },
  ): Promise<OutreachTarget>;
  origin(workspaceId: string, sessionId: string): Promise<OutreachOrigin | null>; // 原会话房，关着就开
  agentName(workspaceId: string, agentId: string): Promise<string>;
  labelOf(uid: string): Promise<string>;
  newId(): string;
  now(): number;
  log(m: string): void;
}
export interface OutreachTarget {
  startOutreach(s: OutreachStart): Promise<OutreachStartResult>;
}
export interface OutreachOrigin {
  logOutreach(e: {
    outreachId: string; phase: "started" | "ended"; fromAgentId: string; peerUid: string; peerName: string;
    outcome?: OutreachOutcome; durationMs?: number; transcript?: OutreachLine[];
  }): void;
  reportOutreach(r: { agentId: string; text: string; ownerUid: string }): void;
}
export interface OutreachHub {
  dispatch(o: {
    workspaceId: string; ownerUid: string; originSessionId: string; agentId: string; agentName: string;
    friend: string; brief: string; opening: string;
  }): Promise<string>;
  ended(workspaceId: string, ownerUid: string, r: OutreachEnded): Promise<void>;
}

export function createOutreachHub(d: OutreachHubDeps): OutreachHub {
  return {
    async dispatch(o) {
      let friends: { uid: string; name: string; tier?: FriendTier }[];
      try {
        friends = await d.friendsOf(o.ownerUid);
      } catch (err) {
        d.log(`查好友名单失败（owner=${o.ownerUid}）：${String(err)}`);
        return "这会儿查不到好友名单，电话没打出去，稍后再试。";
      }
      const m = resolveFriend(friends, o.friend);
      if (m.kind === "none") {
        return m.names.length === 0
          ? "他还没有好友，打不了。"
          : `好友里没有叫「${o.friend}」的。他的好友有：${m.names.join("、")}。问问他指的是哪一位。`;
      }
      if (m.kind === "many") return `好友里有 ${m.count} 位叫「${o.friend}」，分不出是哪一位，问问他。`;
      // 档位（#1494，ADR-0350）：只有两边都开到「全部开放」，智能体才能直接打过去。拦在 resolveFriend 之后——
      // 模型拿到的是真话（「他没开放」），不是「没这个朋友」
      const tier = friends.find((f) => f.uid === m.uid)?.tier;
      if (tier !== undefined) {
        const refused = outreachTierProblem(tier, m.name);
        if (refused !== null) return refused;
      }
      try {
        // 一只同一时刻只打一通（终审 M2）：跨它所有外联会话判，打给小红的那通还在时不许再打给小明。
        // 文案与 outreachRun.start 里同一条线的那句逐字相同——对模型来说是同一件事
        if (await d.activeFor(o.workspaceId, o.agentId)) return "这只正在打另一通电话，等它打完再派。";
        if ((await d.deviceCount(m.uid)) === 0) return `${m.name} 的手机上还没有能接电话的 App，打不了。告诉他换个方式联系。`;
        const blocked = await d.ownerBlocked(o.workspaceId, o.ownerUid);
        if (blocked !== null) return `电话没打出去：${blocked}`;
      } catch (err) {
        d.log(`外联前检查失败（workspace=${o.workspaceId}）：${String(err)}`);
        return "这会儿查不了，电话没打出去，稍后再试。";
      }
      // 原聊天房先拿到、再响铃（#1441 复审）：响铃之后才发现原聊天开不出来，就成了「电话在响、工具报错、
      // 原聊天里没有 started」。拿不到就一个铃都不打
      let origin: OutreachOrigin | null;
      try {
        origin = await d.origin(o.workspaceId, o.originSessionId);
      } catch (err) {
        d.log(`开原会话房失败（session=${o.originSessionId}）：${String(err)}`);
        origin = null;
      }
      if (origin === null) return "电话没打出去（这条聊天这会儿接不了结果），稍后再试。";
      const ownerName = await d.labelOf(o.ownerUid);
      let target: OutreachTarget;
      try {
        target = await d.ensureSession(o.workspaceId, o.ownerUid, ownerName, { agentId: o.agentId, name: o.agentName }, { uid: m.uid, name: m.name });
      } catch (err) {
        d.log(`建外联会话失败（workspace=${o.workspaceId}）：${String(err)}`);
        return "电话没打出去（线路没建起来），稍后再试。";
      }
      const outreachId = d.newId();
      const r = await target.startOutreach({
        outreachId, originSessionId: o.originSessionId, agentId: o.agentId, agentName: o.agentName,
        ownerName, peerUid: m.uid, peerName: m.name, brief: o.brief, opening: o.opening,
      });
      if (r.kind === "refused") return r.message;
      origin.logOutreach({ outreachId, phase: "started", fromAgentId: o.agentId, peerUid: m.uid, peerName: m.name });
      return `已经打给 ${m.name} 了。先回他一句「打过去了」；聊完或者没接，通话记录会带回这条聊天，到时你再汇报。`;
    },
    async ended(workspaceId, ownerUid, r) {
      try {
        const origin = await d.origin(workspaceId, r.originSessionId);
        if (origin === null) {
          d.log(`外联结束但原会话开不出来（session=${r.originSessionId}）`);
          return;
        }
        origin.logOutreach({
          outreachId: r.outreachId, phase: "ended", fromAgentId: r.agentId, peerUid: r.peerUid, peerName: r.peerName,
          outcome: r.outcome, ...(r.durationMs !== null ? { durationMs: r.durationMs } : {}),
          ...(r.transcript.length > 0 ? { transcript: r.transcript } : {}),
        });
        const agentName = r.agentName !== "" ? r.agentName : await d.agentName(workspaceId, r.agentId);
        const ownerName = r.ownerName !== "" ? r.ownerName : await d.labelOf(ownerUid);
        origin.reportOutreach({
          agentId: r.agentId, ownerUid,
          text: outreachReportText({ agentName, ownerName, peerName: r.peerName, outcome: r.outcome, durationMs: r.durationMs, transcript: r.transcript }),
        });
      } catch (err) {
        d.log(`外联汇报失败（session=${r.originSessionId}）：${String(err)}`);
      }
    },
  };
}
