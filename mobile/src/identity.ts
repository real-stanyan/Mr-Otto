// 手机端的身份存储 —— src/main/remoteIdentity.ts 的对应物,同一个 PinnedPeerStore 契约。
//
// 私钥进 **expo-secure-store**(iOS Keychain / Android Keystore),不是 AsyncStorage:
// 后者是明文文件。身份私钥是 TOFU 整套信任的根,拿到它就能冒充这台手机。
//
// SecureStore 单条 2KB 上限,我们这份(两把私钥 + 两把公钥 + deviceId + pin,
// 全是 base64url)几百字节,够用。
//
// 与桌面的一处**刻意不同**:桌面在系统封装不可用时回 null(宁可不开远程也不明文落盘)。
// SecureStore 在 iOS 上没有"不可用"这个状态,所以这里没有那条分支;真读写失败会抛,
// 由调用方当作"这台机器上开不起来"处理。

import * as SecureStore from "expo-secure-store";
import { b64decode, b64encode } from "../../src/shared/remote/b64.js";
import type { RemoteCryptoPrimitives } from "../../src/shared/remote/crypto.js";
import type { PinnedPeerStore } from "../../src/shared/remote/devices.js";

const KEY = "otto.remote.identity.v1";

/**
 * 封装里的形状。**v1 必须永远读得回来** —— v1 的 `peer: string | null` 只装得下
 * 一台电脑,v2 换成 `peers[]`。读到 v1 就地升级(有值就是只有一个元素的组),
 * 已配好的那台不用重配;写出去一律 v2。
 */
interface Sealed {
  v: 2;
  did: string;
  priv: string;
  pub: string;
  kxPriv: string;
  kxPub: string;
  peers: string[];
}

type SealedOnDisk =
  | (Omit<Sealed, "v" | "peers"> & { v: 1; peer: string | null })
  | Sealed;

function fresh(p: RemoteCryptoPrimitives): Sealed {
  const id = p.generateEd25519();
  const kx = p.generateX25519();
  return {
    v: 2,
    // 随机而不是设备名:hello 是**明文**过中继的,任何有辨识度的东西
    // 都会当场送给网关运营者(同桌面侧 deviceId 的理由)
    did: b64encode(p.randomBytes(16)),
    priv: b64encode(id.privateKey),
    pub: b64encode(id.publicKey),
    kxPriv: b64encode(kx.privateKey),
    kxPub: b64encode(kx.publicKey),
    peers: [],
  };
}

function parse(raw: string | null): Sealed | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as SealedOnDisk;
    if (s.v !== 1 && s.v !== 2) return null;
    for (const f of [s.did, s.priv, s.pub, s.kxPriv, s.kxPub]) {
      if (typeof f !== "string" || !b64decode(f)) return null;
    }
    if (s.v === 1) {
      const { peer, ...rest } = s;
      return { ...rest, v: 2, peers: peer === null ? [] : [peer] };
    }
    // 组里混进非字符串就整条当坏的:pin 是信任根,宁可当成没配过也不带着半截上线
    if (!Array.isArray(s.peers) || s.peers.some((x) => typeof x !== "string")) return null;
    return s;
  } catch {
    return null; // 坏内容 = 当成还没有,重新生成
  }
}

export async function openIdentity(p: RemoteCryptoPrimitives): Promise<PinnedPeerStore> {
  const existing = parse(await SecureStore.getItemAsync(KEY));
  let state: Sealed = existing ?? fresh(p);
  const flush = async (): Promise<void> => {
    await SecureStore.setItemAsync(KEY, JSON.stringify(state));
  };
  if (!existing) await flush();

  return {
    identity: { privateKey: b64decode(state.priv)!, publicKey: b64decode(state.pub)! },
    kx: { privateKey: b64decode(state.kxPriv)!, publicKey: b64decode(state.kxPub)! },
    deviceId: state.did,
    peerIdentities: () =>
      state.peers.map((s) => b64decode(s)).filter((b): b is Uint8Array => b !== null),
    pinPeer(pub) {
      const b64 = b64encode(pub);
      if (state.peers.includes(b64)) return;
      state = { ...state, peers: [...state.peers, b64] };
      void flush();
    },
    unpinPeer(pub) {
      const b64 = b64encode(pub);
      if (!state.peers.includes(b64)) return;
      state = { ...state, peers: state.peers.filter((x) => x !== b64) };
      void flush();
    },
  };
}
