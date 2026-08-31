import { describe, expect, it, vi } from "vitest";
import { createCloudSessionClient, type CloudSessionClientDeps } from "../../src/main/cloudSessionClient.js";
import { decodeCsUp, encodeCs, type CsDown, type CsUp } from "../../src/shared/remote/cloudSession.js";
import type { RemoteTransport } from "../../src/shared/remote/transport.js";
import type { ApprovalDecisionEvent, ChatMessageEvent, SessionEvent } from "../../src/session/events.js";
import type { ApprovalRequest, CloudSessionStatus } from "../../src/shared/shellBridge.js";

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
    ...overrides,
  };

  const client = createCloudSessionClient(deps);
  return { client, transports, events, statuses, approvalRequests, approvalDecisions, state };
}

function chatMsg(seq: number, sessionId = "cloud-s1"): ChatMessageEvent {
  return { type: "chat_message", sessionId, seq, ts: 1000 + seq, fromUid: "u9", label: "Bob", content: `msg ${seq}`, mention: false };
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

  it("直播 event 与 backlog 重叠的事件只转发一份（按 seq 去重），backlog done 才置 ready", async () => {
    const h = harness();
    await h.client.join("w1", "cloud-s1");
    const t = h.transports[0]!;
    t.emitPeer();
    await tick();
    t.emitDown({ t: "welcome", v: 1, sessionId: "cloud-s1", lastSeq: 1, initiatorUid: "u1", ownerUid: "u2" });

    // 直播先到一条 seq:0
    t.emitDown({ t: "event", event: chatMsg(0) });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toEqual(chatMsg(0));

    // backlog 带回同一条 seq:0（重叠）+ 一条新的 seq:1，done:true
    t.emitDown({ t: "backlog", events: [chatMsg(0), chatMsg(1)], done: true });

    expect(h.events).toHaveLength(2); // 不是 3——seq:0 没有被重复转发
    expect(h.events.map((e) => e.seq)).toEqual([0, 1]);

    const last = h.statuses[h.statuses.length - 1]!;
    expect(last.state).toBe("ready");
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
    return { h, t };
  }

  it("selfUid === initiatorUid → 进 onApprovalRequest 回调，形状齐全", async () => {
    const { h, t } = await readyHarness("initiator-uid");
    t.emitDown({
      t: "event",
      event: { type: "approval_request", sessionId: "cloud-s1", seq: 0, ts: 1, callId: "call-1", toolName: "bash", argsSummary: "ls -la", initiatorUid: "initiator-uid", expiresTs: 9999 },
    });
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
    t.emitDown({
      t: "event",
      event: { type: "approval_request", sessionId: "cloud-s1", seq: 0, ts: 1, callId: "call-1", toolName: "bash", argsSummary: "ls -la", initiatorUid: "initiator-uid", expiresTs: 9999 },
    });
    expect(h.approvalRequests).toHaveLength(1);
  });

  it("selfUid 既不是 initiator 也不是 owner → 不进 onApprovalRequest（但事件仍转发）", async () => {
    const { h, t } = await readyHarness("bystander-uid");
    t.emitDown({
      t: "event",
      event: { type: "approval_request", sessionId: "cloud-s1", seq: 0, ts: 1, callId: "call-1", toolName: "bash", argsSummary: "ls -la", initiatorUid: "initiator-uid", expiresTs: 9999 },
    });
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

describe("createCloudSessionClient — :gone / 重连", () => {
  it(":gone → 状态 gone，不影响 currentSessionId（不清会话本身）", async () => {
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
    expect(h.client.currentSessionId()).toBe("cloud-s1");
  });

  it("gone 之后 host 回来：重新走 hello→welcome，已见过的 seq 不重复转发", async () => {
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
    // 全量 backlog 重新拉回同一批（seq:0 重复），去重表还在，不重复转发
    t.emitDown({ t: "backlog", events: [chatMsg(0)], done: true }, "host-cid-2");

    expect(h.events).toHaveLength(1); // 还是 1 条，不是 2
    expect(h.statuses[h.statuses.length - 1]!.state).toBe("ready");
  });
});

describe("createCloudSessionClient — join 互斥 / leave", () => {
  it("再次 join 先断旧连接", async () => {
    const h = harness();
    await h.client.join("w1", "s-old");
    const oldTransport = h.transports[0]!;

    await h.client.join("w1", "s-new");

    expect(oldTransport.close).toHaveBeenCalledTimes(1);
    expect(h.client.currentSessionId()).toBe("s-new");
    expect(h.transports).toHaveLength(2);
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

  it("leave 关闭连接并清空 currentSessionId", async () => {
    const h = harness();
    await h.client.join("w1", "s1");
    const t = h.transports[0]!;

    const r = await h.client.leave();

    expect(r).toEqual({ ok: true, value: null });
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(h.client.currentSessionId()).toBeNull();
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
