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
