import { describe, expect, it, vi } from "vitest";
import { createRemoteBridge } from "../../../src/main/remoteBridge.js";
import { nodeRemoteCrypto } from "../../../src/main/remoteCryptoNode.js";
import { nobleRemoteCrypto } from "../../../src/shared/remote/nobleCrypto.js";
import { createMobileBridge } from "../../../src/shared/remote/mobileBridge.js";
import type { RemoteTransport } from "../../../src/shared/remote/transport.js";
import type { DownFrame, UpFrame } from "../../../src/shared/remote/frames.js";
import type { IslandFleet } from "../../../src/shared/shellBridge.js";
import type { Role } from "../../../src/shared/remote/handshake.js";

// 这个文件把**两个真桥**对接起来:桌面那只用 node:crypto,手机这只用 @noble/*,
// 中间是一个会丢包、按 FIFO 投递、attach 时发 :peer 的中继模型
// (services/gateway/src/relay.ts 的行为)。
//
// 分开测两边各自"能跑"没有意义:这条链路的失败方式是"连上了、解不开"。

const N = nodeRemoteCrypto();
const B = nobleRemoteCrypto();

const BUSY: IslandFleet = {
  agents: [{
    sessionId: "s1", title: "抓一下门禁为什么红", phase: "approval",
    currentTool: { verb: "运行", target: "rm -rf build" }, turnStartedAt: 1,
    pendingApproval: { callId: "c1", verb: "运行", target: "rm -rf build", fullPath: "/w/build" },
    workspace: "/w",
  }],
  focusedSessionId: "s1",
};

function fakeRelay() {
  const sink: Record<Role, ((p: string) => void) | null> = { desktop: null, mobile: null };
  const peerCb: Record<Role, (() => void) | null> = { desktop: null, mobile: null };
  const queue: Array<() => void> = [];
  const dropped: string[] = [];
  const peerOf = (r: Role): Role => (r === "desktop" ? "mobile" : "desktop");
  const flush = (): void => { while (queue.length > 0) queue.shift()!(); };
  return {
    dropped,
    transport(role: Role): RemoteTransport {
      let onMsg: (p: string) => void = () => {};
      let onPeer: () => void = () => {};
      let onClose: () => void = () => {};
      sink[role] = (p) => onMsg(p);
      peerCb[role] = () => onPeer();
      return {
        send(p) {
          const peer = sink[peerOf(role)];
          if (!peer) { dropped.push(p); return; }
          queue.push(() => peer(p));
          flush();
        },
        onMessage(cb) { onMsg = cb; },
        onPeer(cb) { onPeer = cb; },
        onClose(cb) { onClose = cb; },
        close() { onClose(); },
      };
    },
    /** 中继在两端都占上槽位时,往两侧各写一条 :peer(ADR-0100) */
    announce() {
      if (!sink.desktop || !sink.mobile) return;
      queue.push(() => peerCb.mobile?.());
      queue.push(() => peerCb.desktop?.());
      flush();
    },
  };
}

function pair() {
  const relay = fakeRelay();
  const desktopIdentity = N.generateEd25519();
  const phoneIdentity = B.generateEd25519();
  const frames: DownFrame[] = [];
  const commands: UpFrame[] = [];
  const ready: boolean[] = [];

  const desktop = createRemoteBridge({
    crypto: N, identity: desktopIdentity, deviceId: "d1",
    transport: relay.transport("desktop"),
    peerIdentity: () => phoneIdentity.publicKey,
    onCommand: (c) => commands.push(c),
  });
  const phone = createMobileBridge({
    crypto: B, identity: phoneIdentity, deviceId: "m1",
    transport: relay.transport("mobile"),
    peerIdentity: () => desktopIdentity.publicKey,
    onFrame: (f) => frames.push(f),
    onReady: (r) => ready.push(r),
  });
  return { relay, desktop, phone, frames, commands, ready, desktopIdentity, phoneIdentity };
}

describe("手机桥 ⇄ 桌面桥（真加密、会丢包的中继）", () => {
  it("在场信号之前谁都不发；之后一轮握手，快照原样到手机", () => {
    const { relay, desktop, phone, frames, ready } = pair();
    desktop.pushFleet(BUSY);
    expect(relay.dropped).toHaveLength(0); // 对端不在场时不盲发
    expect(ready).toEqual([]);

    relay.announce();
    expect(ready).toEqual([true]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ type: "fleet", fleet: BUSY });
    phone.dispose();
    desktop.dispose();
  });

  it("手机批一条：桌面收到的是同一个 callId，且没有 grant 档", () => {
    const { relay, desktop, phone, commands } = pair();
    desktop.pushFleet(BUSY);
    relay.announce();

    expect(phone.send({ type: "approve", sessionId: "s1", callId: "c1" })).toBe(true);
    expect(commands).toEqual([{ type: "approve", sessionId: "s1", callId: "c1" }]);
    expect(Object.keys(commands[0]!)).not.toContain("grant"); // ADR-0096
    phone.dispose();
    desktop.dispose();
  });

  it("会话没建立时 send 回 false —— 界面据此说“你的 Mac 不在线”，而不是假装发出去了", () => {
    const { phone, desktop } = pair();
    expect(phone.send({ type: "approve", sessionId: "s1", callId: "c1" })).toBe(false);
    phone.dispose();
    desktop.dispose();
  });

  it("没 pin 过电脑 → 拒绝握手，会话建立不起来", () => {
    const relay = fakeRelay();
    const desktopIdentity = N.generateEd25519();
    const phoneIdentity = B.generateEd25519();
    const ready: boolean[] = [];
    const log = vi.fn();
    const desktop = createRemoteBridge({
      crypto: N, identity: desktopIdentity, deviceId: "d1",
      transport: relay.transport("desktop"),
      peerIdentity: () => phoneIdentity.publicKey,
      onCommand: () => {},
    });
    const phone = createMobileBridge({
      crypto: B, identity: phoneIdentity, deviceId: "m1",
      transport: relay.transport("mobile"),
      peerIdentity: () => null, // 还没配对
      onFrame: () => {}, onReady: (r) => ready.push(r), log,
    });
    desktop.pushFleet(BUSY);
    relay.announce();
    expect(ready).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("还没配对"));
    phone.dispose();
    desktop.dispose();
  });

  it("pin 的是别人的公钥 → 验不过，不静默接受（TOFU 的执行面）", () => {
    const relay = fakeRelay();
    const desktopIdentity = N.generateEd25519();
    const phoneIdentity = B.generateEd25519();
    const ready: boolean[] = [];
    const log = vi.fn();
    const desktop = createRemoteBridge({
      crypto: N, identity: desktopIdentity, deviceId: "d1",
      transport: relay.transport("desktop"),
      peerIdentity: () => phoneIdentity.publicKey,
      onCommand: () => {},
    });
    const phone = createMobileBridge({
      crypto: B, identity: phoneIdentity, deviceId: "m1",
      transport: relay.transport("mobile"),
      peerIdentity: () => N.generateEd25519().publicKey, // 冒牌货
      onFrame: () => {}, onReady: (r) => ready.push(r), log,
    });
    desktop.pushFleet(BUSY);
    relay.announce();
    expect(ready).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("验不过"));
    phone.dispose();
    desktop.dispose();
  });

  it("手机重连（新的一轮）：桌面没断线也重新握手，快照补推得到", () => {
    const { relay, desktop, phone, frames, ready } = pair();
    desktop.pushFleet(BUSY);
    relay.announce();
    expect(frames).toHaveLength(1);

    // 中继在同角色重连时也发 :peer —— 两端各换一套新鲜临时密钥重来
    relay.announce();
    expect(ready).toEqual([true, false, true]);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ type: "fleet", fleet: BUSY });
    phone.dispose();
    desktop.dispose();
  });
});
