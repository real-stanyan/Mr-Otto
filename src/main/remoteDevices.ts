// devices 表这一侧的桌面逻辑:登记自己、列出同账号的手机、pin 住其中一台。
//
// **账号目录不是信任来源。** 按账号配对与 E2E 天然打架(spec 第二节):
// 密钥若从账号体系下发,掌握 Supabase 的人就能发一把假的,中间人当场成立。
// 所以这张表只当"目录"用 —— 它告诉你有哪几台设备、公钥长什么样,
// 而**它说的公钥对不对由人来判断**:两端各显示同一个 6 位安全码,
// 对上了才 pin。pin 之后握手一律只认 pin 住的那把(remoteBridge 的 peerIdentity)。
//
// 因此这里对库里读回来的每一个字段都当外部输入校验:长度不对的公钥不 pin,
// 不是"先 pin 了再说"。

import { b64decode, b64encode } from "../shared/remote/b64.js";
import type { RemoteCryptoPrimitives } from "../shared/remote/crypto.js";
import { fingerprint } from "../shared/remote/handshake.js";
import type { IdentityStore } from "./remoteIdentity.js";

/** devices 表的一行(列名跟 SQL 走,不驼峰化 —— 少一层翻译少一处 drift) */
export interface DeviceRow {
  device_id: string;
  kind: "desktop" | "mobile";
  identity_pub: string;
  kx_pub: string;
  label: string;
  last_seen: string;
}

export interface DevicesApi {
  /** 当前登录用户;没登录回 null */
  userId(): Promise<string | null>;
  upsert(row: Omit<DeviceRow, "last_seen"> & { user_id: string }): Promise<void>;
  list(userId: string): Promise<DeviceRow[]>;
}

/** 设置页要显示的一台手机 */
export interface RemotePeer {
  deviceId: string;
  label: string;
  lastSeen: string;
  /** 6 位安全码。两端各自算,算出来必须一样 —— 这是人能核对的那一环 */
  code: string;
  pinned: boolean;
}

/** 原始公钥就是 32 字节。库里读回来的东西一律先验长度再用 */
const RAW_PUB_BYTES = 32;

function decodePub(s: string): Uint8Array | null {
  const raw = b64decode(s);
  return raw && raw.length === RAW_PUB_BYTES ? raw : null;
}

export function createRemoteDevices(deps: {
  api: DevicesApi;
  store: IdentityStore;
  crypto: RemoteCryptoPrimitives;
  log?: (m: string) => void;
}): {
  registerSelf(label: string): Promise<boolean>;
  listPeers(): Promise<RemotePeer[]>;
  pin(deviceId: string): Promise<boolean>;
} {
  const log = deps.log ?? (() => {});
  const mine = deps.store.identity.publicKey;

  return {
    /** 把自己登记进目录。**只上传公钥** —— 私钥两把都不出系统封装 */
    async registerSelf(label) {
      const uid = await deps.api.userId();
      if (!uid) {
        log("远程设备:还没登录,不登记");
        return false;
      }
      await deps.api.upsert({
        user_id: uid,
        device_id: deps.store.deviceId,
        kind: "desktop",
        identity_pub: b64encode(mine),
        kx_pub: b64encode(deps.store.kx.publicKey),
        label,
      });
      return true;
    },

    async listPeers() {
      const uid = await deps.api.userId();
      if (!uid) return [];
      const pinned = deps.store.peerIdentity();
      const pinnedB64 = pinned ? b64encode(pinned) : null;
      const out: RemotePeer[] = [];
      for (const row of await deps.api.list(uid)) {
        if (row.kind !== "mobile") continue; // 桌面不跟桌面配对
        const pub = decodePub(row.identity_pub);
        if (!pub) {
          // 目录里的坏行不该让整个列表炸掉,也不该被当成一台能配的设备
          log(`远程设备:${row.device_id} 的公钥格式不对,跳过`);
          continue;
        }
        out.push({
          deviceId: row.device_id,
          label: row.label,
          lastSeen: row.last_seen,
          code: fingerprint(deps.crypto, mine, pub),
          pinned: pinnedB64 === row.identity_pub,
        });
      }
      return out;
    },

    /** 用户核对完安全码之后调。覆盖旧的 pin = 换了手机,由调用方先问清楚 */
    async pin(deviceId) {
      const uid = await deps.api.userId();
      if (!uid) return false;
      const row = (await deps.api.list(uid)).find(
        (r) => r.device_id === deviceId && r.kind === "mobile"
      );
      if (!row) {
        log(`远程设备:目录里没有 ${deviceId}`);
        return false;
      }
      const pub = decodePub(row.identity_pub);
      if (!pub) {
        log(`远程设备:${deviceId} 的公钥格式不对,不 pin`);
        return false;
      }
      deps.store.pinPeer(pub);
      return true;
    },
  };
}
