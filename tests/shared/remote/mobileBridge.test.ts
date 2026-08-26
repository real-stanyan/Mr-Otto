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
// (services/edge/src/relay.ts 的行为)。
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

const IDLE: IslandFleet = {
  agents: [{
    sessionId: "s1", title: "抓一下门禁为什么红", phase: "idle",
    currentTool: null, turnStartedAt: 0, pendingApproval: null, workspace: "/w",
  }],
  focusedSessionId: "s1",
};

/** 两端各一条连接时中继给的 cid(ADR-0130)。这个 harness 只模两条 */
const CID: Record<Role, string> = { desktop: "cd", mobile: "cm" };

function fakeRelay() {
  const sink: Record<Role, ((p: string, from: string) => void) | null> =
    { desktop: null, mobile: null };
  const peerCb: Record<Role, ((cid: string) => void) | null> = { desktop: null, mobile: null };
  const queue: Array<() => void> = [];
  const dropped: string[] = [];
  const peerOf = (r: Role): Role => (r === "desktop" ? "mobile" : "desktop");
  const flush = (): void => { while (queue.length > 0) queue.shift()!(); };
  return {
    dropped,
    transport(role: Role): RemoteTransport {
      let onMsg: (p: string, from: string) => void = () => {};
      let onPeer: (cid: string) => void = () => {};
      let onGone: (cid: string) => void = () => {};
      let onClose: () => void = () => {};
      sink[role] = (p, from) => onMsg(p, from);
      peerCb[role] = (cid) => onPeer(cid);
      return {
        send(p) {
          // 这个 harness 一边只有一条连接,所以 to 一定指向对面那条,不用查表
          const peer = sink[peerOf(role)];
          if (!peer) { dropped.push(p); return; }
          queue.push(() => peer(p, CID[role]));
          flush();
        },
        onMessage(cb) { onMsg = cb; },
        onPeer(cb) { onPeer = cb; },
        onGone(cb) { onGone = cb; },
        onClose(cb) { onClose = cb; },
        close() { onClose(); void onGone; },
      };
    },
    /**
     * 中继在两端都占上槽位时,往两侧各写一条 :peer(ADR-0100)。
     * `only` = 只有那一侧真的收到 —— 手机重连时另一条 :peer 写给了正在被拆掉的
     * 旧连接,是真实中继下最常见的一种不对称,不是人为刁难。
     */
    announce(only?: Role) {
      if (!sink.desktop || !sink.mobile) return;
      if (only !== "desktop") queue.push(() => peerCb.mobile?.(CID.desktop));
      if (only !== "mobile") queue.push(() => peerCb.desktop?.(CID.mobile));
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
    peerIdentities: () => [phoneIdentity.publicKey],
    onCommand: (c) => commands.push(c),
  });
  const phone = createMobileBridge({
    crypto: B, identity: phoneIdentity, deviceId: "m1",
    transport: relay.transport("mobile"),
    peerIdentities: () => [desktopIdentity.publicKey],
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
      peerIdentities: () => [phoneIdentity.publicKey],
      onCommand: () => {},
    });
    const phone = createMobileBridge({
      crypto: B, identity: phoneIdentity, deviceId: "m1",
      transport: relay.transport("mobile"),
      peerIdentities: () => [], // 还没配对
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
      peerIdentities: () => [phoneIdentity.publicKey],
      onCommand: () => {},
    });
    const phone = createMobileBridge({
      crypto: B, identity: phoneIdentity, deviceId: "m1",
      transport: relay.transport("mobile"),
      peerIdentities: () => [N.generateEd25519().publicKey], // 冒牌货
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

  // 这一条钉的是真机上那屏"没等到时间线 + 一串帧解密失败"的成因。
  //
  // relay.attach 在**任何一端接上时都给两边各写一条 :peer**。手机重连一次,
  // 桌面就实打实收到一条并重开一轮;而手机自己那条写给了正在被拆掉的旧连接,
  // 收不到。于是桌面开了两轮、手机只开了一轮。老实现"只认第一条 hello",
  // 两端就此锁死在错配的一对上:都自认为 ready,每一帧都解不开,而且没有出口
  // ——不再有 :peer 就不再有新的一轮。
  it("在场信号一边多一边少 → 两端仍然收敛（老实现在这里死锁：都 ready，却谁也解不开谁）", () => {
    const { relay, desktop, phone, frames, commands } = pair();
    desktop.pushFleet(BUSY);
    relay.announce();
    expect(frames).toHaveLength(1);

    // 手机重连两次,每次只有桌面听见;中间夹一次两边都听见的
    relay.announce("desktop");
    relay.announce();
    relay.announce("desktop");

    // 下行:桌面推的新快照,手机解得开
    desktop.pushFleet(IDLE);
    expect(frames[frames.length - 1]).toEqual({ type: "fleet", fleet: IDLE });

    // 上行同样要通 —— 错配是双向的,只验一个方向会漏掉一半
    expect(phone.send({ type: "approve", sessionId: "s1", callId: "c1" })).toBe(true);
    expect(commands[commands.length - 1]).toEqual({
      type: "approve", sessionId: "s1", callId: "c1",
    });
    phone.dispose();
    desktop.dispose();
  });

  it("反过来也一样:只有手机听见在场信号", () => {
    const { relay, desktop, phone, frames } = pair();
    desktop.pushFleet(BUSY);
    relay.announce();

    relay.announce("mobile");
    relay.announce("mobile");

    desktop.pushFleet(IDLE);
    expect(frames[frames.length - 1]).toEqual({ type: "fleet", fleet: IDLE });
    phone.dispose();
    desktop.dispose();
  });
});
