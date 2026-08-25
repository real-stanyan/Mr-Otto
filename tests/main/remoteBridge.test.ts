import { describe, expect, it, vi } from "vitest";
import { createRemoteBridge } from "../../src/main/remoteBridge.js";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";
import { b64decode, b64encode } from "../../src/shared/remote/b64.js";
import {
  buildHello, deriveSession, newConnectionParty,
  type HandshakeHello, type SelfParty, type SessionKeys,
} from "../../src/shared/remote/handshake.js";
import { createOpener, createSealer } from "../../src/shared/remote/sealedStream.js";
import type { IslandFleet } from "../../src/shared/shellBridge.js";

const P = nodeRemoteCrypto();
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

const IDLE: IslandFleet = { agents: [], focusedSessionId: null };
const BUSY: IslandFleet = {
  agents: [{
    sessionId: "s1", title: "t", phase: "active", currentTool: null,
    turnStartedAt: 1, pendingApproval: null, workspace: "/w",
  }],
  focusedSessionId: "s1",
};

function fakeTransport() {
  const sent: string[] = [];
  let onMsg: (p: string) => void = () => {};
  let onClose: () => void = () => {};
  return {
    sent,
    send(p: string) { sent.push(p); },
    onMessage(cb: (p: string) => void) { onMsg = cb; },
    onClose(cb: () => void) { onClose = cb; },
    close: vi.fn(),
    emit(p: string) { onMsg(p); },
    emitClose() { onClose(); },
  };
}

function newPeer(): SelfParty {
  return newConnectionParty(P, { role: "mobile", deviceId: "m1", identity: P.generateEd25519() });
}

/** 走一次**真**握手：拿桌面发出的 hello 算手机侧的密钥，再把手机的 hello 喂回去。
    没有任何测试后门——加密路径和生产环境完全一致，只是传输被替换成了数组。 */
function shake(
  t: ReturnType<typeof fakeTransport>,
  peer: SelfParty,
  desktopIdentityPub: Uint8Array,
  helloIndex: number
): SessionKeys {
  const desktopHello = JSON.parse(t.sent[helloIndex]!) as HandshakeHello;
  const keys = deriveSession(P, {
    self: peer, peerHello: desktopHello, peerIdentityPub: desktopIdentityPub,
  });
  expect(keys).not.toBeNull();
  t.emit(JSON.stringify(buildHello(P, peer)));
  return keys!;
}

/** 同 shake，但把手机那条 hello 的**线格式**一起交回来。
    握手包是明文过中继的，网关运营者手里始终有一份逐字节的副本——
    重放测试要的就是这一串，不是"再生成一条差不多的"。 */
function shakeRecording(
  t: ReturnType<typeof fakeTransport>,
  peer: SelfParty,
  desktopIdentityPub: Uint8Array
): { keys: SessionKeys; line: string } {
  const desktopHello = JSON.parse(t.sent[t.sent.length - 1]!) as HandshakeHello;
  const keys = deriveSession(P, {
    self: peer, peerHello: desktopHello, peerIdentityPub: desktopIdentityPub,
  });
  expect(keys).not.toBeNull();
  const line = JSON.stringify(buildHello(P, peer));
  t.emit(line);
  return { keys: keys!, line };
}

/** 密文帧头 8 字节 = 大端计数器。nonce = 前缀||计数器，所以计数器相同 = nonce 相同 */
function counterOf(wire: string): bigint {
  const raw = b64decode(wire)!;
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false);
}

function harness() {
  const identity = P.generateEd25519();
  const t = fakeTransport();
  const onCommand = vi.fn();
  const b = createRemoteBridge({
    crypto: P, identity, deviceId: "d1", transport: t, onCommand,
    peerIdentity: () => peer.identity.publicKey,
  });
  const peer = newPeer();
  return { identity, t, onCommand, b, peer };
}

describe("createRemoteBridge", () => {
  it("构造即发出自己的 hello（明文 JSON）", () => {
    const { t, b } = harness();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.startsWith("{")).toBe(true);
    expect(JSON.parse(t.sent[0]!).role).toBe("desktop");
    b.dispose();
  });

  it("握手完成前不发任何状态帧", () => {
    const { t, b } = harness();
    b.pushFleet(BUSY);
    expect(t.sent).toHaveLength(1); // 还是只有那条 hello
    b.dispose();
  });

  it("握手后推 fleet；手机侧能解出原样的帧", () => {
    const { t, b, peer, identity } = harness();
    const keys = shake(t, peer, identity.publicKey, 0);
    const opener = createOpener(P, keys.recv.key, keys.recv.prefix);

    b.pushFleet(BUSY);
    const wire = t.sent[t.sent.length - 1]!;
    expect(wire.startsWith("{")).toBe(false); // 密文，不是明文
    const plain = opener.open(b64decode(wire)!);
    expect(JSON.parse(dec(plain!))).toEqual({ type: "fleet", fleet: BUSY });
    b.dispose();
  });

  it("同一份 fleet 连推两次，第二次不过线（去重，同 islandBridge）", () => {
    const { t, b, peer, identity } = harness();
    shake(t, peer, identity.publicKey, 0);
    const before = t.sent.length;
    b.pushFleet(BUSY);
    b.pushFleet(BUSY);
    expect(t.sent.length).toBe(before + 1);
    b.pushFleet(IDLE);
    expect(t.sent.length).toBe(before + 2);
    b.dispose();
  });

  it("合法上行命令 → 回调；带 grant 的 approve 整条丢弃且不回调", () => {
    const { t, b, onCommand, peer, identity } = harness();
    const keys = shake(t, peer, identity.publicKey, 0);
    const sealer = createSealer(P, keys.send.key, keys.send.prefix);
    const up = (json: string) => t.emit(b64encode(sealer.seal(enc(json))));

    up('{"type":"approve","sessionId":"s","callId":"c"}');
    expect(onCommand).toHaveBeenCalledWith({ type: "approve", sessionId: "s", callId: "c" });

    onCommand.mockClear();
    up('{"type":"approve","sessionId":"s","callId":"c","grant":"session"}');
    expect(onCommand).not.toHaveBeenCalled();
    b.dispose();
  });

  it("垃圾字节 / 别人的密钥封的帧 → 丢弃，不抛", () => {
    const { t, b, onCommand, peer, identity } = harness();
    shake(t, peer, identity.publicKey, 0);

    expect(() => t.emit("not-even-base64!!!")).not.toThrow();
    const wrong = createSealer(P, P.randomBytes(32), P.randomBytes(4));
    expect(() => t.emit(b64encode(wrong.seal(enc('{"type":"watch","sessionId":"s"}'))))).not.toThrow();
    expect(onCommand).not.toHaveBeenCalled();
    b.dispose();
  });

  it("身份 pin 不上的对端 hello → 不进 ready，状态帧仍不过线（TOFU 的执行面）", () => {
    const { t, b } = harness();
    const impostor = newPeer(); // peerIdentity() 返回的不是它的公钥
    t.emit(JSON.stringify(buildHello(P, impostor)));
    b.pushFleet(BUSY);
    expect(t.sent).toHaveLength(1);
    b.dispose();
  });

  it("断开 → 重发 hello；重握手当场把快照补推给新对端（去重基线已清）", () => {
    const { t, b, peer, identity } = harness();
    shake(t, peer, identity.publicKey, 0);
    b.pushFleet(BUSY);
    const afterFirst = t.sent.length;

    t.emitClose();
    expect(t.sent.length).toBe(afterFirst + 1); // 新一轮 hello
    expect(t.sent[t.sent.length - 1]!.startsWith("{")).toBe(true);

    // 同一台手机、新一次连接：身份密钥不变，临时密钥和 nonce 换新
    const fresh = newPeer();
    const keys2 = shake(
      t,
      { ...peer, eph: fresh.eph, nonceHalf: fresh.nonceHalf },
      identity.publicKey,
      t.sent.length - 1
    );

    // 关键断言:握手完成这一刻就该有一帧快照过线 —— 对端是新的,它什么都还没有。
    // 内容和断线前**一样**,所以这一帧能过线,证明去重基线确实被清掉了。
    const wire = t.sent[t.sent.length - 1]!;
    expect(wire.startsWith("{")).toBe(false);
    const opener = createOpener(P, keys2.recv.key, keys2.recv.prefix);
    expect(JSON.parse(dec(opener.open(b64decode(wire)!)!))).toEqual({ type: "fleet", fleet: BUSY });

    // 补推之后基线重新生效:同一份再推一次不该过线
    const before = t.sent.length;
    b.pushFleet(BUSY);
    expect(t.sent.length).toBe(before);
    b.dispose();
  });

  // ── ready 之后不再收握手包（src/main/remoteBridge.ts 的 phase 门）──
  //
  // 这三条守的是同一个性质:**一次连接里 nonce 绝不重复**。
  // 没有那道门时,重放一条 hello 就能让 deriveSession 用没换过的 self.eph/nonceHalf
  // 算出同一把密钥,再让 createSealer 从 counter=0n 重新起算 —— 同 key 同 nonce。

  it("ready 之后又来一条合法签名的 hello → 忽略,不重新握手（第一次的密钥照旧管用）", () => {
    const { t, b, peer, identity } = harness();
    const { keys } = shakeRecording(t, peer, identity.publicKey);
    const opener = createOpener(P, keys.recv.key, keys.recv.prefix);
    b.pushFleet(BUSY);
    const afterFirst = t.sent.length;

    // 同一台手机、同一把身份密钥，但换了全新的 eph/nonceHalf：签名完全合法，
    // 换成"合法的第二次握手"也一样必须被挡——重新握手只走 startHandshake 那条路
    const fresh = newConnectionParty(P, {
      role: "mobile", deviceId: "m1", identity: peer.identity,
    });
    t.emit(JSON.stringify(buildHello(P, fresh)));
    expect(t.sent.length).toBe(afterFirst); // 没有补推快照 = 根本没重新派生

    // 第一次握手那套密钥仍然开得开后续帧；真被重新 key 过的话这里解不开
    b.pushFleet(IDLE);
    const plain = opener.open(b64decode(t.sent[t.sent.length - 1]!)!);
    expect(JSON.parse(dec(plain!))).toEqual({ type: "fleet", fleet: IDLE });
    b.dispose();
  });

  it("重放上一次的 hello → 拒（spec 必测负例三：旧 connectionNonce 不得被接受）", () => {
    const { t, b, peer, identity } = harness();
    const { keys, line } = shakeRecording(t, peer, identity.publicKey);
    const opener = createOpener(P, keys.recv.key, keys.recv.prefix);
    b.pushFleet(BUSY);
    const afterFirst = t.sent.length;

    // 攻击者手里那份逐字节的副本，原样再喂一遍
    t.emit(line);
    // 拒绝的可观测面：没有补推快照（onHello 成功那一路一定会补推）
    expect(t.sent.length).toBe(afterFirst);

    // 而且 sealer 没被换掉：下一帧还是接着数，不是回到 0
    b.pushFleet(IDLE);
    const wire = t.sent[t.sent.length - 1]!;
    expect(counterOf(wire)).not.toBe(0n);
    expect(JSON.parse(dec(opener.open(b64decode(wire)!)!))).toEqual({ type: "fleet", fleet: IDLE });
    b.dispose();
  });

  it("一次会话里没有两帧共用一个计数器 —— 中间夹一次 hello 重放也不回零", () => {
    const { t, b, peer, identity } = harness();
    const { line } = shakeRecording(t, peer, identity.publicKey);

    const counters: bigint[] = [];
    const push = (f: IslandFleet) => {
      b.pushFleet(f);
      counters.push(counterOf(t.sent[t.sent.length - 1]!));
    };

    push(BUSY);
    push(IDLE);
    t.emit(line); // 重放攻击就插在这里
    push(BUSY);
    push(IDLE);

    expect(counters).toEqual([0n, 1n, 2n, 3n]);
    // 上面那条是"严格递增"，这条是它守的那个性质本身：nonce 不重复
    expect(new Set(counters).size).toBe(counters.length);
    b.dispose();
  });

  it("dispose 之后不再发、不再回调、传输被关掉", () => {
    const { t, b, onCommand, peer, identity } = harness();
    const keys = shake(t, peer, identity.publicKey, 0);
    const sealer = createSealer(P, keys.send.key, keys.send.prefix);
    const frame = b64encode(sealer.seal(enc('{"type":"watch","sessionId":"s"}')));

    b.dispose();
    const before = t.sent.length;
    b.pushFleet(BUSY);
    t.emit(frame);
    expect(t.sent.length).toBe(before);
    expect(onCommand).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalled();
  });
});
