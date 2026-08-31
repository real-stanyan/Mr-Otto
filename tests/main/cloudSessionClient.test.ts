import { describe, expect, it, vi } from "vitest";
import {
  createCloudSessionClient, cloudSessionFleetRow,
  type CloudSessionClientDeps, type CloudSessionSummary,
} from "../../src/main/cloudSessionClient.js";
import { decodeCsUp, encodeCs, type CsDown, type CsUp } from "../../src/shared/remote/cloudSession.js";
import type { RemoteTransport } from "../../src/shared/remote/transport.js";
import type { ApprovalDecisionEvent, ApprovalRequestEvent, ChatMessageEvent, SessionEvent } from "../../src/session/events.js";
import type { ApprovalRequest, CloudSessionStatus } from "../../src/shared/shellBridge.js";
import { flattenFleet, initialIsland, type IslandState } from "../../src/main/islandProjection.js";
import { createWorkspaceLens } from "../../src/main/workspaceLens.js";

const HOST_CID = "host-cid-1";

/** 一次跳过当前微任务队列——sendHello 里 `await deps.accessToken()` 之后才真的
    调 transport.send，测试触发 emitPeer() 之后要等这一跳才能断言发出去的帧 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 按 cid 寻址的假传输，同 tests/main/remoteBridge.test.ts 的 fakeTransport 同一套写法 */
function fakeTransport() {
  const sent: { payload: string; to: string }[] = [];
  let onMsg: (p: string, from: string) => void = () => {};
  let onPeerCb: (cid: string) => void = () => {};
  let onGoneCb: (cid: string) => void = () => {};
  let onCloseCb: () => void = () => {};
  const closeSpy = vi.fn();
  return {
    sent,
    send(p: string, to: string) {
      sent.push({ payload: p, to });
    },
    onMessage(cb: (p: string, from: string) => void) {
      onMsg = cb;
    },
    onPeer(cb: (cid: string) => void) {
      onPeerCb = cb;
    },
    onGone(cb: (cid: string) => void) {
      onGoneCb = cb;
    },
    onClose(cb: () => void) {
      onCloseCb = cb;
    },
    reconnectNow() {},
    close: closeSpy,
    emitPeer(cid = HOST_CID) {
      onPeerCb(cid);
    },
    emitGone(cid = HOST_CID) {
      onGoneCb(cid);
    },
    emitClose() {
      onCloseCb();
    },
    /** 喂一条 CsDown 帧，默认来自 host */
    emitDown(msg: CsDown, from = HOST_CID) {
      onMsg(encodeCs(msg), from);
    },
    /** 已发出的帧按顺序解回 CsUp，方便断言形状而不是比较 base64 字符串 */
    decoded(): (CsUp | null)[] {
      return sent.map((s) => decodeCsUp(s.payload));
    },
  };
}

type FakeTransport = ReturnType<typeof fakeTransport>;

function harness(overrides: Partial<CloudSessionClientDeps> = {}) {
  const transports: FakeTransport[] = [];
  const events: SessionEvent[] = [];
  const statuses: CloudSessionStatus[] = [];
  const approvalRequests: ApprovalRequest[] = [];
  const approvalDecisions: ApprovalDecisionEvent[] = [];
  const inactiveSessionIds: string[] = [];
  const state = { uid: "self-uid" as string | null, token: "token-abc" as string | null };

  const deps: CloudSessionClientDeps = {
    accessToken: async () => state.token,
    selfUid: () => state.uid,
    createTransport: (_channel: string) => {
      const t = fakeTransport();
      transports.push(t);
      return t as unknown as RemoteTransport;
    },
    sendEvent: (e) => events.push(e),
    sendStatus: (s) => statuses.push(s),
    onApprovalRequest: (r) => approvalRequests.push(r),
    onApprovalDecision: (e) => approvalDecisions.push(e),
    onSessionInactive: (id) => inactiveSessionIds.push(id),
    ...overrides,
  };

  const client = createCloudSessionClient(deps);
  return {
    client, transports, events, statuses, approvalRequests, approvalDecisions, inactiveSessionIds, state,
  };
}

function chatMsg(seq: number, sessionId = "cloud-s1"): ChatMessageEvent {
  return { type: "chat_message", sessionId, seq, ts: 1000 + seq, fromUid: "u9", label: "Bob", content: `msg ${seq}`, mention: false };
}

function approvalRequestEvent(seq: number, sessionId = "cloud-s1"): ApprovalRequestEvent {
  return {
    type: "approval_request", sessionId, seq, ts: 1000 + seq,
    callId: `call-${seq}`, toolName: "bash", argsSummary: "ls -la",
    initiatorUid: "initiator-uid", expiresTs: 9999,
  };
}

describe("createCloudSessionClient — join / welcome / backlog 去重", () => {
  it("join 之后立即推一次 connecting 状态", async () => {
    const h = harness();
    const r = await h.client.join("w1", "cloud-s1");
    expect(r).toEqual({ ok: true, value: null });
    expect(h.statuses).toHaveLength(1);
    expect(h.statuses[0]).toMatchObject({
      workspaceId: "w1", sessionId: "cloud-s1", state: "connecting",
      initiatorUid: null, ownerUid: "", selfUid: "self-uid",
    });
    expect(h.client.currentSessionId()).toBe("cloud-s1");
  });

  it("onPeer 之后发 hello，帧发给 host 的 cid", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toBe(HOST_CID);
    expect(t.decoded()[0]).toEqual({ t: "hello", v: 1, jwt: "token-abc" });
  });

  it("welcome 到达后：状态补真值 + 自动发 backlog(-1)（不是 0）", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();

    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: 5, initiatorUid: "u1", ownerUid: "u2" });

    expect(t.decoded()[1]).toEqual({ t: "backlog", afterSeq: -1 });
    const last = h.statuses[h.statuses.length - 1]!;
    expect(last).toMatchObject({ state: "connecting", initiatorUid: "u1", ownerUid: "u2" });
  });

  it("还没 ready 时收到的直播事件先缓冲，不立即转发", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: 7, initiatorUid: "u1", ownerUid: "u2" });

    t.emitDown({ t: "event", event: chatMsg(5) });

    // 还没 ready：不立即转发，攒着
    expect(h.events).toHaveLength(0);
  });

  it("直播 event 抢跑在 backlog 之前到达（非 0 的 seq）：backlog 落定后按 seq 升序转发，不是到达顺序", async () => {
    // 复审 High 的原始复现：welcome(lastSeq=7) → 直播 event(seq=5) →
    // backlog([0..7])。旧实现即发即转会产出 [5,0,1,2,3,4,6,7]（非升序）；
    // 用 seq:0 测过去测不出这个 bug（它恰好是唯一不会逆序的边界值）
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: 7, initiatorUid: "u1", ownerUid: "u2" });

    t.emitDown({ t: "event", event: chatMsg(5) });
    expect(h.events).toHaveLength(0); // 还在缓冲区

    // backlog 落定：0..7 全量（含服务端已经广播过的 seq:5）
    const backlogEvents = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => chatMsg(n));
    t.emitDown({ t: "backlog", events: backlogEvents, done: true });

    expect(h.events).toHaveLength(8); // 去重：不是 9
    expect(h.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // 严格升序
    expect(h.statuses[h.statuses.length - 1]!.state).toBe("ready");
  });

  it("直播事件的 seq 比 backlog 本身携带的更新（backlog 没包含它）：合并排序后追加在最后", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: 6, initiatorUid: "u1", ownerUid: "u2" });

    // backlog 请求飞在路上时,一条全新的事件(seq:7)先被直播广播到
    t.emitDown({ t: "event", event: chatMsg(7) });
    // backlog 只带回它落地时读到的 0..6(不含 7——服务端处理 backlog 请求那一刻 7 还没提交)
    t.emitDown({ t: "backlog", events: [0, 1, 2, 3, 4, 5, 6].map((n) => chatMsg(n)), done: true });

    expect(h.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("ready 之后收到的直播事件直接转发，不再经过缓冲", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: null, ownerUid: "u2" });
    t.emitDown({ t: "backlog", events: [], done: true });
    expect(h.statuses[h.statuses.length - 1]!.state).toBe("ready");

    t.emitDown({ t: "event", event: chatMsg(0) });
    expect(h.events).toHaveLength(1); // 立即到账，不用等下一次 backlog
  });

  it("backlog done:false 不置 ready", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: null, ownerUid: "u2" });
    t.emitDown({ t: "backlog", events: [], done: false });
    expect(h.statuses.some((s) => s.state === "ready")).toBe(false);
  });
});

describe("createCloudSessionClient — approval_request / approval_decision", () => {
  async function readyHarness(selfUid: string) {
    const h = harness();
    h.state.uid = selfUid;
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: "initiator-uid", ownerUid: "owner-uid" });
    t.emitDown({ t: "backlog", events: [], done: true }); // 推进到 ready，事件才走直发路径
    return { h, t };
  }

  it("selfUid === initiatorUid → 进 onApprovalRequest 回调，形状齐全", async () => {
    const { h, t } = await readyHarness("initiator-uid");
    t.emitDown({ t: "event", event: approvalRequestEvent(1) });
    expect(h.approvalRequests).toHaveLength(1);
    const req = h.approvalRequests[0]!;
    expect(req.sessionId).toBe("cloud-s1");
    expect(req.call).toEqual({ id: "call-1", name: "bash", args: { summary: "ls -la" } });
    expect(req.availableDecisions).toEqual(["approve", "deny"]);
    // 原始事件依然照常转发给渲染层（approval 特殊处理是"额外"不是"代替"）
    expect(h.events).toHaveLength(1);
  });

  it("selfUid === ownerUid（不是发起人）→ 也进 onApprovalRequest 回调", async () => {
    const { h, t } = await readyHarness("owner-uid");
    t.emitDown({ t: "event", event: approvalRequestEvent(1) });
    expect(h.approvalRequests).toHaveLength(1);
  });

  it("selfUid 既不是 initiator 也不是 owner → 不进 onApprovalRequest（但事件仍转发）", async () => {
    const { h, t } = await readyHarness("bystander-uid");
    t.emitDown({ t: "event", event: approvalRequestEvent(1) });
    expect(h.approvalRequests).toHaveLength(0);
    expect(h.events).toHaveLength(1);
  });

  it("approval_decision 事件 → 进 onApprovalDecision 回调", async () => {
    const { h, t } = await readyHarness("bystander-uid");
    const decision: ApprovalDecisionEvent = {
      type: "approval_decision", sessionId: "cloud-s1", seq: 1, ts: 2, toolCallId: "call-1", decision: "approved",
    };
    t.emitDown({ t: "event", event: decision });
    expect(h.approvalDecisions).toHaveLength(1);
    expect(h.approvalDecisions[0]).toEqual(decision);
  });
});

describe("createCloudSessionClient — denied 状态透传", () => {
  it("hello 被拒 → 推 denied 状态 + 原始 code，关闭连接", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();

    t.emitDown({ t: "denied", code: "not_member" });

    const last = h.statuses[h.statuses.length - 1]!;
    expect(last.state).toBe("denied");
    expect(last.deniedCode).toBe("not_member");
    expect(t.close).toHaveBeenCalledTimes(1);
  });
});

describe("createCloudSessionClient — :gone / 重连 / pendingApprovals 清理", () => {
  it(":gone → 状态 gone，不影响 currentSessionId（不清会话本身），但会通知装配方清 pendingApprovals", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: null, ownerUid: "u2" });
    t.emitDown({ t: "backlog", events: [], done: true });

    t.emitGone();

    const last = h.statuses[h.statuses.length - 1]!;
    expect(last.state).toBe("gone");
    expect(h.client.currentSessionId()).toBe("cloud-s1"); // 复审 P0 修复后：这条会话还在，只是不再产出虚拟 fleet 行
    expect(h.inactiveSessionIds).toEqual(["cloud-s1"]); // 复审 Medium
  });

  it("gone 时清空 pendingApprovals 之后，重连成功且该 approval_request 仍在 backlog 里 → 重新进 onApprovalRequest（重新挂回去）", async () => {
    const h = harness();
    h.state.uid = "initiator-uid";
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: "initiator-uid", ownerUid: "owner-uid" });
    t.emitDown({ t: "backlog", events: [approvalRequestEvent(0)], done: true });
    expect(h.approvalRequests).toHaveLength(1);

    t.emitGone();
    expect(h.inactiveSessionIds).toEqual(["cloud-s1"]);

    // host 回来，同一个 approval_request（还没被任何人决定）原样再拉一遍
    t.emitPeer("host-cid-2");
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: "initiator-uid", ownerUid: "owner-uid" }, "host-cid-2");
    t.emitDown({ t: "backlog", events: [approvalRequestEvent(0)], done: true }, "host-cid-2");

    expect(h.approvalRequests).toHaveLength(2); // 重新挂回去了，不是永久消失
  });

  it("gone 之后 host 回来：重新走 hello→welcome，seenSeqs 已清空，同一批事件原样再转发一次（渲染层自己按 seq 去重，重复无害）", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: null, ownerUid: "u2" });
    t.emitDown({ t: "backlog", events: [chatMsg(0)], done: true });
    expect(h.events).toHaveLength(1);

    t.emitGone();
    expect(h.statuses[h.statuses.length - 1]!.state).toBe("gone");

    // host 回来了：新一轮 hello
    t.emitPeer("host-cid-2");
    await tick();
    expect(h.statuses[h.statuses.length - 1]!.state).toBe("connecting");
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: null, ownerUid: "u2" }, "host-cid-2");
    t.emitDown({ t: "backlog", events: [chatMsg(0)], done: true }, "host-cid-2");

    expect(h.events).toHaveLength(2); // seenSeqs 已被 gone 清空，这次原样再送一次
    expect(h.statuses[h.statuses.length - 1]!.state).toBe("ready");
  });
});

describe("createCloudSessionClient — join 互斥 / leave", () => {
  it("再次 join 先断旧连接，并通知装配方清旧会话的 pendingApprovals", async () => {
    const h = harness();
    await h.client.join("w1", "s-old");
    const oldTransport = h.transports[0]!;

    await h.client.join("w1", "s-new");

    expect(oldTransport.close).toHaveBeenCalledTimes(1);
    expect(h.client.currentSessionId()).toBe("s-new");
    expect(h.transports).toHaveLength(2);
    expect(h.inactiveSessionIds).toEqual(["s-old"]); // 复审 Medium："切会话"路径
  });

  it("旧连接收到的迟到帧不再影响状态（陈旧回调防御）", async () => {
    const h = harness();
    await h.client.join("w1", "s-old");
    const oldTransport = h.transports[0]!;
    await h.client.join("w1", "s-new");
    h.statuses.length = 0; // 只看接下来这一步

    oldTransport.emitPeer(); // 旧连接的对端在场信号迟到
    await tick();

    expect(h.statuses).toHaveLength(0); // 没有为旧会话产生新的状态推送
    expect(h.client.currentSessionId()).toBe("s-new");
  });

  it("leave 关闭连接、清空 currentSessionId，并通知装配方清 pendingApprovals", async () => {
    const h = harness();
    await h.client.join("w1", "s1");
    const t = h.transports[0]!;

    const r = await h.client.leave();

    expect(r).toEqual({ ok: true, value: null });
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(h.client.currentSessionId()).toBeNull();
    expect(h.inactiveSessionIds).toEqual(["s1"]); // 复审 Medium
  });

  it("没有登录时 join 直接回 NOT_SIGNED_IN，不开连接", async () => {
    const h = harness();
    h.state.uid = null;
    const r = await h.client.join("w1", "s1");
    expect(r).toEqual({ ok: false, message: "还没登录" });
    expect(h.transports).toHaveLength(0);
  });
});

describe("createCloudSessionClient — say/approve/archive/config 就绪闸", () => {
  async function ready() {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: "u1", ownerUid: "u2" });
    t.emitDown({ t: "backlog", events: [], done: true });
    return { h, t };
  }

  it("没有 join 过：say/approve/archive/config 一律失败", async () => {
    const h = harness();
    expect(await h.client.say("hi", false)).toEqual({ ok: false, message: "没有已连接的云会话" });
    expect(await h.client.approve("c1", "approved")).toEqual({ ok: false, message: "没有已连接的云会话" });
    expect(await h.client.archive()).toEqual({ ok: false, message: "没有已连接的云会话" });
    expect(await h.client.config("w1", "https://x")).toEqual({ ok: false, message: "没有已连接的云会话" });
  });

  it("还在 connecting（welcome 之前）：一律未就绪失败", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const r = await h.client.say("hi", false);
    expect(r).toEqual({ ok: false, message: "云会话未就绪" });
  });

  it("ready 之后：say 发出去的帧形状正确，地址是 host cid", async () => {
    const { h, t } = await ready();
    const r = await h.client.say("@Agent 干活", true);
    expect(r).toEqual({ ok: true, value: null });
    const last = t.decoded()[t.decoded().length - 1];
    expect(last).toEqual({ t: "say", text: "@Agent 干活", mention: true });
    expect(t.sent[t.sent.length - 1]!.to).toBe(HOST_CID);
  });

  it("ready 之后：approve 发出去的帧带 callId + decision", async () => {
    const { h, t } = await ready();
    await h.client.approve("call-9", "denied");
    const last = t.decoded()[t.decoded().length - 1];
    expect(last).toEqual({ t: "approve", callId: "call-9", decision: "denied" });
  });

  it("ready 之后：archive 发出去一个 archive 帧", async () => {
    const { h, t } = await ready();
    await h.client.archive();
    const last = t.decoded()[t.decoded().length - 1];
    expect(last).toEqual({ t: "archive" });
  });

  it("config：workspaceId 与当前会话不一致时拒绝", async () => {
    const { h } = await ready();
    const r = await h.client.config("other-workspace", "https://example.com/repo.git");
    expect(r).toEqual({ ok: false, message: "未加入该工作区的云会话" });
  });

  it("config：workspaceId 匹配时正常发送，pat 省略时帧里不带 pat", async () => {
    const { h, t } = await ready();
    await h.client.config("w1", "https://example.com/repo.git");
    const last = t.decoded()[t.decoded().length - 1];
    expect(last).toEqual({ t: "config", repoUrl: "https://example.com/repo.git" });
    expect(last && "pat" in last).toBe(false);
  });

  it("say.text 超 64KiB：encodeCs 抛错被 client 接住，回 ok:false 而不是抛出", async () => {
    const { h } = await ready();
    const r = await h.client.say("x".repeat(65 * 1024), false);
    expect(r.ok).toBe(false);
  });
});

describe("createCloudSessionClient — create", () => {
  it("created 帧到达 → resolve sessionId，并关闭控制房连接", async () => {
    const h = harness();
    const promise = h.client.create("w1");
    // create() 顶部先 await accessToken，等它落地再拿 transport
    await tick();
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();

    expect(t.decoded()).toEqual([
      { t: "hello", v: 1, jwt: "token-abc" },
      { t: "create", workspaceId: "w1" },
    ]);

    t.emitDown({ t: "created", workspaceId: "w1", sessionId: "new-session-id", channel: "cs-w1-new-session-id" });
    const r = await promise;
    expect(r).toEqual({ ok: true, value: { sessionId: "new-session-id" } });
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it("denied 帧到达 → resolve ok:false", async () => {
    const h = harness();
    const promise = h.client.create("w1");
    await tick();
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "denied", code: "not_member" });
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it("没有登录时直接回 NOT_SIGNED_IN，不开连接", async () => {
    const h = harness();
    h.state.token = null;
    const r = await h.client.create("w1");
    expect(r).toEqual({ ok: false, message: "还没登录" });
    expect(h.transports).toHaveLength(0);
  });
});

describe("createCloudSessionClient — activeSummary()", () => {
  it("没有 join 过 = null；join 之后带上 workspaceId/sessionId/status", async () => {
    const h = harness();
    expect(h.client.activeSummary()).toBeNull();
    await h.client.join("w1", "cloud-s1");
    expect(h.client.activeSummary()).toEqual({ workspaceId: "w1", sessionId: "cloud-s1", status: "connecting" });
  });

  it("leave 之后回到 null", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    await h.client.leave();
    expect(h.client.activeSummary()).toBeNull();
  });
});

// ─── 复审 P0：云会话必须能上原生岛/手机 fleet ──────────────────────────────
// flattenFleet 只遍历它拿到的 sessions 参数、从不反向遍历 islandStates 的
// key——云会话从不 store.append，天生不在本地 sessions 列表里。不补一条虚拟
// SessionSummary 进 sessions 参数，approval_request 命中 self 可批时算好的
// IslandState（含 pendingApproval）永远够不到 flattenFleet 的输出，审批横幅
// 在原生岛/手机上静默不出现。cloudSessionFleetRow 是这个洞的补丁：纯函数，
// index.ts 的 pushFleet 拿它的结果并进真实会话列表一起喂给 flattenFleet。
describe("cloudSessionFleetRow — 复审 P0：云会话上岛", () => {
  it("null，或 connecting/denied/gone 状态：不产出虚拟行", () => {
    expect(cloudSessionFleetRow(null)).toBeNull();
    const statuses: CloudSessionSummary["status"][] = ["connecting", "denied", "gone"];
    for (const status of statuses) {
      expect(cloudSessionFleetRow({ workspaceId: "w1", sessionId: "cloud-s1", status })).toBeNull();
    }
  });

  it("ready：产出一条合成 SessionSummary——sessionId 对得上、workspace 是绝对路径、不是子会话、不是归档", () => {
    const row = cloudSessionFleetRow({ workspaceId: "w1", sessionId: "cloud-s1", status: "ready" });
    expect(row).not.toBeNull();
    expect(row!.sessionId).toBe("cloud-s1");
    expect(row!.workspace).not.toBeNull();
    // 必须是绝对路径：相对片段会被 path.resolve 拼上 process.cwd()，在 dev
    // checkout 这样的环境里可能意外爬进真实项目的 .git（见文件内那段注释）
    expect(row!.workspace!.startsWith("/")).toBe(true);
    expect(row!.spawnedFrom).toBeNull();
    expect(row!.archived).toBe(false);
  });

  it("不同 workspaceId 产出不同的 workspace 分组键（不会把两个不同工作区的云会话混进同一组）", () => {
    const a = cloudSessionFleetRow({ workspaceId: "w1", sessionId: "s-a", status: "ready" })!;
    const b = cloudSessionFleetRow({ workspaceId: "w2", sessionId: "s-b", status: "ready" })!;
    expect(a.workspace).not.toBe(b.workspace);
  });

  it("与真实 flattenFleet 拼接：ready 的云会话 + islandStates 里的 pendingApproval 一起喂进去，输出里能找到它且带 pendingApproval", () => {
    // 不碰真文件系统：reader 一律回"什么都没有"，等价于这条合成路径一路
    // 找不到 .git，回落到"就地当根"——这正是生产环境里对一个没有真实
    // 对应目录的合成路径会发生的事
    const noFs = { exists: () => false, readFile: () => null };
    const lens = createWorkspaceLens({ reader: noFs });

    const cloudRow = cloudSessionFleetRow({ workspaceId: "w1", sessionId: "cloud-s1", status: "ready" })!;
    const approval: ApprovalRequest = {
      sessionId: "cloud-s1",
      call: { id: "call-1", name: "bash", args: { summary: "ls -la" } },
      toolDescription: "ls -la",
      availableDecisions: ["approve", "deny"],
    };
    const islandStates = new Map<string, IslandState>([
      ["cloud-s1", { ...initialIsland, sessionId: "cloud-s1", phase: "approval", pendingApproval: approval }],
    ]);

    const fleet = flattenFleet(islandStates, [cloudRow], null, lens);

    const agent = fleet.agents.find((a) => a.sessionId === "cloud-s1");
    expect(agent).toBeDefined();
    expect(agent!.pendingApproval).not.toBeNull();
    expect(agent!.pendingApproval!.callId).toBe("call-1");
  });

  it("云会话不是 ready（比如 gone）：cloudSessionFleetRow 不产出行，flattenFleet 的 sessions 参数里也就没有它——即使 islandStates 里还留着 pendingApproval，也不会出现在 fleet 输出里", () => {
    const noFs = { exists: () => false, readFile: () => null };
    const lens = createWorkspaceLens({ reader: noFs });

    const goneRow = cloudSessionFleetRow({ workspaceId: "w1", sessionId: "cloud-s1", status: "gone" });
    expect(goneRow).toBeNull();

    const approval: ApprovalRequest = {
      sessionId: "cloud-s1",
      call: { id: "call-1", name: "bash", args: {} },
      toolDescription: "ls -la",
    };
    const islandStates = new Map<string, IslandState>([
      ["cloud-s1", { ...initialIsland, sessionId: "cloud-s1", phase: "approval", pendingApproval: approval }],
    ]);
    // 装配方（index.ts 的 pushFleet）在 cloud 为 null 时不会把它拼进 sessions——
    // 这里直接模拟那个决定：sessions 数组里没有这条云会话
    const fleet = flattenFleet(islandStates, [], null, lens);

    expect(fleet.agents.find((a) => a.sessionId === "cloud-s1")).toBeUndefined();
  });
});
