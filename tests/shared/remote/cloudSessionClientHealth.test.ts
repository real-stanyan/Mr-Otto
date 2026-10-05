import { describe, expect, it, vi } from "vitest";
import {
  createCloudSessionClient,
  type CloudSessionClientDeps,
} from "../../../src/shared/remote/cloudSessionClient.js";
import { decodeCsUp, encodeCs, type CsDown, type CsUp, CS_PROTOCOL_VERSION } from "../../../src/shared/remote/cloudSession.js";
import type { RemoteTransport } from "../../../src/shared/remote/transport.js";
import type { SessionEvent } from "../../../src/session/events.js";
import type { ApprovalRequest, CloudSessionStatus } from "../../../src/shared/shellBridge.js";
import type { ApprovalDecisionEvent } from "../../../src/session/events.js";

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
  // issue #829：真 wsTransport 的 send 有四条不抛异常的丢帧路径（连接关了 /
  // 没有收件人 / socket 还没 open，含正在自动重连的窗口 / sock.send 抛错）。
  // 假传输默认"发得出去"，测试用 dropFrames() 切到那一侧
  let sendOk = true;
  return {
    sent,
    send(p: string, to: string) {
      if (!sendOk) return false; // 丢帧路径不记进 sent：真传输那几条也是发都没发
      sent.push({ payload: p, to });
      return true;
    },
    /** 之后的每一次 send 都丢帧并回 false */
    dropFrames() {
      sendOk = false;
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
  const deltas: { sessionId: string; agentId: string; kind: "content" | "reasoning"; text: string }[] = [];
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
    sendDelta: (d) => deltas.push(d),
    sendStatus: (s) => statuses.push(s),
    onApprovalRequest: (r) => approvalRequests.push(r),
    onApprovalDecision: (e) => approvalDecisions.push(e),
    onSessionInactive: (id) => inactiveSessionIds.push(id),
    ...overrides,
  };

  const client = createCloudSessionClient(deps);
  return {
    client, transports, events, deltas, statuses, approvalRequests, approvalDecisions, inactiveSessionIds, state,
  };
}

const WELCOME: CsDown = { t: "welcome", v: CS_PROTOCOL_VERSION, sessionId: "cloud-s1", lastSeq: -1, initiatorUid: null, ownerUid: "owner", modelRoute: null };

async function ready(h: ReturnType<typeof harness>) {
  await h.client.join("w1", "cloud-s1");
  const t = h.transports[0]!;
  t.emitPeer();
  await tick();
  t.emitDown(WELCOME);
  await tick();
  return t;
}

describe("Apple 健康（#1656）", () => {
  it("welcome 之后发一次 caps", async () => {
    const h = harness({ deviceCaps: () => ({ health: true }) });
    const t = await ready(h);
    expect(t.decoded()).toContainEqual({ t: "caps", health: true });
  });
  it("没给 deviceCaps（桌面）：不发 caps", async () => {
    const h = harness();
    const t = await ready(h);
    expect(t.decoded().some((m) => m?.t === "caps")).toBe(false);
  });
  it("refreshCaps：welcome 之后才发；之前是空操作", async () => {
    let on = false;
    const h = harness({ deviceCaps: () => ({ health: on }) });
    h.client.refreshCaps(); // 还没 join
    const t = await ready(h);
    on = true;
    h.client.refreshCaps();
    expect(t.decoded().filter((m) => m?.t === "caps")).toEqual([{ t: "caps", health: false }, { t: "caps", health: true }]);
  });
  it("health_query → onHealthQuery → health_result 带同一个 reqId", async () => {
    const h = harness({ onHealthQuery: async () => ({ ok: true, days: [], workouts: [] }) });
    const t = await ready(h);
    t.emitDown({ t: "health_query", reqId: "r1", query: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } });
    await tick();
    expect(t.decoded()).toContainEqual({ t: "health_result", reqId: "r1", result: { ok: true, days: [], workouts: [] } });
  });
  it("没给 onHealthQuery：回 ok:false", async () => {
    const h = harness();
    const t = await ready(h);
    t.emitDown({ t: "health_query", reqId: "r1", query: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } });
    await tick();
    expect(t.decoded()).toContainEqual({ t: "health_result", reqId: "r1", result: { ok: false, error: "这台设备不读健康数据" } });
  });
  it("onHealthQuery 抛错：回 ok:false 带原话", async () => {
    const h = harness({ onHealthQuery: async () => { throw new Error("boom"); } });
    const t = await ready(h);
    t.emitDown({ t: "health_query", reqId: "r1", query: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } });
    await tick();
    expect(t.decoded()).toContainEqual({ t: "health_result", reqId: "r1", result: { ok: false, error: "boom" } });
  });
});
