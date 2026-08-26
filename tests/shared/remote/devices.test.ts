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
  const removed: { userId: string; deviceId: string }[] = [];
  const api: DevicesApi = {
    userId: async () => uid,
    upsert: async (r) => { upserts.push(r); },
    list: async () => rows,
    remove: async (userId, deviceId) => {
      removed.push({ userId, deviceId });
      const i = rows.findIndex((r) => r.device_id === deviceId);
      if (i >= 0) rows.splice(i, 1);
    },
  };
  return { api, upserts, removed, rows };
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

  // 一台手机换个安装(Expo Go / 正式 app / 重装)就是新的一行 —— 身份私钥在各自的
  // 钥匙串里,新安装读不到旧的。目录里没有过期这回事,只有删。
  it("删掉一台没配对的：行没了，已有的 pin 不受影响", async () => {
    const store = newStore();
    const live = phoneRow({ device_id: "m1" });
    const stale = phoneRow({ device_id: "m2", label: "iPhone（旧安装）" });
    const { api, removed } = fakeApi([live, stale]);
    const d = createRemoteDevices({ api, selfKind: "desktop", store, crypto: P });

    await d.pin("m1");
    expect(await d.forget("m2")).toBe(true);

    expect(removed).toEqual([{ userId: "u1", deviceId: "m2" }]);
    expect((await d.listPeers()).map((p) => p.deviceId)).toEqual(["m1"]);
    // 删的是别人那一行,配对必须原样还在
    expect(Array.from(store.peerIdentity()!)).toEqual(Array.from(live.pub));
  });

  // 这条是删除这个动作的**意义**所在:行删了而 pin 还在 = "删掉了但仍然信任",
  // 那就不是撤销,只是从列表里藏起来
  it("删掉的正好是已配对那台：pin 一起清掉", async () => {
    const store = newStore();
    const phone = phoneRow();
    const { api } = fakeApi([phone]);
    const d = createRemoteDevices({ api, selfKind: "desktop", store, crypto: P, log: () => {} });

    await d.pin("m1");
    expect(store.peerIdentity()).not.toBeNull();

    expect(await d.forget("m1")).toBe(true);
    expect(store.peerIdentity()).toBeNull();
  });

  it("没登录 → 不删，也不碰 pin", async () => {
    const store = newStore();
    const phone = phoneRow();
    const { api, removed } = fakeApi([phone]);
    const signedIn = createRemoteDevices({ api, selfKind: "desktop", store, crypto: P });
    await signedIn.pin("m1");

    const { api: anon } = fakeApi([phone], null);
    const d = createRemoteDevices({ api: anon, selfKind: "desktop", store, crypto: P });
    expect(await d.forget("m1")).toBe(false);
    expect(removed).toEqual([]);
    expect(store.peerIdentity()).not.toBeNull();
  });

  // 删库这一步失败时不能先把 pin 清了:那会留下"没配对、也没删掉"的中间态,
  // 用户看见的还是同一行,却已经连不上了
  it("库里删失败 → 抛出去，pin 不动", async () => {
    const store = newStore();
    const phone = phoneRow();
    const { api } = fakeApi([phone]);
    const d = createRemoteDevices({
      api: { ...api, remove: async () => { throw new Error("网络断了"); } },
      selfKind: "desktop", store, crypto: P,
    });
    await d.pin("m1");

    await expect(d.forget("m1")).rejects.toThrow("网络断了");
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
