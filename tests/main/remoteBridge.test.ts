import { describe, expect, it, vi } from "vitest";
import { createRemoteBridge } from "../../src/main/remoteBridge.js";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";
import { b64decode, b64encode } from "../../src/shared/remote/b64.js";
import {
  buildHello, deriveSession, newConnectionParty,
  type HandshakeHello, type SelfParty, type SessionKeys,
} from "../../src/shared/remote/handshake.js";
import { buildPairProof } from "../../src/shared/remote/pairing.js";
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

/** 默认那条连接的 cid。多连接的用例自己传别的(ADR-0130) */
const C1 = "c1";

function fakeTransport() {
  /** 只留载荷,和从前一样;要看发给谁的用例读 addressed */
  const sent: string[] = [];
  const addressed: { payload: string; to: string }[] = [];
  let onMsg: (p: string, from: string) => void = () => {};
  let onPeer: (cid: string) => void = () => {};
  let onGone: (cid: string) => void = () => {};
  let onClose: () => void = () => {};
  return {
    sent,
    addressed,
    send(p: string, to: string) { sent.push(p); addressed.push({ payload: p, to }); },
    onMessage(cb: (p: string, from: string) => void) { onMsg = cb; },
    onPeer(cb: (cid: string) => void) { onPeer = cb; },
    onGone(cb: (cid: string) => void) { onGone = cb; },
    onClose(cb: () => void) { onClose = cb; },
    /** 桥不该调它(重连时机归调用方,见 RemoteTransport 合同) */
    reconnectNow() {},
    close: vi.fn(),
    emit(p: string, from = C1) { onMsg(p, from); },
    /** 中继报告某条对端连接已在场(SSE 的 :peer <cid>)。握手唯一的起点 */
    emitPeer(cid = C1) { onPeer(cid); },
    emitGone(cid = C1) { onGone(cid); },
    emitClose() { onClose(); },
    /** 只看发给某一条连接的载荷 */
    sentTo(cid: string) { return addressed.filter((x) => x.to === cid).map((x) => x.payload); },
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
  helloIndex: number,
  cid = C1
): SessionKeys {
  // 多连接时桌面给每条各发一份 hello,要挑发给这条的那份(ADR-0130)
  const mine = t.sentTo(cid);
  const desktopHello = JSON.parse((cid === C1 ? t.sent[helloIndex] : mine[helloIndex])!) as HandshakeHello;
  const keys = deriveSession(P, {
    self: peer, peerHello: desktopHello, peerIdentityPub: desktopIdentityPub,
  });
  expect(keys).not.toBeNull();
  t.emit(JSON.stringify(buildHello(P, peer)), cid);
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
    peerIdentities: () => [peer.identity.publicKey],
  });
  const peer = newPeer();
  t.emitPeer(); // 对端到场:这之后才有 hello。不发信号的那条路径由专门的用例覆盖
  return { identity, t, onCommand, b, peer };
}

describe("createRemoteBridge", () => {
  it("构造之后一言不发：没有在场信号就没有 hello（中继不排队，盲发只是喂虚空）", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const b = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t,
      onCommand: vi.fn(), peerIdentities: () => [P.generateEd25519().publicKey],
    });
    expect(t.sent).toHaveLength(0);
    t.emitPeer();
    expect(t.sent).toHaveLength(1);
    b.dispose();
  });

  it("收到在场信号 → 发出自己的 hello（明文 JSON）", () => {
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
    // 第二个参数是发件人的 cid:上层靠它把订阅、回话分到各台手机(ADR-0130)
    expect(onCommand).toHaveBeenCalledWith({ type: "approve", sessionId: "s", callId: "c" }, C1);

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
    const impostor = newPeer(); // peerIdentities() 里没有它的公钥
    t.emit(JSON.stringify(buildHello(P, impostor)));
    b.pushFleet(BUSY);
    expect(t.sent).toHaveLength(1);
    b.dispose();
  });

  // 被挡下的握手要报上去(issue #485)。桥只负责"如实报每一次",去重在上层 ——
  // 下面第三条用例钉的就是这个分工:同一台手机连着敲门,桥不会自作主张吞掉
  it("还没配对过任何手机时被挡下 → onRejected 报 unpaired", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const onRejected = vi.fn();
    const b = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t,
      onCommand: vi.fn(), peerIdentities: () => [], onRejected,
    });
    t.emitPeer();
    t.emit(JSON.stringify(buildHello(P, newPeer())));
    expect(onRejected).toHaveBeenCalledWith({ deviceId: "m1", reason: "unpaired" });
    b.dispose();
  });

  it("pin 住的公钥对不上 → onRejected 报 identity-mismatch（两种 reason 分得开）", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const onRejected = vi.fn();
    const b = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t, onCommand: vi.fn(),
      peerIdentities: () => [P.generateEd25519().publicKey], // 配过对，但不是这台手机
      onRejected,
    });
    t.emitPeer();
    t.emit(JSON.stringify(buildHello(P, newPeer())));
    expect(onRejected).toHaveBeenCalledWith({ deviceId: "m1", reason: "identity-mismatch" });
    b.dispose();
  });

  // 配了几台手机就有几把 pin。哪一把是对的由**签名**回答 —— hello 里的 deviceId
  // 是明文、由对端自称,拿它查表等于让对端自己指定用哪把公钥来验自己
  it("pin 住好几把时：组里任意一把对得上就能进 ready", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const onRejected = vi.fn();
    const second = newPeer();
    const b = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t, onCommand: vi.fn(), onRejected,
      // 第一把是别人的,要验到第二把才对上
      peerIdentities: () => [P.generateEd25519().publicKey, second.identity.publicKey],
    });
    t.emitPeer();
    shake(t, second, identity.publicKey, 0);

    expect(onRejected).not.toHaveBeenCalled();
    // 进了 ready 才会有加密的快照推下去
    b.pushFleet(BUSY);
    expect(t.sent.filter((l) => !l.startsWith("{"))).not.toHaveLength(0);
    b.dispose();
  });

  it("组里一把都对不上 → 还是 identity-mismatch，不会因为试了几把就放行", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const onRejected = vi.fn();
    const b = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t, onCommand: vi.fn(), onRejected,
      peerIdentities: () => [
        P.generateEd25519().publicKey, P.generateEd25519().publicKey, P.generateEd25519().publicKey,
      ],
    });
    t.emitPeer();
    t.emit(JSON.stringify(buildHello(P, newPeer())));
    expect(onRejected).toHaveBeenCalledWith({ deviceId: "m1", reason: "identity-mismatch" });
    b.dispose();
  });

  // ── 几台手机同时连着(ADR-0130)──
  //
  // 原来桥只有一套会话状态,第二台连上来会把第一台的密钥顶掉,而第一台毫不知情:
  // 它接着往一根用旧密钥封的管子里发,对面每一帧都解不开。
  it("两台手机各一套密钥：给谁的帧只有谁解得开", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const a = newPeer();
    const b = newPeer();
    const bridge = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t, onCommand: vi.fn(),
      peerIdentities: () => [a.identity.publicKey, b.identity.publicKey],
    });

    t.emitPeer("ca");
    const ka = shake(t, a, identity.publicKey, 0, "ca");
    t.emitPeer("cb");
    const kb = shake(t, b, identity.publicKey, 0, "cb");

    t.addressed.length = 0;
    bridge.pushFleet(BUSY);

    // 两条都收到了自己那一份 —— fleet 是共享状态,广播是对的
    const toA = t.sentTo("ca");
    const toB = t.sentTo("cb");
    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(1);
    // 但**密文不同**,而且各自只有自己那把开得了
    expect(toA[0]).not.toBe(toB[0]);
    expect(createOpener(P, ka.recv.key, ka.recv.prefix).open(b64decode(toA[0]!)!)).not.toBeNull();
    expect(createOpener(P, ka.recv.key, ka.recv.prefix).open(b64decode(toB[0]!)!)).toBeNull();

    bridge.dispose();
  });

  it("时间线只发给订它的那一台（广播等于把 A 在看的会话推到 B 的屏上）", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const a = newPeer();
    const b = newPeer();
    const bridge = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t, onCommand: vi.fn(),
      peerIdentities: () => [a.identity.publicKey, b.identity.publicKey],
    });
    t.emitPeer("ca");
    shake(t, a, identity.publicKey, 0, "ca");
    t.emitPeer("cb");
    shake(t, b, identity.publicKey, 0, "cb");

    t.addressed.length = 0;
    bridge.pushTimeline("ca", "s1", []);
    expect(t.sentTo("ca")).toHaveLength(1);
    expect(t.sentTo("cb")).toHaveLength(0);

    // 提示和统计同理:它们是"回答某一次操作",不是共享状态
    t.addressed.length = 0;
    bridge.pushNotice("cb", "你的文件没收下");
    expect(t.sentTo("ca")).toHaveLength(0);
    expect(t.sentTo("cb")).toHaveLength(1);

    bridge.dispose();
  });

  it("一台走了只丢它那套；另一台照常收", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const a = newPeer();
    const b = newPeer();
    const onReset = vi.fn();
    const bridge = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t, onCommand: vi.fn(), onReset,
      peerIdentities: () => [a.identity.publicKey, b.identity.publicKey],
    });
    t.emitPeer("ca");
    shake(t, a, identity.publicKey, 0, "ca");
    t.emitPeer("cb");
    shake(t, b, identity.publicKey, 0, "cb");

    t.emitGone("ca");
    // 上层据此清掉那台手机的订阅 —— 它不会再有别的机会知道这件事
    expect(onReset).toHaveBeenCalledWith("ca");
    expect(bridge.connected()).toEqual(["cb"]);

    t.addressed.length = 0;
    bridge.pushFleet(BUSY);
    expect(t.sentTo("ca")).toHaveLength(0);
    expect(t.sentTo("cb")).toHaveLength(1);

    bridge.dispose();
  });

  // 中继保证 :peer 排在对端任何一帧之前。到不了这个顺序说明对面不是通过中继来的
  it("帧来自没打过招呼的 cid → 丢弃，不凭空建会话", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const onCommand = vi.fn();
    const bridge = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t, onCommand,
      peerIdentities: () => [P.generateEd25519().publicKey],
    });
    t.emit(JSON.stringify(buildHello(P, newPeer())), "cx");
    expect(onCommand).not.toHaveBeenCalled();
    expect(bridge.connected()).toEqual([]);
    bridge.dispose();
  });

  it("桥不替上层节流：敲三次门就报三次", () => {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const onRejected = vi.fn();
    const b = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t,
      onCommand: vi.fn(), peerIdentities: () => [], onRejected,
    });
    t.emitPeer();
    // 每次都是新的 eph —— 同一把会被 usedPeerEphs 挡在 adopt 之前，那是另一条路径
    for (let i = 0; i < 3; i++) t.emit(JSON.stringify(buildHello(P, newPeer())));
    expect(onRejected).toHaveBeenCalledTimes(3);
    b.dispose();
  });

  it("断开只清状态；下一条在场信号才开新一轮，并当场把快照补推给新对端（去重基线已清）", () => {
    const { t, b, peer, identity } = harness();
    shake(t, peer, identity.publicKey, 0);
    b.pushFleet(BUSY);
    const afterFirst = t.sent.length;

    // 连接都断了,这时候发 hello 只是丢进虚空
    t.emitClose();
    expect(t.sent.length).toBe(afterFirst);

    t.emitPeer();
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

  // ── 重新握手这一门（src/main/remoteBridge.ts 的 onHello）──
  //
  // 守的性质没变:**一次连接里 nonce 绝不重复**。变的是门的位置。
  // 原来是「ready 之后一概不收握手包」,那道门连**对端真的重开了一轮**也一起挡掉,
  // 于是两端各自锁死在错配的一对上,每一帧都解不开且永无出口(真机上就是那屏
  // "没等到时间线")。现在的门是「同一对 (self.eph, peerEph) 只许派生一次」——
  // 密钥 = HKDF(x25519(selfEph, peerEph), …),这一对没用过就等于这把密钥没用过,
  // counter 从 0 起算才是安全的。重放挡得一样死,合法的重来放得过去。
  //
  // 下面四条:一条钉"合法的重来要放过去",三条钉"重放一步都不许进"。

  it("ready 之后来一条**新**的合法 hello → 重新派生并补推快照（对端重开了一轮，不跟就永远解不开）", () => {
    const { t, b, peer, identity } = harness();
    const { keys } = shakeRecording(t, peer, identity.publicKey);
    const stale = createOpener(P, keys.recv.key, keys.recv.prefix);
    b.pushFleet(BUSY);
    const afterFirst = t.sent.length;

    // 同一台手机、同一把身份密钥，换了全新的 eph/nonceHalf —— 手机重连一次就是这个样子
    const fresh = newConnectionParty(P, {
      role: "mobile", deviceId: "m1", identity: peer.identity,
    });
    const desktopHello = JSON.parse(t.sent[0]!) as HandshakeHello;
    const next = deriveSession(P, {
      self: fresh, peerHello: desktopHello, peerIdentityPub: identity.publicKey,
    })!;
    t.emit(JSON.stringify(buildHello(P, fresh)));

    // 补推了快照:对端是新的一轮，它手里什么都没有（去重基线也跟着清了）
    expect(t.sent.length).toBe(afterFirst + 1);
    const opener = createOpener(P, next.recv.key, next.recv.prefix);
    const wire = t.sent[t.sent.length - 1]!;
    expect(JSON.parse(dec(opener.open(b64decode(wire)!)!))).toEqual({ type: "fleet", fleet: BUSY });
    // 而且真的换了钥匙:上一轮那把开不开这一帧
    expect(stale.open(b64decode(wire)!)).toBeNull();

    // 新密钥下计数器重新从 0 起算——安全，因为这把钥匙此前一帧都没封过
    expect(counterOf(wire)).toBe(0n);
    b.dispose();
  });

  it("同一条 hello 再来一次（同一对 eph）→ 一步都不进：不重新派生、不补推、计数器不回零", () => {
    const { t, b, peer, identity } = harness();
    const { line } = shakeRecording(t, peer, identity.publicKey);
    b.pushFleet(BUSY);
    const afterFirst = t.sent.length;

    t.emit(line);
    t.emit(line);
    expect(t.sent.length).toBe(afterFirst);

    b.pushFleet(IDLE);
    expect(counterOf(t.sent[t.sent.length - 1]!)).not.toBe(0n);
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

describe("扫码配对(issue #583)", () => {
  /** 桌面手上有一张活着的码,pin 组是空的 —— 也就是"全新的一台手机"那一刻 */
  function pairHarness(opts: { pinned?: Uint8Array[] } = {}) {
    const identity = P.generateEd25519();
    const t = fakeTransport();
    const secret = P.randomBytes(32);
    const onPaired = vi.fn();
    const consume = vi.fn();
    let liveOffer: { secret: Uint8Array } | null = { secret };
    const b = createRemoteBridge({
      crypto: P, identity, deviceId: "d1", transport: t, onCommand: vi.fn(),
      peerIdentities: () => opts.pinned ?? [],
      pairing: {
        offer: () => liveOffer,
        consume: () => { liveOffer = null; consume(); },
        onPaired,
      },
    });
    const peer = newPeer();
    t.emitPeer();
    /** 手机侧:扫到 secret 之后带着证明连过来 */
    const connect = (withSecret: Uint8Array = secret): void => {
      const desktopHello = JSON.parse(t.sent[t.sent.length - 1]!) as HandshakeHello;
      expect(deriveSession(P, {
        self: peer, peerHello: desktopHello, peerIdentityPub: identity.publicKey,
      })).not.toBeNull();
      const proof = buildPairProof(P, {
        role: "mobile", deviceId: peer.deviceId, identity: peer.identity,
        secret: withSecret, ephPub: peer.eph.publicKey, nonceHalf: peer.nonceHalf,
      });
      t.emit(JSON.stringify(buildHello(P, peer, { proof })));
    };
    const clearOffer = (): void => { liveOffer = null; };
    return { identity, t, b, peer, secret, onPaired, consume, connect, clearOffer };
  }

  it("扫过码的手机:pin 组是空的也能连上,而且把公钥交给上层落盘", () => {
    const h = pairHarness();
    h.connect();
    expect(h.onPaired).toHaveBeenCalledTimes(1);
    expect(b64encode(h.onPaired.mock.calls[0]![0] as Uint8Array)).toBe(b64encode(h.peer.identity.publicKey));
    // 握手真的成了:桌面开始发密文帧(明文只有那一条 hello)
    h.b.pushFleet(BUSY);
    expect(h.t.sent.length).toBeGreaterThan(1);
    expect(h.t.sent[h.t.sent.length - 1]!.startsWith("{")).toBe(false);
    h.b.dispose();
  });

  it("那张码用完即废:配上之后 consume 被调,第二台手机拿同一把 secret 连不上", () => {
    const h = pairHarness();
    h.connect();
    expect(h.consume).toHaveBeenCalledTimes(1);
    const onRejected = vi.fn();
    // 第二台:同一把 secret,但码已经作废
    const t2 = fakeTransport();
    const b2 = createRemoteBridge({
      crypto: P, identity: h.identity, deviceId: "d1", transport: t2, onCommand: vi.fn(),
      peerIdentities: () => [],
      pairing: { offer: () => null, consume: vi.fn(), onPaired: vi.fn() },
      onRejected,
    });
    t2.emitPeer();
    const other = newPeer();
    const proof = buildPairProof(P, {
      role: "mobile", deviceId: other.deviceId, identity: other.identity,
      secret: h.secret, ephPub: other.eph.publicKey, nonceHalf: other.nonceHalf,
    });
    t2.emit(JSON.stringify(buildHello(P, other, { proof })));
    expect(onRejected).toHaveBeenCalledWith({ deviceId: "m1", reason: "unpaired" });
    b2.dispose();
    h.b.dispose();
  });

  it("证明对不上 → 拒,而且那张码不作废(别人乱试不该把用户的码试没)", () => {
    const h = pairHarness();
    h.connect(P.randomBytes(32)); // 没扫过码的人
    expect(h.onPaired).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
  });

  it("桌面没开码 → 带证明也拒(不开码就没有配对这条路)", () => {
    const h = pairHarness();
    h.clearOffer();
    h.connect();
    expect(h.onPaired).not.toHaveBeenCalled();
  });

  it("不带证明的陌生手机 → 还是拒(老行为一字不变)", () => {
    const h = pairHarness();
    h.t.emit(JSON.stringify(buildHello(P, h.peer)));
    expect(h.onPaired).not.toHaveBeenCalled();
  });

  it("已经 pin 住的手机正常连 → 不碰那张码(配好的设备不该每次连接都消耗一张)", () => {
    const peerIdentity = P.generateEd25519();
    const h = pairHarness({ pinned: [peerIdentity.publicKey] });
    const known = newConnectionParty(P, { role: "mobile", deviceId: "m9", identity: peerIdentity });
    h.t.emit(JSON.stringify(buildHello(P, known)));
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.onPaired).not.toHaveBeenCalled();
    h.b.dispose();
  });
});
