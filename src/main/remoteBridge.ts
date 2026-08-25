// 桌面侧的远程中继装配。与 islandBridge.ts 平级:同一个投影源(IslandFleet),
// 同一套"状态下行、命令上行"的契约,只是传输从 stdio 管道换成了隔着公网的
// 加密 SSE + POST。
//
// 传输收窄成 RemoteTransport 接口而不是直接 fetch:单测能塞假连接、零网络
// (同 islandBridge 的 SpawnFn 注入)。真实现(fetch SSE + POST)是一层薄壳,
// 放在装配处,不混进这里的状态机。
//
// 线上两种东西,靠首字符区分,零歧义:
//   握手包 = 明文 JSON,首字符必然 '{'
//   数据帧 = base64url,字母表里没有 '{'
//
// 加密边界:本文件之外只见明文(IslandFleet / UpFrame),
// 本文件之内的 transport 只见 base64url 密文。两侧互不知道对方存在。

import { b64decode, b64encode } from "../shared/remote/b64.js";
import { decodeUpFrame, encodeFrame, type UpFrame } from "../shared/remote/frames.js";
import {
  buildHello, deriveSession, newConnectionParty,
  type HandshakeHello, type SelfParty, type SessionKeys,
} from "../shared/remote/handshake.js";
import { createOpener, createSealer } from "../shared/remote/sealedStream.js";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";
import type { IslandFleet } from "../shared/shellBridge.js";

export interface RemoteTransport {
  /** 发一帧。对端不在线不是错误(网关回 409),由实现自己吞掉——桥不关心 */
  send(payload: string): void;
  onMessage(cb: (payload: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

type Phase = "handshaking" | "ready" | "closed";

export function createRemoteBridge(opts: {
  crypto: RemoteCryptoPrimitives;
  /** 本机身份密钥(私钥来自 Keychain,不是 keyVault.ts 那个明文文件) */
  identity: KeyPair;
  deviceId: string;
  transport: RemoteTransport;
  onCommand: (c: UpFrame) => void;
  /** 已 pin 住的对端身份公钥。null = 还没配对过 → 一律拒绝握手。
      TOFU 的存储与首次确认在调用方,本文件只负责"对不上就不进 ready" */
  peerIdentity: () => Uint8Array | null;
  log?: (m: string) => void;
}): { pushFleet(f: IslandFleet): void; dispose(): void } {
  const p = opts.crypto;
  const log = opts.log ?? (() => {});

  let phase: Phase = "handshaking";
  let self: SelfParty | null = null;
  let sealer: ReturnType<typeof createSealer> | null = null;
  let opener: ReturnType<typeof createOpener> | null = null;
  /** 最后一份 fleet。重连后要靠它把快照补推给新的对端 */
  let last: IslandFleet | null = null;
  /** 上一次真正写下去的线格式(明文帧,不是密文——密文每次都不同,去重不了) */
  let lastEncoded: string | null = null;

  function startHandshake(): void {
    if (phase === "closed") return;
    phase = "handshaking";
    sealer = null;
    opener = null;
    // 新连接 = 新密钥 + 对端是空的。基线不清的话"和上次一样"会把整份快照吞掉
    // (islandBridge 里 helper 重启踩过同一个坑)
    lastEncoded = null;
    // 每连接必须新鲜的 eph/nonceHalf 由 newConnectionParty 现场生成——
    // 手搭字面量会让"忘记换新"变成默认路径而不是需要主动犯的错
    // (同 key 同 nonce 复用 = ChaCha20-Poly1305 机密性和认证性一起崩掉)
    self = newConnectionParty(p, { role: "desktop", deviceId: opts.deviceId, identity: opts.identity });
    opts.transport.send(JSON.stringify(buildHello(p, self)));
  }

  function onHello(line: string): void {
    if (!self) return;
    const pinned = opts.peerIdentity();
    if (!pinned) {
      log("远程桥:还没配对过任何手机,拒绝握手");
      return;
    }
    let hello: HandshakeHello;
    try {
      hello = JSON.parse(line) as HandshakeHello;
    } catch {
      log("远程桥:握手包不是合法 JSON,丢弃");
      return;
    }
    const keys: SessionKeys | null = deriveSession(p, {
      self, peerHello: hello, peerIdentityPub: pinned,
    });
    if (!keys) {
      // 这里包含了 TOFU 报警的那一路:公钥对不上就是对不上,不静默接受
      log("远程桥:对端身份验不过(公钥 pin 不上 / 签名不对),不建立会话");
      return;
    }
    sealer = createSealer(p, keys.send.key, keys.send.prefix);
    opener = createOpener(p, keys.recv.key, keys.recv.prefix);
    phase = "ready";
    if (last) pushFleet(last); // 补推快照:对端是新的,它什么都还没有
  }

  function onSealed(payload: string): void {
    if (!opener) return;
    const raw = b64decode(payload);
    if (!raw) {
      log("远程桥:收到非 base64url 的帧,丢弃");
      return;
    }
    const plain = opener.open(raw);
    if (!plain) {
      // 解不开 = 篡改 / 重放 / 迟到。日志里**不带负载**
      log("远程桥:帧解密或计数器校验失败,丢弃");
      return;
    }
    const cmd = decodeUpFrame(new TextDecoder().decode(plain));
    if (!cmd) {
      log("远程桥:命令不在白名单里,整条丢弃");
      return;
    }
    opts.onCommand(cmd);
  }

  function pushFleet(f: IslandFleet): void {
    last = f;
    if (phase !== "ready" || !sealer) return;
    const wire = encodeFrame({ type: "fleet", fleet: f });
    if (wire === lastEncoded) return;
    lastEncoded = wire;
    opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(wire))));
  }

  opts.transport.onMessage((payload) => {
    if (phase === "closed") return;
    // 首字符定型:'{' = 明文握手包,其余 = base64url 密文帧
    if (payload.startsWith("{")) onHello(payload);
    else onSealed(payload);
  });

  opts.transport.onClose(() => {
    if (phase === "closed") return;
    log("远程桥:连接断开,重新握手");
    startHandshake();
  });

  startHandshake();

  return {
    pushFleet,
    dispose() {
      phase = "closed";
      sealer = null;
      opener = null;
      opts.transport.close();
    },
  };
}
