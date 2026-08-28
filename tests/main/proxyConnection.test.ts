import { describe, expect, it } from "vitest";
import { createProxyConnection } from "../../src/main/proxyConnection.js";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";

// proxyConnection 端到端：host 和 guest 各建一条连接，中间一根「直连管道」互喂
// payload（不经过 relay——send 直接调对端的 onWire）。验证握手→密封收发整条链。
// 用真实 noble crypto，和线上同一份。

function linked() {
  const p = nodeRemoteCrypto();
  const hostIdentity = p.generateEd25519();
  const guestIdentity = p.generateEd25519();

  const hostPlain: string[] = [];
  const guestPlain: string[] = [];
  const hostReady: boolean[] = [];
  const guestReady: boolean[] = [];

  // host/guest 互认对方身份公钥（模拟已 pin）
  const host = createProxyConnection({
    crypto: p,
    identity: hostIdentity,
    role: "host",
    deviceId: "A",
    peerIdentities: () => [guestIdentity.publicKey],
    send: (payload) => guest.onWire(payload), // 直连：host 发 → guest 收
    log: () => {},
  });
  const guest = createProxyConnection({
    crypto: p,
    identity: guestIdentity,
    role: "guest",
    deviceId: "B",
    peerIdentities: () => [hostIdentity.publicKey],
    send: (payload) => host.onWire(payload), // 直连：guest 发 → host 收
    log: () => {},
  });

  host.onPlain((t) => hostPlain.push(t));
  guest.onPlain((t) => guestPlain.push(t));
  host.onReady(() => hostReady.push(true));
  guest.onReady(() => guestReady.push(true));

  return { host, guest, hostPlain, guestPlain, hostReady, guestReady, hostIdentity, guestIdentity };
}

describe("proxyConnection（好友代理密封连接骨架，issue #622 PR-D1）", () => {
  it("host/guest 握手 → 双方 ready → 能互发密封帧", () => {
    const { host, guest, hostPlain, guestPlain, hostReady, guestReady } = linked();

    // host 发起握手（对端在场信号触发）
    host.start();
    // 握手是同步直连的：host 发 hello → guest 收（adopt→ready→回 hello?）
    // guest 收到 host 的 hello 后 adopt，但它也要发自己的 hello 让 host 派生。
    // guest 还没 start，收到 hello 时 self 是 null → 忽略。所以 guest 也要 start。
    guest.start();

    expect(host.isReady()).toBe(true);
    expect(guest.isReady()).toBe(true);
    expect(hostReady).toHaveLength(1);
    expect(guestReady).toHaveLength(1);

    // host → guest 密封帧
    host.sendSealed("hello-from-host");
    expect(guestPlain).toEqual(["hello-from-host"]);

    // guest → host 密封帧
    guest.sendSealed("reply-from-guest");
    expect(hostPlain).toEqual(["reply-from-guest"]);
  });

  it("对端身份不在 pin 集合里 → 握手被拒，不就绪", () => {
    const p = nodeRemoteCrypto();
    const hostIdentity = p.generateEd25519();
    const stranger = p.generateEd25519(); // 陌生人，没被 host pin
    const host = createProxyConnection({
      crypto: p, identity: hostIdentity, role: "host", deviceId: "A",
      peerIdentities: () => [], // 谁都没 pin
      send: () => {}, log: () => {},
    });
    const att = createProxyConnection({
      crypto: p, identity: stranger, role: "guest", deviceId: "X",
      peerIdentities: () => [hostIdentity.publicKey],
      send: (payload) => host.onWire(payload), log: () => {},
    });
    host.start();
    att.start();
    expect(host.isReady()).toBe(false); // host 没 pin 陌生人 → 不认
  });

  it("没 ready 时 sendSealed 静默丢弃", () => {
    const { host, guestPlain } = linked();
    host.sendSealed("too-early"); // 还没握手
    expect(guestPlain).toEqual([]);
  });

  it("close 后不再收发", () => {
    const { host, guest, guestPlain } = linked();
    host.start();
    guest.start();
    expect(host.isReady()).toBe(true);
    host.close();
    host.sendSealed("after-close");
    expect(guestPlain).toEqual([]);
    expect(host.isReady()).toBe(false);
  });
});

// ─── 邀请码 secret 证明（issue #657 / ADR-0162）──────────────────────────
//
// 信任根：A 手里那张邀请的一次性 secret。A 的 pin 组一开始是空的（还不认识 B），
// 「谁能对 secret 签出名」才是 A 认下这条连接的全部依据 —— 光知道 channelId
// （= 能连进 relay 房间）**不算数**，否则拿到频道号的人就能拿 A 的凭证跑 Shopify。

/** 一对 host/guest：A 手里有 secretA 那张邀请，B 用 secretB 去证明（给不同的值就是冒充） */
function linkedWithInvite(opts: {
  hostSecret: Uint8Array | null;
  guestSecret: Uint8Array | null;
  /** A 已经 pin 住的 B 公钥（默认空组 = 还没配对过） */
  hostPinned?: () => Uint8Array[];
}) {
  const p = nodeRemoteCrypto();
  const hostIdentity = p.generateEd25519();
  const guestIdentity = p.generateEd25519();

  let liveSecret = opts.hostSecret;
  const paired: Uint8Array[] = [];
  const consumed: true[] = [];

  const host = createProxyConnection({
    crypto: p,
    identity: hostIdentity,
    role: "host",
    deviceId: "A",
    peerIdentities: opts.hostPinned ?? (() => []),
    pairing: {
      verifyWith: () => liveSecret,
      onPaired: (pub) => { paired.push(pub); },
      consume: () => { liveSecret = null; consumed.push(true); },
    },
    send: (payload) => guest.onWire(payload),
    log: () => {},
  });
  const guest = createProxyConnection({
    crypto: p,
    identity: guestIdentity,
    role: "guest",
    deviceId: "B",
    peerIdentities: () => [hostIdentity.publicKey], // B 从邀请码里拿到 A 的公钥，直接 pin
    pairing: { proveWith: () => opts.guestSecret },
    send: (payload) => host.onWire(payload),
    log: () => {},
  });

  return { p, host, guest, hostIdentity, guestIdentity, paired, consumed };
}

describe("proxyConnection 的邀请码 secret 证明（issue #657 / ADR-0162）", () => {
  it("B 用邀请里那把 secret 签出证明 → A 认下、pin 住、那张邀请作废", () => {
    const p = nodeRemoteCrypto();
    const secret = p.randomBytes(32);
    const { host, guest, guestIdentity, paired, consumed } = linkedWithInvite({
      hostSecret: secret,
      guestSecret: secret,
    });

    host.start();
    guest.start();

    expect(host.isReady()).toBe(true);
    expect(guest.isReady()).toBe(true);
    // pin 的是 B 真正那把公钥（不是 hello 自称什么就 pin 什么——自称的公钥同时是验签的输入）
    expect(paired).toHaveLength(1);
    expect(Array.from(paired[0]!)).toEqual(Array.from(guestIdentity.publicKey));
    expect(consumed).toHaveLength(1);
  });

  it("B 不带证明（只知道频道号）→ A 拒绝，一帧都不发给它", () => {
    const p = nodeRemoteCrypto();
    const { host, guest, paired } = linkedWithInvite({
      hostSecret: p.randomBytes(32),
      guestSecret: null, // 没扫过码 / 没拿到邀请：hello 里没有 pair 字段
    });
    const guestPlain: string[] = [];
    guest.onPlain((t) => guestPlain.push(t));

    host.start();
    guest.start();

    expect(host.isReady()).toBe(false);
    expect(paired).toEqual([]);
    // B 这一侧会 ready（它从邀请码里 pin 了 A 的公钥，A 的 hello 是真的）——
    // 但**认证是单向没通的**：A 不认 B，于是 A 一帧都发不出去，
    // 授权清单（proxy_grant）到不了 B，B 打过来的 proxy_req 也没人执行
    host.sendSealed("secret-stuff");
    expect(guestPlain).toEqual([]);
  });

  it("B 拿错的 secret 签证明 → 验不过，A 不 pin 也不就绪", () => {
    const p = nodeRemoteCrypto();
    const { host, paired, consumed, guest } = linkedWithInvite({
      hostSecret: p.randomBytes(32),
      guestSecret: p.randomBytes(32), // 冒充者自己编的一把
    });

    host.start();
    guest.start();

    expect(host.isReady()).toBe(false);
    expect(paired).toEqual([]);
    expect(consumed).toEqual([]);
  });

  it("A 手上没有活着的邀请（过期/已用掉）→ 证明再对也不认", () => {
    const p = nodeRemoteCrypto();
    const secret = p.randomBytes(32);
    const { host, guest, paired } = linkedWithInvite({
      hostSecret: null, // verifyWith 回 null = 手上那张已经作废
      guestSecret: secret,
    });

    host.start();
    guest.start();

    expect(host.isReady()).toBe(false);
    expect(paired).toEqual([]);
  });

  it("pin 上之后不再消耗邀请：B 重连不带证明也认得（走 pin 路径）", () => {
    const p = nodeRemoteCrypto();
    const guestIdentity = p.generateEd25519();
    const hostIdentity = p.generateEd25519();
    const paired: Uint8Array[] = [];

    const host = createProxyConnection({
      crypto: p,
      identity: hostIdentity,
      role: "host",
      deviceId: "A",
      peerIdentities: () => [guestIdentity.publicKey], // 上一轮已经 pin 住了
      pairing: {
        verifyWith: () => null, // 邀请早就用掉了
        onPaired: (pub) => { paired.push(pub); },
      },
      send: (payload) => guest.onWire(payload),
      log: () => {},
    });
    const guest = createProxyConnection({
      crypto: p,
      identity: guestIdentity,
      role: "guest",
      deviceId: "B",
      peerIdentities: () => [hostIdentity.publicKey],
      send: (payload) => host.onWire(payload),
      log: () => {},
    });

    host.start();
    guest.start();

    expect(host.isReady()).toBe(true);
    expect(guest.isReady()).toBe(true);
    expect(paired).toEqual([]); // 走的是 pin 路径，没再动那张邀请
  });
});

// ─── 对端离场（issue #672）──────────────────────────────────────────────
describe("proxyConnection 的离场（issue #672）", () => {
  it("peerGone → 退出就绪、帧发不出去；对端回来重新握手又能用", () => {
    const { host, guest, guestPlain } = linked();
    host.start();
    guest.start();
    expect(host.isReady()).toBe(true);

    host.peerGone();
    expect(host.isReady()).toBe(false);
    host.sendSealed("发不出去的"); // 静默丢弃，不抛
    expect(guestPlain).toEqual([]);

    // 对端回来：两边各重新握一次手（真 relay 上由 `:peer` 驱动）
    guest.start();
    host.start();
    expect(host.isReady()).toBe(true);
    host.sendSealed("回来了");
    expect(guestPlain).toEqual(["回来了"]);
  });

  it("close 之后再 peerGone 不做任何事（已经关了的连接没有「退出就绪」可言）", () => {
    const { host } = linked();
    host.start();
    host.close();
    host.peerGone();
    expect(host.isReady()).toBe(false);
  });
});

// ─── 单帧上限（issue #674）──────────────────────────────────────────────
//
// relay 对整条消息设了 MAX_FRAME_BYTES 的闸，超了它 **关掉发送方的连接**（1009）——
// 不是丢这一帧。所以宁可这一帧不发，让调用方回一句人话。

describe("proxyConnection 的单帧上限（issue #674）", () => {
  it("载荷超限 → 回 false 且一个字节都不交给传输；小的照发", () => {
    const p = nodeRemoteCrypto();
    const hostIdentity = p.generateEd25519();
    const guestIdentity = p.generateEd25519();
    const wire: string[] = [];

    const host = createProxyConnection({
      crypto: p, identity: hostIdentity, role: "host", deviceId: "A",
      peerIdentities: () => [guestIdentity.publicKey],
      send: (payload) => { wire.push(payload); guest.onWire(payload); },
      log: () => {},
    });
    const guest = createProxyConnection({
      crypto: p, identity: guestIdentity, role: "guest", deviceId: "B",
      peerIdentities: () => [hostIdentity.publicKey],
      send: (payload) => host.onWire(payload),
      log: () => {},
    });
    host.start();
    guest.start();
    expect(host.isReady()).toBe(true);

    wire.length = 0;
    expect(host.sendSealed("小的一帧")).toBe(true);
    expect(wire).toHaveLength(1);

    wire.length = 0;
    // 300 KB 明文 → base64 之后铁定过 256 KiB
    expect(host.sendSealed("x".repeat(300 * 1024))).toBe(false);
    expect(wire).toEqual([]); // 交出去的下场是本端连接被 relay 关掉
    expect(host.isReady()).toBe(true); // 连接本身没事，只是这一帧没发
  });

  it("没 ready 时也回 false（调用方分不出是哪种，但两种都要说人话）", () => {
    const { host } = linked();
    expect(host.sendSealed("还没握手")).toBe(false);
  });
});
