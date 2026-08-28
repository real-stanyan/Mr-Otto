// proxyConnection —— 好友代理的密封连接骨架（issue #622 PR-D1，ADR-0151）。
//
// 把「握手 → 派生会话密钥 → 密封流收发」串成一条给好友代理用的加密连接。
// A 和 B 一对一（一条代理通道就一个好友），不按 cid 多对端——比 remoteBridge
// 那套自远程（手机 fleet/timeline）简单得多。
//
// 与 remoteBridge 的关系：**刻意新写，不重构那份**。remoteBridge 经过真机验证、
// 语义绑死自远程（fleet/timeline/pairing 扫码）；本骨架复用同一份纯逻辑
// （handshake/sealedStream），但帧是代理帧、角色是 host/guest、连接是一对一。
//
// 信任来源：握手时对端身份公钥必须落在「已 pin 的集合」里——和 remoteBridge
// 同一个 TOFU 口径。首次 pin 由邀请码路径建立（proxyInvite + PR-D2 的配对）。
//
// 纯逻辑零 IO：transport/crypto/identity 全注入，假 transport 即可离线测试。

import { b64decode, b64encode } from "../shared/remote/b64.js";
import {
  buildHello, deriveSession, newConnectionParty,
  type HandshakeHello, type Role, type SelfParty,
} from "../shared/remote/handshake.js";
import { createOpener, createSealer } from "../shared/remote/sealedStream.js";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";

type Phase = "idle" | "handshaking" | "ready" | "closed";

export interface ProxyConnectionDeps {
  crypto: RemoteCryptoPrimitives;
  /** 本机身份密钥（host=A / guest=B 各用自己的） */
  identity: KeyPair;
  /** 本机在这条通道里的角色：A=host，B=guest */
  role: Role;
  deviceId: string;
  /** 已 pin 的对端身份公钥集合（A pin B 的、B pin A 的）。空 = 谁都不认 */
  peerIdentities: () => Uint8Array[];
  /** 发送一帧到底层传输（已 base64 的密文 或 明文握手 JSON） */
  send: (payload: string) => void;
  log?: (m: string) => void;
}

export interface ProxyConnection {
  /** 开始一轮握手（传输层报告「对端在场」时调） */
  start(): void;
  /** 喂进一条线上收到的 payload（首字符 '{'=握手包，否则=密封帧） */
  onWire(payload: string): void;
  /** 发一个密封帧（ready 才发得出，否则丢） */
  sendSealed(plainText: string): void;
  /** 注册「收到解出的明文帧」回调 */
  onPlain(cb: (plainText: string) => void): void;
  /** 注册「握手完成、可以收发」回调 */
  onReady(cb: () => void): void;
  /** 当前是否 ready */
  isReady(): boolean;
  close(): void;
}

export function createProxyConnection(deps: ProxyConnectionDeps): ProxyConnection {
  const p = deps.crypto;
  const log = deps.log ?? (() => {});

  let phase: Phase = "idle";
  let self: SelfParty | null = null;
  let sealer: ReturnType<typeof createSealer> | null = null;
  let opener: ReturnType<typeof createOpener> | null = null;
  let lastPeerHello: HandshakeHello | null = null;
  let usedPeerEphs = new Set<string>();
  const MAX_DERIVES = 64;

  const plainCbs: ((t: string) => void)[] = [];
  const readyCbs: (() => void)[] = [];

  function clearSession(): void {
    if (phase === "closed") return;
    phase = "handshaking";
    sealer = null;
    opener = null;
  }

  function adopt(hello: HandshakeHello): void {
    if (!self) return;
    // 逐把 pin 公钥试：验不过 deriveSession 回 null（签名不对/公钥不对）。
    // 「哪把是对的」由密码学回答，不信 hello 自称的 deviceId——与 remoteBridge 同口径
    let keys = null;
    for (const pub of deps.peerIdentities()) {
      keys = deriveSession(p, { self, peerHello: hello, peerIdentityPub: pub });
      if (keys) break;
    }
    if (!keys) {
      log("代理连接:对端身份验不过(公钥 pin 不上/签名不对),不建立会话");
      return;
    }
    usedPeerEphs.add(hello.ephPub);
    lastPeerHello = hello;
    sealer = createSealer(p, keys.send.key, keys.send.prefix);
    opener = createOpener(p, keys.recv.key, keys.recv.prefix);
    phase = "ready";
    log("代理连接:握手完成,通道就绪");
    for (const cb of readyCbs) cb();
  }

  function start(): void {
    if (phase === "closed") return;
    clearSession();
    const carried = lastPeerHello;
    self = newConnectionParty(p, { role: deps.role, deviceId: deps.deviceId, identity: deps.identity });
    usedPeerEphs = new Set();
    deps.send(JSON.stringify(buildHello(p, self)));
    // 对端可能早就 ready 不会再发 hello——拿记住的那份当场重派生（同 remoteBridge）
    if (carried && phase !== "ready") adopt(carried);
  }

  function onHello(line: string): void {
    if (phase === "closed") return;
    let hello: HandshakeHello;
    try {
      hello = JSON.parse(line) as HandshakeHello;
    } catch {
      log("代理连接:握手包不是合法 JSON,丢弃");
      return;
    }
    if (typeof hello?.ephPub !== "string") return;
    // **对端可能比我先 start**：它发的 hello 到我这儿时我还没 start（self 是 null）。
    // 先存下 lastPeerHello——等我 start() 时拿它当场重派生（与 remoteBridge 的
    // 「对端已 ready 不会再发，拿记住的那份重派生」同一条路）。
    if (!self) {
      lastPeerHello = hello;
      return;
    }
    // 同一对 (selfEph, peerEph) 只许派生一次——挡重放（同 key 同 nonce 复用 = 认证性崩）
    if (usedPeerEphs.has(hello.ephPub)) return;
    if (usedPeerEphs.size >= MAX_DERIVES) return;
    adopt(hello);
  }

  function onSealed(payload: string): void {
    if (!opener) return;
    const raw = b64decode(payload);
    if (!raw) return;
    const plain = opener.open(raw);
    if (!plain) {
      log("代理连接:帧解密或计数器校验失败,丢弃");
      return;
    }
    const text = new TextDecoder().decode(plain);
    for (const cb of plainCbs) cb(text);
  }

  return {
    start,
    onWire(payload) {
      if (phase === "closed") return;
      if (payload.startsWith("{")) onHello(payload);
      else onSealed(payload);
    },
    sendSealed(plainText) {
      if (phase !== "ready" || !sealer) return;
      deps.send(b64encode(sealer.seal(new TextEncoder().encode(plainText))));
    },
    onPlain(cb) { plainCbs.push(cb); },
    onReady(cb) { readyCbs.push(cb); },
    isReady() { return phase === "ready"; },
    close() {
      phase = "closed";
      sealer = null;
      opener = null;
    },
  };
}
