import { describe, expect, it, vi } from "vitest";
import { openIdentityStore, type SecretBox } from "../../src/main/remoteIdentity.js";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";
import { b64encode } from "../../src/shared/remote/b64.js";

const P = nodeRemoteCrypto();

/** 假的 safeStorage:把明文原样包一层前缀,测试才看得见"到底封没封" */
function fakeBox(available = true, machine = "m1"): SecretBox & { blobs: string[] } {
  const blobs: string[] = [];
  const head = `SEALED:${machine}:`;
  return {
    blobs,
    available: () => available,
    // 不是真加密,但**必须把明文变形**:否则"落盘没有私钥明文"那条断言
    // 会因为假实现是个透传而假红,测不到真正要测的东西
    encrypt(plain) {
      blobs.push(plain);
      return new TextEncoder().encode(head + Buffer.from(plain, "utf8").toString("base64"));
    },
    decrypt(buf) {
      const s = new TextDecoder().decode(buf);
      // 真 safeStorage 也是这个性质:密钥在本机 Keychain 里,换台机器解不开
      if (!s.startsWith(head)) throw new Error("不是这台机器封的");
      return Buffer.from(s.slice(head.length), "base64").toString("utf8");
    },
  };
}

function memFs() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    read: (p: string) => files.get(p) ?? null,
    write: (p: string, b: Uint8Array) => { files.set(p, b); },
  };
}

describe("openIdentityStore", () => {
  it("首次打开生成身份密钥；第二次打开拿到同一把", () => {
    const fs = memFs();
    const box = fakeBox();
    const a = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs });
    const b = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs });
    expect(a).not.toBeNull();
    expect(Array.from(b!.identity.publicKey)).toEqual(Array.from(a!.identity.publicKey));
    expect(Array.from(b!.identity.privateKey)).toEqual(Array.from(a!.identity.privateKey));
  });

  it("落盘的字节里没有私钥明文（这就是不用 keyVault.ts 的全部理由）", () => {
    const fs = memFs();
    const box = fakeBox();
    const s = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    const onDisk = new TextDecoder().decode(fs.files.get("/x/id.bin")!);
    const privB64 = Buffer.from(s.identity.privateKey).toString("base64");
    expect(onDisk).not.toContain(privB64);
    expect(onDisk).not.toContain(Buffer.from(s.identity.privateKey).toString("base64url"));
    expect(box.blobs).toHaveLength(1); // 确实过了封装
  });

  it("系统封装不可用 → 回 null，绝不退化成明文落盘", () => {
    const fs = memFs();
    const box = fakeBox(false);
    const log = vi.fn();
    expect(openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs, log })).toBeNull();
    expect(fs.files.size).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("TOFU：首次没有 pin；pin 一次之后能读回，且换台机器解不开就当没配过", () => {
    const fs = memFs();
    const box = fakeBox();
    const s = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    expect(s.peerIdentities()).toEqual([]);

    const phone = P.generateEd25519();
    s.pinPeer(phone.publicKey);
    expect(s.peerIdentities().map((b) => Array.from(b))).toEqual([Array.from(phone.publicKey)]);

    // 重开一次:pin 要活过重启
    const again = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    expect(again.peerIdentities().map((b) => Array.from(b))).toEqual([Array.from(phone.publicKey)]);

    // 换一台机器(封装打不开)→ 当成还没配过,重新生成,而不是拿一把半截的身份上线
    const otherMachine = openIdentityStore({
      path: "/x/id.bin", crypto: P, box: fakeBox(true, "m2"), fs, log: () => {},
    })!;
    expect(otherMachine.peerIdentities()).toEqual([]);
    expect(Array.from(otherMachine.identity.publicKey))
      .not.toEqual(Array.from(s.identity.publicKey));
  });

  // 单值 pin 的年代,配第二台手机是**静默顶掉**第一台。现在是一组
  it("能同时 pin 住几台；重复 pin 同一台不会在组里多一份", () => {
    const fs = memFs();
    const box = fakeBox();
    const s = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    const a = P.generateEd25519();
    const b = P.generateEd25519();

    s.pinPeer(a.publicKey);
    s.pinPeer(b.publicKey);
    s.pinPeer(a.publicKey); // 再配一次已经配过的
    expect(s.peerIdentities()).toHaveLength(2);

    s.unpinPeer(a.publicKey);
    expect(s.peerIdentities().map((x) => Array.from(x))).toEqual([Array.from(b.publicKey)]);

    // 解除一台没配过的 = 空操作,不该动到别人
    s.unpinPeer(P.generateEd25519().publicKey);
    expect(s.peerIdentities()).toHaveLength(1);

    // 重启后还是这一组
    const again = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    expect(again.peerIdentities().map((x) => Array.from(x))).toEqual([Array.from(b.publicKey)]);
  });

  // v1 文件必须永远读得回来:装了新版就得重新配对一次,是没必要付的代价
  it("v1 的单值 peer 能就地升级成 v2，已配好的那台不用重配", () => {
    const fs = memFs();
    const box = fakeBox();
    const phone = P.generateEd25519();
    const kp = P.generateEd25519();
    const kx = P.generateX25519();
    const v1 = {
      v: 1,
      did: b64encode(P.randomBytes(16)),
      priv: b64encode(kp.privateKey), pub: b64encode(kp.publicKey),
      kxPriv: b64encode(kx.privateKey), kxPub: b64encode(kx.publicKey),
      peer: b64encode(phone.publicKey),
    };
    fs.write("/x/id.bin", box.encrypt(JSON.stringify(v1)));

    const s = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    expect(s.peerIdentities().map((x) => Array.from(x))).toEqual([Array.from(phone.publicKey)]);
    // 身份密钥也得是原来那把,不能顺手重新生成
    expect(Array.from(s.identity.publicKey)).toEqual(Array.from(kp.publicKey));
  });

  it("v1 里没配过的（peer: null）升上来就是空组", () => {
    const fs = memFs();
    const box = fakeBox();
    const kp = P.generateEd25519();
    const kx = P.generateX25519();
    fs.write("/x/id.bin", box.encrypt(JSON.stringify({
      v: 1, did: "d", priv: b64encode(kp.privateKey), pub: b64encode(kp.publicKey),
      kxPriv: b64encode(kx.privateKey), kxPub: b64encode(kx.publicKey), peer: null,
    })));
    const s = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    expect(s.peerIdentities()).toEqual([]);
  });

  it("坏文件不炸：当成还没配过", () => {
    const fs = memFs();
    fs.write("/x/id.bin", new TextEncoder().encode("这不是我们写的东西"));
    const s = openIdentityStore({ path: "/x/id.bin", crypto: P, box: fakeBox(), fs, log: () => {} });
    expect(s).not.toBeNull();
    expect(s!.peerIdentities()).toEqual([]);
  });
});

describe("deviceId", () => {
  it("随机且跨重启稳定；不含任何本机可辨识的东西（hello 是明文过中继的）", () => {
    const fs = memFs();
    const box = fakeBox();
    const a = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    const b = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.deviceId.length).toBeGreaterThan(10);

    const other = openIdentityStore({ path: "/y/id.bin", crypto: P, box, fs })!;
    expect(other.deviceId).not.toBe(a.deviceId);
  });
});

describe("kx（推送用的静态 X25519）", () => {
  it("与 identity 是两把不同的密钥，跨重启稳定，私钥不出封装", () => {
    const fs = memFs();
    const box = fakeBox();
    const a = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    expect(Array.from(a.kx.publicKey)).not.toEqual(Array.from(a.identity.publicKey));
    expect(a.kx.privateKey).toHaveLength(32);

    const b = openIdentityStore({ path: "/x/id.bin", crypto: P, box, fs })!;
    expect(Array.from(b.kx.privateKey)).toEqual(Array.from(a.kx.privateKey));

    const onDisk = new TextDecoder().decode(fs.files.get("/x/id.bin")!);
    expect(onDisk).not.toContain(Buffer.from(a.kx.privateKey).toString("base64url"));
  });
});
