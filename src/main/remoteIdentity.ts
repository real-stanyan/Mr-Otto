// 远程身份的唯一落点:本机长期 Ed25519 身份密钥 + pin 住的对端公钥。
//
// **刻意不用 keyVault.ts。** 那是 0600 明文 JSON —— 对 API key 是既定权衡
// (泄漏了换一把,损失有边界),对身份私钥不够:它是 TOFU 整套信任的根,
// 拿到它就能冒充这台桌面完成握手,而且旧日志里没有任何东西能发现这件事。
// 这里过一层系统封装(macOS 上就是 Keychain 托管的密钥),落盘的是密文。
//
// **封装不可用就回 null,绝不退化成明文落盘。** 一条没有远程功能的桌面是可用的;
// 一条把身份私钥明文写在硬盘上的桌面是不可用的,而且用户看不出区别。
//
// pin 住的对端公钥虽然不是秘密,也放进同一个封装:它不需要保密,但需要**完整性**——
// 能改写 pin 文件的人就能让 TOFU 形同虚设。一个文件一次决定,不留第二条路。
//
// 主进程组装根特权:允许直接摸 fs(工具层的 fs 禁令不覆盖这里,同 keyVault.ts)。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { b64decode, b64encode } from "../shared/remote/b64.js";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";

/** 系统封装。macOS 上由 electron 的 safeStorage 实现(密钥在 Keychain) */
export interface SecretBox {
  /** false = 这台机器没有可用的系统封装(没登录钥匙串 / Linux 上没有 keyring) */
  available(): boolean;
  encrypt(plain: string): Uint8Array;
  /** 解不开就抛 —— 换台机器、换个用户都会走到这条路 */
  decrypt(cipher: Uint8Array): string;
}

interface FsPort {
  read(path: string): Uint8Array | null;
  write(path: string, bytes: Uint8Array): void;
}

/** 封装里的明文形状。版本号在最外层,将来换形状时旧文件仍然认得出来 */
interface Sealed {
  v: 1;
  /** 本机的稳定设备 id。随机生成而不是用路径/主机名:hello 是**明文**过中继的,
      任何有辨识度的东西(用户名、home 路径、机器名)都会当场送给网关运营者 */
  did: string;
  priv: string;
  pub: string;
  /** 推送密钥协商用的静态 X25519(spec 第二节「每台设备两把静态密钥」)。
      与 identity 显式分开而不是做 Ed25519 → X25519 转换:转换能做,
      但两把各司其职不容易出错。公钥两把都进 devices,私钥两把都不出封装 */
  kxPriv: string;
  kxPub: string;
  /** pin 住的对端身份公钥;还没配对过就是 null */
  peer: string | null;
}

export interface IdentityStore {
  identity: KeyPair;
  /** 推送密钥协商用的静态 X25519(plan C 的 NSE 用;公钥现在就要登记进 devices) */
  kx: KeyPair;
  /** 随机设备 id(握手签名里的一项,做反射防护) */
  deviceId: string;
  /** 已 pin 住的对端身份公钥,还没配对过回 null(remoteBridge 的 peerIdentity) */
  peerIdentity(): Uint8Array | null;
  /** TOFU 首次确认之后调一次。覆盖旧的 pin = 用户换了手机,由调用方负责先问 */
  pinPeer(pub: Uint8Array): void;
  /** 解除配对。删设备行时连着走(devices.ts 的 forget) */
  unpinPeer(): void;
}

const realFs: FsPort = {
  read(path) {
    try {
      return readFileSync(path);
    } catch {
      return null; // 没有文件 = 还没配过
    }
  },
  write(path, bytes) {
    mkdirSync(dirname(path), { recursive: true });
    // 内容已经是密文,0600 只是不给旁人省事
    writeFileSync(path, bytes, { mode: 0o600 });
  },
};

function parse(raw: Uint8Array, box: SecretBox): Sealed | null {
  try {
    const s = JSON.parse(box.decrypt(raw)) as Sealed;
    if (s.v !== 1 || typeof s.priv !== "string" || typeof s.pub !== "string") return null;
    if (typeof s.did !== "string" || s.did === "") return null;
    if (typeof s.kxPriv !== "string" || typeof s.kxPub !== "string") return null;
    return s;
  } catch {
    return null; // 解不开 / 不是我们写的 = 当成还没配过
  }
}

export function openIdentityStore(deps: {
  path: string;
  crypto: RemoteCryptoPrimitives;
  box: SecretBox;
  fs?: FsPort;
  log?: (m: string) => void;
}): IdentityStore | null {
  const fs = deps.fs ?? realFs;
  const log = deps.log ?? (() => {});

  if (!deps.box.available()) {
    log("远程身份:这台机器没有可用的系统封装,远程功能不开(不会退化成明文落盘)");
    return null;
  }

  const fresh = (): Sealed => {
    const kp = deps.crypto.generateEd25519();
    const kx = deps.crypto.generateX25519();
    return {
      v: 1,
      did: b64encode(deps.crypto.randomBytes(16)),
      priv: b64encode(kp.privateKey),
      pub: b64encode(kp.publicKey),
      kxPriv: b64encode(kx.privateKey),
      kxPub: b64encode(kx.publicKey),
      peer: null,
    };
  };

  const existing = parse(fs.read(deps.path) ?? new Uint8Array(0), deps.box);
  let state: Sealed = existing ?? (() => {
    log("远程身份:生成新的身份密钥");
    return fresh();
  })();

  if (!b64decode(state.priv) || !b64decode(state.pub) ||
      !b64decode(state.kxPriv) || !b64decode(state.kxPub)) {
    // 封装解开了但内容坏了。重新生成,而不是拿一把半截的身份上线
    log("远程身份:文件内容坏了,重新生成");
    state = fresh();
  }

  const flush = (): void => {
    fs.write(deps.path, deps.box.encrypt(JSON.stringify(state)));
  };
  if (!existing) flush();

  return {
    identity: { privateKey: b64decode(state.priv)!, publicKey: b64decode(state.pub)! },
    kx: { privateKey: b64decode(state.kxPriv)!, publicKey: b64decode(state.kxPub)! },
    deviceId: state.did,
    peerIdentity() {
      return state.peer === null ? null : b64decode(state.peer);
    },
    pinPeer(peerPub) {
      state = { ...state, peer: b64encode(peerPub) };
      flush();
    },
    unpinPeer() {
      state = { ...state, peer: null };
      flush();
    },
  };
}
