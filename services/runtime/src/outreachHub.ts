// outreachHub —— 把「原聊天」与「外联会话」两头接起来（#1441）。daemon 一个。只依赖注入的回调：
// daemon.ts 进不了 vitest，判断住在这儿、接线留在那儿（同 chatCreate / chatHumans 的做法）。
import { outreachTierProblem, type FriendTier } from "../../../src/shared/friendTier.js";
import { FRIEND_MESSAGE_PER_HOUR_MAX, agentDmBody, friendMessageSentText, outreachReportText, resolveFriend, missedCallMessageText } from "../../../src/shared/outreach.js";
import { bridgeWindowAllows, pruneBridgeWindow } from "../../../src/shared/laneBridge.js";
import type { FriendPickCandidate, OutreachLine, OutreachOutcome } from "../../../src/session/events.js";
import { friendPickToolText, pickFriend } from "../../../src/shared/friendPick.js";
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
  /** message_friend（#1549）：以主人（sender）名义往私聊里写一条。好友关系由 friendsOf（只认 accepted）+ resolveFriend 在这里验过，
      实现用 service key 绕过 RLS 直接 insert；抛错 = 没写进去 */
  sendDm(sender: string, recipient: string, body: string): Promise<void>;
}
export interface OutreachTarget {
  startOutreach(s: OutreachStart): Promise<OutreachStartResult>;
}
export interface OutreachOrigin {
  logOutreach(e: {
    outreachId: string; phase: "started" | "ended"; fromAgentId: string; peerUid: string; peerName: string;
    outcome?: OutreachOutcome; durationMs?: number; transcript?: OutreachLine[]; leftMessage?: true;
  }): void;
  reportOutreach(r: { agentId: string; text: string; ownerUid: string }): void;
  /** 选人卡（#1520）：offered 由 dispatch 落；picked / dismissed / failed 由点卡那条路落 */
  logFriendPick(e: {
    pickId: string; phase: "offered" | "picked" | "dismissed" | "failed"; fromAgentId: string;
    question?: string; candidates?: FriendPickCandidate[]; brief?: string; opening?: string; uid?: string; message?: string;
  }): void;
}
export interface OutreachHub {
  dispatch(o: {
    workspaceId: string; ownerUid: string; originSessionId: string; agentId: string; agentName: string;
    friend: string; brief: string; opening: string;
    /** 模型自己拿不准时列的 2–4 个名字（#1520） */
    candidates?: readonly string[];
    /** 这条聊天里打过的好友，新的在前（#1520） */
    recentUids: readonly string[];
  }): Promise<string>;
  /** 主人在选人卡上点了一位（#1520）：null = 已拨出；string = 打不出去的那句人话 */
  dialPicked(o: {
    workspaceId: string; ownerUid: string; originSessionId: string; agentId: string; agentName: string;
    uid: string; brief: string; opening: string;
  }): Promise<string | null>;
  ended(workspaceId: string, ownerUid: string, r: OutreachEnded): Promise<void>;
  /** message_friend（#1549）：解析好友、档位、每小时窗，然后以主人名义写一条私聊。回给模型的那句话 */
  message(o: { workspaceId: string; ownerUid: string; agentId: string; agentName: string; friend: string; text: string }): Promise<string>;
}

type DialArgs = {
  workspaceId: string; ownerUid: string; originSessionId: string; agentId: string; agentName: string;
  brief: string; opening: string;
};

export function createOutreachHub(d: OutreachHubDeps): OutreachHub {
  // 发消息的滑动窗（#1549）：每（主场，智能体，好友）最近一小时的时间戳。进程内即可——重启清零的代价是多发几条，不是漏发
  const dmWindow = new Map<string, number[]>();
  /** 认准了人（且档位已过）之后的拨号（dispatch 与 dialPicked 共用，#1520）：几道检查、开原聊天房、建外联会话、响铃、落 started */
  async function dialResolved(
    o: DialArgs, m: { uid: string; name: string },
  ): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    try {
      // 一只同一时刻只打一通（终审 M2）：跨它所有外联会话判，打给小红的那通还在时不许再打给小明。
      // 文案与 outreachRun.start 里同一条线的那句逐字相同——对模型来说是同一件事
      if (await d.activeFor(o.workspaceId, o.agentId)) return { ok: false, message: "这只正在打另一通电话，等它打完再派。" };
      if ((await d.deviceCount(m.uid)) === 0) return { ok: false, message: `${m.name} 的手机上还没有能接电话的 App，打不了。告诉他换个方式联系。` };
      const blocked = await d.ownerBlocked(o.workspaceId, o.ownerUid);
      if (blocked !== null) return { ok: false, message: `电话没打出去：${blocked}` };
    } catch (err) {
      d.log(`外联前检查失败（workspace=${o.workspaceId}）：${String(err)}`);
      return { ok: false, message: "这会儿查不了，电话没打出去，稍后再试。" };
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
    if (origin === null) return { ok: false, message: "电话没打出去（这条聊天这会儿接不了结果），稍后再试。" };
    const ownerName = await d.labelOf(o.ownerUid);
    let target: OutreachTarget;
    try {
      target = await d.ensureSession(o.workspaceId, o.ownerUid, ownerName, { agentId: o.agentId, name: o.agentName }, { uid: m.uid, name: m.name });
    } catch (err) {
      d.log(`建外联会话失败（workspace=${o.workspaceId}）：${String(err)}`);
      return { ok: false, message: "电话没打出去（线路没建起来），稍后再试。" };
    }
    const outreachId = d.newId();
    const r = await target.startOutreach({
      outreachId, originSessionId: o.originSessionId, agentId: o.agentId, agentName: o.agentName,
      ownerName, peerUid: m.uid, peerName: m.name, brief: o.brief, opening: o.opening,
    });
    if (r.kind === "refused") return { ok: false, message: r.message };
    origin.logOutreach({ outreachId, phase: "started", fromAgentId: o.agentId, peerUid: m.uid, peerName: m.name });
    return { ok: true, text: `已经打给 ${m.name} 了。先回他一句「打过去了」；聊完或者没接，通话记录会带回这条聊天，到时你再汇报。` };
  }

  return {
    async dispatch(o) {
      let friends: { uid: string; name: string; tier?: FriendTier }[];
      try {
        friends = await d.friendsOf(o.ownerUid);
      } catch (err) {
        d.log(`查好友名单失败（owner=${o.ownerUid}）：${String(err)}`);
        return "这会儿查不到好友名单，电话没打出去，稍后再试。";
      }
      // 认人与档位（#1494，ADR-0350）都在 pickFriend 里：只有两边都开到「全部开放」，智能体才能直接打过去；
      // 模型拿到的是真话（「他没开放」），不是「没这个朋友」
      const decision = pickFriend({
        friends, wanted: o.friend, recentUids: o.recentUids,
        ...(o.candidates !== undefined ? { candidates: o.candidates } : {}),
      });
      if (decision.kind === "text") return decision.message;
      if (decision.kind === "card") {
        // 认不准（#1520）：在原聊天落一张卡，主人点谁 dialPicked 就打给谁——这一轮到此为止，不响铃
        let origin: OutreachOrigin | null;
        try {
          origin = await d.origin(o.workspaceId, o.originSessionId);
        } catch (err) {
          d.log(`开原会话房失败（session=${o.originSessionId}）：${String(err)}`);
          origin = null;
        }
        if (origin === null) return "这会儿弹不出选人卡，稍后再试。";
        origin.logFriendPick({
          pickId: d.newId(), phase: "offered", fromAgentId: o.agentId,
          question: decision.question, candidates: decision.candidates, brief: o.brief, opening: o.opening,
        });
        return friendPickToolText(decision.candidates.map((c) => c.name));
      }
      const r = await dialResolved(o, { uid: decision.uid, name: decision.name });
      return r.ok ? r.text : r.message;
    },
    async dialPicked(o) {
      let friends: { uid: string; name: string; tier?: FriendTier }[];
      try {
        friends = await d.friendsOf(o.ownerUid);
      } catch (err) {
        d.log(`查好友名单失败（owner=${o.ownerUid}）：${String(err)}`);
        return "这会儿查不到好友名单，电话没打出去，稍后再试。";
      }
      // 出卡之后可能删了好友、降了档（#1520 spec §6）：以此刻的名单为准，名字也用此刻的
      const f = friends.find((x) => x.uid === o.uid);
      if (f === undefined) return "他已经不在好友名单里了，电话没打出去。";
      if (f.tier !== undefined) {
        const refused = outreachTierProblem(f.tier, f.name);
        if (refused !== null) return refused;
      }
      const r = await dialResolved(o, { uid: f.uid, name: f.name });
      return r.ok ? null : r.message;
    },
    async message(o) {
      let friends: { uid: string; name: string; tier?: FriendTier }[];
      try {
        friends = await d.friendsOf(o.ownerUid);
      } catch (err) {
        d.log(`查好友名单失败（owner=${o.ownerUid}）：${String(err)}`);
        return "这会儿查不到好友名单，消息没发出去，稍后再试。";
      }
      const m = resolveFriend(friends, o.friend);
      if (m.kind === "none") {
        return m.names.length === 0
          ? "他还没有好友，发不了。"
          : `好友里没有叫「${o.friend}」的。他的好友有：${m.names.join("、")}。问问他指的是哪一位。`;
      }
      if (m.kind === "many") return `好友里有 ${m.count} 位叫「${o.friend}」，分不出是哪一位，问问他。`;
      // 档位同打电话（#1494）：那句文案本来就写着「打电话或发消息」
      const tier = friends.find((f) => f.uid === m.uid)?.tier;
      if (tier !== undefined) {
        const refused = outreachTierProblem(tier, m.name);
        if (refused !== null) return refused;
      }
      const key = `${o.workspaceId}/${o.agentId}/${m.uid}`;
      const now = d.now();
      const sent = pruneBridgeWindow(dmWindow.get(key) ?? [], now);
      if (!bridgeWindowAllows(sent, now, FRIEND_MESSAGE_PER_HOUR_MAX)) {
        return `这一小时里给 ${m.name} 发的消息已经到上限了（${FRIEND_MESSAGE_PER_HOUR_MAX} 条），缓一缓再发，或者让他自己发。`;
      }
      const body = agentDmBody(o.agentName, o.text);
      try {
        await d.sendDm(o.ownerUid, m.uid, body);
      } catch (err) {
        d.log(`替主人发私聊失败（owner=${o.ownerUid} → ${m.uid}）：${String(err)}`);
        return "消息没发出去（写不进去），稍后再试。";
      }
      dmWindow.set(key, [...sent, now]);
      return friendMessageSentText(m.name, body);
    },
    async ended(workspaceId, ownerUid, r) {
      // 落到这里的都是收尾回调；抛了只记日志（同下面那层 try）
      async function leaveMessage(ws: string, owner: string, e: OutreachEnded, agentName: string): Promise<boolean> {
        const key = `${ws}/${e.agentId}/${e.peerUid}`;
        const now = d.now();
        const sent = pruneBridgeWindow(dmWindow.get(key) ?? [], now);
        if (!bridgeWindowAllows(sent, now, FRIEND_MESSAGE_PER_HOUR_MAX)) {
          d.log(`没接但这一小时给 ${e.peerName} 的消息已到上限，没留言（owner=${owner}）`);
          return false;
        }
        try {
          await d.sendDm(owner, e.peerUid, agentDmBody(agentName, missedCallMessageText(e.opening)));
        } catch (err) {
          d.log(`没接留言失败（owner=${owner} → ${e.peerUid}）：${String(err)}`);
          return false;
        }
        dmWindow.set(key, [...sent, now]);
        return true;
      }
      try {
        const origin = await d.origin(workspaceId, r.originSessionId);
        if (origin === null) {
          d.log(`外联结束但原会话开不出来（session=${r.originSessionId}）`);
          return;
        }
        const agentName = r.agentName !== "" ? r.agentName : await d.agentName(workspaceId, r.agentId);
        const ownerName = r.ownerName !== "" ? r.ownerName : await d.labelOf(ownerUid);
        // 没接就留言（#1616，真机 2026-10-05：管理员跑回来告诉主人「他没接」= 把球踢回主人）：开场白就是电话里要说的话，
        // 以主人名义写进和对方的私聊（同 message_friend 那条路：代发前缀 + 每小时窗口；档位在拨号时已验过）。
        // 发不出去不算失败——照旧汇报「没接」，模型会告诉主人
        const leftMessage = r.outcome === "missed" && r.opening !== "" ? await leaveMessage(workspaceId, ownerUid, r, agentName) : false;
        origin.logOutreach({
          outreachId: r.outreachId, phase: "ended", fromAgentId: r.agentId, peerUid: r.peerUid, peerName: r.peerName,
          outcome: r.outcome, ...(r.durationMs !== null ? { durationMs: r.durationMs } : {}),
          ...(r.transcript.length > 0 ? { transcript: r.transcript } : {}),
          ...(leftMessage ? { leftMessage: true as const } : {}),
        });
        origin.reportOutreach({
          agentId: r.agentId, ownerUid,
          text: outreachReportText({ agentName, ownerName, peerName: r.peerName, outcome: r.outcome, durationMs: r.durationMs, transcript: r.transcript, leftMessage }),
        });
      } catch (err) {
        d.log(`外联汇报失败（session=${r.originSessionId}）：${String(err)}`);
      }
    },
  };
}
