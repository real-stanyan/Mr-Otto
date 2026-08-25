// 手机侧的桥。src/main/remoteBridge.ts 的镜像:同一套握手、同一条 `:peer` 起点、
// 同一个"一次连接里 nonce 绝不重复"的纪律,只是方向反过来 ——
// 收 DownFrame(fleet / timeline / ping)、发 UpFrame(五个词)。
//
// 住在 src/shared/remote/ 而不是 mobile/ 里,是为了让它跟着**根门禁**跑:
// 这一层的失败方式是"连上了但解不开",单靠真机点一点根本发现不了。
// 它只依赖 RemoteTransport 接口,不认识 RN 的任何东西。
//
// 纯文件:不许 import node builtin / electron。

import { b64decode, b64encode } from "./b64.js";
import type { KeyPair, RemoteCryptoPrimitives } from "./crypto.js";
import { decodeDownFrame, encodeFrame, type DownFrame, type UpFrame } from "./frames.js";
import {
  buildHello, deriveSession, newConnectionParty,
  type HandshakeHello, type SelfParty,
} from "./handshake.js";
import { createOpener, createSealer } from "./sealedStream.js";
import type { RemoteTransport } from "./transport.js";

type Phase = "handshaking" | "ready" | "closed";

export interface MobileBridge {
  /** 会话没建立时回 false —— 界面据此显示"你的 Mac 不在线",而不是假装发出去了 */
  send(cmd: UpFrame): boolean;
  dispose(): void;
}

export function createMobileBridge(opts: {
  crypto: RemoteCryptoPrimitives;
  identity: KeyPair;
  deviceId: string;
  transport: RemoteTransport;
  /** 已 pin 住的桌面身份公钥。null = 还没配对 → 一律拒绝握手 */
  peerIdentity: () => Uint8Array | null;
  onFrame: (f: DownFrame) => void;
  /** 会话建立/断开。界面用它决定显示内容还是"你的 Mac 不在线" */
  onReady: (ready: boolean) => void;
  log?: (m: string) => void;
}): MobileBridge {
  const p = opts.crypto;
  const log = opts.log ?? (() => {});

  let phase: Phase = "handshaking";
  let self: SelfParty | null = null;
  let sealer: ReturnType<typeof createSealer> | null = null;
  let opener: ReturnType<typeof createOpener> | null = null;

  function resetRound(): void {
    if (phase === "closed") return;
    const wasReady = phase === "ready";
    phase = "handshaking";
    self = null;
    sealer = null;
    opener = null;
    if (wasReady) opts.onReady(false);
  }

  /** 唯一的触发者是 onPeer:对端不在场时发 hello 只是喂虚空(中继不排队) */
  function startRound(): void {
    if (phase === "closed") return;
    resetRound();
    // 每连接必须新鲜的 eph/nonceHalf —— 同 key 同 nonce 复用 =
    // ChaCha20-Poly1305 的机密性和认证性一起崩掉(见 handshake.ts 的注释)
    self = newConnectionParty(p, { role: "mobile", deviceId: opts.deviceId, identity: opts.identity });
    opts.transport.send(JSON.stringify(buildHello(p, self)));
  }

  function onHello(line: string): void {
    // 与桌面侧同一道门,理由也同一条:ready 之后再收 hello 等于让攻击者重放一条
    // 明文握手包,而 self.eph/nonceHalf 一个都没换 —— 会算出同一把密钥和同一条
    // nonce 前缀,而 createSealer 又从 counter=0n 起算。合法的重来只走 onPeer。
    if (phase !== "handshaking") {
      log("手机桥:已建立会话,忽略这一轮之外的握手包");
      return;
    }
    if (!self) {
      log("手机桥:这一轮还没开始(没收到在场信号),忽略握手包");
      return;
    }
    const pinned = opts.peerIdentity();
    if (!pinned) {
      log("手机桥:还没配对过任何电脑,拒绝握手");
      return;
    }
    let hello: HandshakeHello;
    try {
      hello = JSON.parse(line) as HandshakeHello;
    } catch {
      log("手机桥:握手包不是合法 JSON,丢弃");
      return;
    }
    const keys = deriveSession(p, { self, peerHello: hello, peerIdentityPub: pinned });
    if (!keys) {
      // TOFU 报警就在这条路上:公钥对不上就是对不上,不静默接受
      log("手机桥:电脑的身份验不过(公钥 pin 不上 / 签名不对),不建立会话");
      return;
    }
    sealer = createSealer(p, keys.send.key, keys.send.prefix);
    opener = createOpener(p, keys.recv.key, keys.recv.prefix);
    phase = "ready";
    opts.onReady(true);
  }

  function onSealed(payload: string): void {
    if (!opener) return;
    const raw = b64decode(payload);
    if (!raw) return log("手机桥:收到非 base64url 的帧,丢弃");
    const plain = opener.open(raw);
    // 解不开 = 篡改 / 重放 / 迟到。日志里**不带负载**
    if (!plain) return log("手机桥:帧解密或计数器校验失败,丢弃");
    const frame = decodeDownFrame(new TextDecoder().decode(plain));
    if (!frame) return log("手机桥:下行帧形状不认得,整条丢弃");
    opts.onFrame(frame);
  }

  opts.transport.onMessage((payload) => {
    if (phase === "closed") return;
    // 首字符定型:'{' = 明文握手包,其余 = base64url 密文帧
    if (payload.startsWith("{")) onHello(payload);
    else onSealed(payload);
  });

  opts.transport.onPeer(() => {
    if (phase === "closed") return;
    log("手机桥:电脑到场,开一轮握手");
    startRound();
  });

  opts.transport.onClose(() => {
    if (phase === "closed") return;
    log("手机桥:连接断开,等下一条在场信号");
    resetRound();
  });

  return {
    send(cmd) {
      if (phase !== "ready" || !sealer) return false;
      opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(encodeFrame(cmd)))));
      return true;
    },
    dispose() {
      phase = "closed";
      sealer = null;
      opener = null;
      opts.transport.close();
    },
  };
}
