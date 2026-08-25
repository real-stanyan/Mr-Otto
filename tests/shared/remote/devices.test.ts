import { describe, expect, it, vi } from "vitest";
import { createRemoteDevices, type DeviceRow, type DevicesApi } from "../../../src/shared/remote/devices.js";
import { openIdentityStore, type SecretBox } from "../../../src/main/remoteIdentity.js";
import { nodeRemoteCrypto } from "../../../src/main/remoteCryptoNode.js";
import { b64encode } from "../../../src/shared/remote/b64.js";
import { fingerprint } from "../../../src/shared/remote/handshake.js";

const P = nodeRemoteCrypto();

const box: SecretBox = {
  available: () => true,
  encrypt: (p) => new TextEncoder().encode(`S:${Buffer.from(p, "utf8").toString("base64")}`),
  decrypt: (b) => {
    const s = new TextDecoder().decode(b);
    if (!s.startsWith("S:")) throw new Error("nope");
    return Buffer.from(s.slice(2), "base64").toString("utf8");
  },
};

function newStore() {
  const files = new Map<string, Uint8Array>();
  return openIdentityStore({
    path: "/id", crypto: P, box,
    fs: { read: (p) => files.get(p) ?? null, write: (p, b) => { files.set(p, b); } },
  })!;
}

function fakeApi(rows: DeviceRow[] = [], uid: string | null = "u1") {
  const upserts: unknown[] = [];
  const api: DevicesApi = {
    userId: async () => uid,
    upsert: async (r) => { upserts.push(r); },
    list: async () => rows,
  };
  return { api, upserts, rows };
}

function phoneRow(over: Partial<DeviceRow> = {}): DeviceRow & { pub: Uint8Array } {
  const kp = P.generateEd25519();
  return {
    pub: kp.publicKey,
    device_id: "m1", kind: "mobile",
    identity_pub: b64encode(kp.publicKey), kx_pub: b64encode(P.generateX25519().publicKey),
    label: "我的 iPhone", last_seen: "2026-08-25T00:00:00Z",
    ...over,
  };
}

describe("createRemoteDevices", () => {
  it("登记自己：只上传公钥，两把私钥一个字节都不进请求", async () => {
    const store = newStore();
    const { api, upserts } = fakeApi();
    const d = createRemoteDevices({ api, selfKind: "desktop", store, crypto: P });
    expect(await d.registerSelf("Stan 的 Mac")).toBe(true);

    const body = JSON.stringify(upserts[0]);
    expect(body).toContain(b64encode(store.identity.publicKey));
    expect(body).toContain(b64encode(store.kx.publicKey));
    expect(body).not.toContain(b64encode(store.identity.privateKey));
    expect(body).not.toContain(b64encode(store.kx.privateKey));
    expect(upserts[0]).toMatchObject({ kind: "desktop", device_id: store.deviceId, label: "Stan 的 Mac" });
  });

  it("没登录就不登记（也不抛）", async () => {
    const { api, upserts } = fakeApi([], null);
    const d = createRemoteDevices({ api, selfKind: "desktop", store: newStore(), crypto: P, log: () => {} });
    expect(await d.registerSelf("x")).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("只列手机；安全码两端算出来是同一个", async () => {
    const store = newStore();
    const phone = phoneRow();
    const desktopRow: DeviceRow = {
      device_id: "d2", kind: "desktop", identity_pub: b64encode(P.generateEd25519().publicKey),
      kx_pub: "x", label: "另一台 Mac", last_seen: "2026-08-25T00:00:00Z",
    };
    const { api } = fakeApi([phone, desktopRow]);
    const d = createRemoteDevices({ api, selfKind: "desktop", store, crypto: P });

    const peers = await d.listPeers();
    expect(peers.map((p) => p.deviceId)).toEqual(["m1"]); // 桌面不跟桌面配对
    // 手机那侧会用同样两把公钥算 —— 顺序无关,人核对的就是这个数
    expect(peers[0]!.code).toBe(fingerprint(P, phone.pub, store.identity.publicKey));
    expect(peers[0]!.code).toMatch(/^\d{6}$/);
    expect(peers[0]!.pinned).toBe(false);
  });

  it("pin 之后列表里标出来，并且 remoteBridge 拿得到那把公钥", async () => {
    const store = newStore();
    const phone = phoneRow();
    const { api } = fakeApi([phone]);
    const d = createRemoteDevices({ api, selfKind: "desktop", store, crypto: P });

    expect(await d.pin("m1")).toBe(true);
    expect(Array.from(store.peerIdentity()!)).toEqual(Array.from(phone.pub));
    expect((await d.listPeers())[0]!.pinned).toBe(true);
  });

  // 账号目录不是信任来源:掌握 Supabase 的人能往这张表里写任何东西。
  // 长度不对的"公钥"必须在 pin 之前就被拦下,而不是塞进握手里等它出错。
  it("目录里的坏公钥：不进列表、也 pin 不上", async () => {
    const store = newStore();
    const bad = phoneRow({ device_id: "m2", identity_pub: b64encode(new Uint8Array(31)) });
    const log = vi.fn();
    const { api } = fakeApi([bad]);
    const d = createRemoteDevices({ api, selfKind: "desktop", store, crypto: P, log });

    expect(await d.listPeers()).toHaveLength(0);
    expect(await d.pin("m2")).toBe(false);
    expect(store.peerIdentity()).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it("pin 一台目录里没有的设备 → false，不动已有的 pin", async () => {
    const store = newStore();
    const phone = phoneRow();
    const { api } = fakeApi([phone]);
    const d = createRemoteDevices({ api, selfKind: "desktop", store, crypto: P, log: () => {} });
    await d.pin("m1");
    expect(await d.pin("不存在")).toBe(false);
    expect(Array.from(store.peerIdentity()!)).toEqual(Array.from(phone.pub));
  });
});

// 同一份逻辑手机端也在用(它 selfKind: "mobile")。角色一反,登记和过滤都要跟着反 ——
// 这条不成立的话手机会去列别的手机、并且把自己登记成桌面。
describe("手机那一端（selfKind: mobile）", () => {
  it("登记成 mobile，列出来的是桌面", async () => {
    const store = newStore();
    const desktop: DeviceRow = {
      device_id: "d1", kind: "desktop",
      identity_pub: b64encode(P.generateEd25519().publicKey),
      kx_pub: b64encode(P.generateX25519().publicKey),
      label: "Stan 的 Mac", last_seen: "2026-08-25T00:00:00Z",
    };
    const { api, upserts } = fakeApi([desktop, phoneRow()]);
    const d = createRemoteDevices({ api, selfKind: "mobile", store, crypto: P });

    await d.registerSelf("我的 iPhone");
    expect(upserts[0]).toMatchObject({ kind: "mobile" });

    const peers = await d.listPeers();
    expect(peers.map((p) => p.deviceId)).toEqual(["d1"]); // 手机不跟手机配
    expect(await d.pin("d1")).toBe(true);
  });
});
