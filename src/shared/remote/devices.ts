// devices 表这一侧的逻辑:登记自己、列出同账号的**对端**、pin 住其中一台。
//
// **两端共用同一份。** 桌面登记 desktop / 列 mobile,手机反过来 —— 除了角色,
// 该做的检查一模一样。抄两份的话,下面那条"公钥长度不对就不 pin"迟早只剩一份。
// 住在 src/shared/remote/ 而不是 src/main/:手机端 import 的就是这个文件。
//
// **账号目录不是信任来源。** 按账号配对与 E2E 天然打架(spec 第二节):
// 密钥若从账号体系下发,掌握 Supabase 的人就能发一把假的,中间人当场成立。
// 所以这张表只当"目录"用 —— 它告诉你有哪几台设备、公钥长什么样,
// 而**它说的公钥对不对由人来判断**:两端各显示同一个 6 位安全码,
// 对上了才 pin。pin 之后握手一律只认 pin 住的那几把(remoteBridge 的 peerIdentities)。
//
// 因此这里对库里读回来的每一个字段都当外部输入校验:长度不对的公钥不 pin,
// 不是"先 pin 了再说"。

import { b64decode, b64encode } from "./b64.js";
import type { KeyPair, RemoteCryptoPrimitives } from "./crypto.js";
import { fingerprint, type Role } from "./handshake.js";

/** devices 表的一行(列名跟 SQL 走,不驼峰化 —— 少一层翻译少一处 drift) */
export interface DeviceRow {
  device_id: string;
  kind: "desktop" | "mobile";
  identity_pub: string;
  kx_pub: string;
  label: string;
  last_seen: string;
}

/** 这个模块要用到的身份存储那一小块。桌面的 IdentityStore(main/remoteIdentity.ts,
    过 safeStorage)和手机的实现(expo-secure-store)各自满足它 —— 怎么落盘是各自的事,
    这里只要"我的公钥是什么"和"pin 存哪儿" */
export interface PinnedPeerStore {
  identity: KeyPair;
  kx: KeyPair;
  deviceId: string;
  /** 已 pin 住的对端身份公钥,可以有多把;还没配对过 = 空组 */
  peerIdentities(): Uint8Array[];
  /** 加一把。已经在组里就什么也不做 —— 重复配对不该让组里多一份 */
  pinPeer(pub: Uint8Array): void;
  /** 取消其中一台的配对。**删一台设备必须连着它走** —— 目录里的行没了而 pin 还在,
      等于"删掉了但仍然信任",删除这个动作就不再是撤销 */
  unpinPeer(pub: Uint8Array): void;
}

export interface DevicesApi {
  /** 当前登录用户;没登录回 null */
  userId(): Promise<string | null>;
  upsert(row: Omit<DeviceRow, "last_seen"> & { user_id: string }): Promise<void>;
  list(userId: string): Promise<DeviceRow[]>;
  /** 从目录里删掉一行。RLS 只允许删自己名下的(migration 0011 的 devices_delete_own) */
  remove(userId: string, deviceId: string): Promise<void>;
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
  store: PinnedPeerStore;
  crypto: RemoteCryptoPrimitives;
  /** 本机是哪一端。对端就是另一端 —— 桌面不跟桌面配对,手机也不跟手机配 */
  selfKind: Role;
  log?: (m: string) => void;
}): {
  registerSelf(label: string): Promise<boolean>;
  listPeers(): Promise<RemotePeer[]>;
  pin(deviceId: string): Promise<boolean>;
  unpin(deviceId: string): Promise<boolean>;
  forget(deviceId: string): Promise<boolean>;
} {
  const log = deps.log ?? (() => {});
  const mine = deps.store.identity.publicKey;
  const peerKind: Role = deps.selfKind === "desktop" ? "mobile" : "desktop";

  return {
    /** 把自己登记进目录。**只上传公钥** —— 私钥两把都不出各自的系统安全存储 */
    async registerSelf(label) {
      const uid = await deps.api.userId();
      if (!uid) {
        log("远程设备:还没登录,不登记");
        return false;
      }
      await deps.api.upsert({
        user_id: uid,
        device_id: deps.store.deviceId,
        kind: deps.selfKind,
        identity_pub: b64encode(mine),
        kx_pub: b64encode(deps.store.kx.publicKey),
        label,
      });
      return true;
    },

    async listPeers() {
      const uid = await deps.api.userId();
      if (!uid) return [];
      const pinnedB64 = new Set(deps.store.peerIdentities().map(b64encode));
      const out: RemotePeer[] = [];
      for (const row of await deps.api.list(uid)) {
        if (row.kind !== peerKind) continue; // 桌面不跟桌面配对,手机不跟手机配
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
          pinned: pinnedB64.has(row.identity_pub),
        });
      }
      return out;
    },

    /** 用户核对完安全码之后调。**加一台,不动已经配好的那些** ——
        换手机不再需要先解除旧的(而在单值 pin 的年代,这里是一次静默的顶掉) */
    async pin(deviceId) {
      const uid = await deps.api.userId();
      if (!uid) return false;
      const row = (await deps.api.list(uid)).find(
        (r) => r.device_id === deviceId && r.kind === peerKind
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

    /**
     * 只解除配对,**目录行留着**。和 forget 的分工:这台设备还在、以后还想用,
     * 只是现在不想让它连 —— 删了行它下次打开又会重新登记回来,那不是"停用",
     * 是"把列表擦一遍"。停用要能停得住,所以给它自己的动作。
     */
    async unpin(deviceId) {
      const uid = await deps.api.userId();
      if (!uid) return false;
      const row = (await deps.api.list(uid)).find((r) => r.device_id === deviceId);
      const pub = row ? decodePub(row.identity_pub) : null;
      if (!pub) return false;
      deps.store.unpinPeer(pub);
      return true;
    },

    /**
     * 从目录里删掉一台设备。**同一台手机换个安装就是新的一行**(身份存在各自的
     * Keychain 里,按 bundle id 隔离),旧安装卸了之后那行会一直留着 —— 目录里没有
     * 过期这回事,只有删。
     *
     * 删的是**目录行,不是那台设备**:装着的 app 下次打开会重新登记自己,行会回来。
     * 真正被撤销的是信任 —— 删掉的正好是已 pin 的那台时,pin 一起清掉。顺序是
     * 先删行再清 pin:删失败就整个不生效,而不是留下一个"没配对也没删掉"的中间态。
     */
    async forget(deviceId) {
      const uid = await deps.api.userId();
      if (!uid) return false;
      const row = (await deps.api.list(uid)).find((r) => r.device_id === deviceId);
      const pub = row ? decodePub(row.identity_pub) : null;
      await deps.api.remove(uid, deviceId);
      if (pub) {
        log(`远程设备:${deviceId} 删掉了,它那把 pin 一起清掉`);
        deps.store.unpinPeer(pub); // 没配过就是空操作,不用先判断
      }
      return true;
    },
  };
}
