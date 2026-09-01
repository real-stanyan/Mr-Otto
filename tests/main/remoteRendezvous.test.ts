import { describe, expect, it } from "vitest";
import { createRemoteBridge, type RemoteTransport } from "../../src/main/remoteBridge.js";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";
import { b64decode } from "../../src/shared/remote/b64.js";
import {
  buildHello, deriveSession, newConnectionParty,
  type HandshakeHello, type Role, type SelfParty,
} from "../../src/shared/remote/handshake.js";
import { createOpener } from "../../src/shared/remote/sealedStream.js";
import type { IslandFleet } from "../../src/shared/shellBridge.js";

// 这一组测的是**会合**(rendezvous),不是加密。
//
// 握手是双向的:两端都要拿到对方的 hello 才能派生会话密钥。而中继按设计不排队
// (relay.ts 不变量 2:对端不在线就整帧丢弃,排队等于落盘),桌面又是长命的那一端,
// 手机是几小时后才连上来的那一端 —— 桌面盲发的 hello 必然掉进虚空。
// 所以由中继在对端 attach 时往两侧各写一条 `:peer`,两边同时开一轮。
//
// remoteBridge.test.ts 用的 fakeTransport 是一个永不丢包的数组,
// 于是"那条 hello 掉了"这件事在那边永远不会发生。这个文件补的就是那一半。

const P = nodeRemoteCrypto();
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

const BUSY: IslandFleet = {
  agents: [{
    sessionId: "s1", title: "t", phase: "active", currentTool: null,
    turnStartedAt: 1, pendingApproval: null, workspace: "/w",
  }],
  focusedSessionId: "s1",
};

/** services/edge/src/relay.ts 的行为模型:一户两槽、不排队、attach 时两侧各发一条在场信号。
    投递走一条 FIFO 队列而不是同步调用 —— 真中继两条 `:peer` 是先**写进**两条 SSE 流的,
    任何一端的 hello 都不可能抢在对端读到自己那条信号之前到达。同步模型会凭空造出
    一个现实里不存在的竞态(新来的那端先发 hello,而在位的那端还没开始这一轮)。 */
/** 两端各一条连接时中继给的 cid(ADR-0130)。这个 harness 只模两条 */
const CID: Record<Role, string> = { desktop: "cd", mobile: "cm", host: "ch", guest: "cg" };

function fakeRelay() {
  const sink: Record<Role, ((p: string, from: string) => void) | null> =
    { desktop: null, mobile: null, host: null, guest: null };
  const peerCb: Record<Role, ((cid: string) => void) | null> = { desktop: null, mobile: null, host: null, guest: null };
  const dropped: string[] = [];
  const queue: Array<() => void> = [];
  const peerOf = (r: Role): Role => (r === "desktop" ? "mobile" : "desktop");

  const flush = (): void => {
    while (queue.length > 0) queue.shift()!();
  };

  return {
    dropped,
    attach(role: Role, onMsg: (p: string, from: string) => void, onPeer: (cid: string) => void) {
      sink[role] = onMsg;
      peerCb[role] = onPeer;
      if (sink[peerOf(role)]) {
        queue.push(() => onPeer(CID[peerOf(role)]));             // 新来的这端
        queue.push(() => peerCb[peerOf(role)]!(CID[role]));      // 在位的那端
      }
      flush();
    },
    send(from: Role, payload: string): boolean {
      const peer = sink[peerOf(from)];
      if (!peer) { dropped.push(payload); return false; }
      queue.push(() => peer(payload, CID[from]));
      return true;
    },
  };
}

function desktopTransport(relay: ReturnType<typeof fakeRelay>): RemoteTransport {
  let onMsg: (p: string, from: string) => void = () => {};
  let onPeer: (cid: string) => void = () => {};
  relay.attach("desktop", (p, from) => onMsg(p, from), (cid) => onPeer(cid));
  return {
    send(p) { relay.send("desktop", p); return true; },
    onMessage(cb) { onMsg = cb; },
    onPeer(cb) { onPeer = cb; },
    onGone() { /* 这一组不测对端离场 */ },
    onClose() { /* 这一组不测自身断线 */ },
    /** 桥不该调它(重连时机归调用方,见 RemoteTransport 合同) */
    reconnectNow() {},
    close() { /* 同上 */ },
  };
}

/** 手机那一端的最小实现:收到在场信号就发 hello,收到桌面 hello 就派生。
    整轮握手在 attach 里同步跑完,所以 pin 住的桌面公钥必须在构造时就交进来 */
function fakePhone(
  relay: ReturnType<typeof fakeRelay>,
  identity: ReturnType<typeof P.generateEd25519>,
  desktopPub: Uint8Array
) {
  const frames: string[] = [];
  let self: SelfParty | null = null;
  let opener: ReturnType<typeof createOpener> | null = null;
  const opened: string[] = [];

  relay.attach(
    "mobile",
    (p) => {
      if (!p.startsWith("{")) {
        frames.push(p);
        const plain = opener?.open(b64decode(p)!);
        if (plain) opened.push(dec(plain));
        return;
      }
      if (!self) return;
      const keys = deriveSession(P, {
        self, peerHello: JSON.parse(p) as HandshakeHello, peerIdentityPub: desktopPub,
      });
      if (keys) opener = createOpener(P, keys.recv.key, keys.recv.prefix);
    },
    () => {
      self = newConnectionParty(P, { role: "mobile", deviceId: "m1", identity });
      opener = null;
      relay.send("mobile", JSON.stringify(buildHello(P, self)));
    }
  );

  return { frames, opened };
}

describe("远程握手的会合", () => {
  it("桌面先在线、手机后连:两端在同一轮里各拿到对方的 hello,快照解得开", () => {
    const relay = fakeRelay();
    const desktopIdentity = P.generateEd25519();
    const phoneIdentity = P.generateEd25519();

    // 桌面上线时手机还没连 —— 它什么都不该发(发了也是被丢)
    const bridge = createRemoteBridge({
      crypto: P,
      identity: desktopIdentity,
      deviceId: "d1",
      transport: desktopTransport(relay),
      onCommand: () => {},
      peerIdentities: () => [phoneIdentity.publicKey],
    });
    expect(relay.dropped).toHaveLength(0);
    bridge.pushFleet(BUSY);
    expect(relay.dropped).toHaveLength(0); // 也不该盲推快照

    // 手机后到:中继给两侧发在场信号,一轮握手就地完成
    const phone = fakePhone(relay, phoneIdentity, desktopIdentity.publicKey);
    expect(phone.opened).toHaveLength(1);
    expect(JSON.parse(phone.opened[0]!)).toEqual({ type: "fleet", fleet: BUSY });
  });

  it("手机切后台再回来:桌面自己没断线,也必须换新密钥重开一轮（否则永久失联）", () => {
    const relay = fakeRelay();
    const desktopIdentity = P.generateEd25519();
    const phoneIdentity = P.generateEd25519();

    const bridge = createRemoteBridge({
      crypto: P, identity: desktopIdentity, deviceId: "d1",
      transport: desktopTransport(relay),
      onCommand: () => {},
      peerIdentities: () => [phoneIdentity.publicKey],
    });
    bridge.pushFleet(BUSY);

    const first = fakePhone(relay, phoneIdentity, desktopIdentity.publicKey);
    expect(first.opened).toHaveLength(1);

    // 同一台手机、新一次连接。桌面这一侧的 SSE 从头到尾没断过,
    // 没有 onClose 可依赖 —— 全靠中继重发的那条在场信号
    const again = fakePhone(relay, phoneIdentity, desktopIdentity.publicKey);
    expect(again.opened, "手机重连后拿不到快照 = 桌面停在旧密钥上").toHaveLength(1);
    expect(JSON.parse(again.opened[0]!)).toEqual({ type: "fleet", fleet: BUSY });
  });
});
