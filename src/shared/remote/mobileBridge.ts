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
  /** 已 pin 住的桌面身份公钥,**可能有多把**。空组 = 还没配对 → 一律拒绝握手。
      逐把试:hello 里的 deviceId 由对端自称,不能拿它来挑用哪把验 */
  peerIdentities: () => Uint8Array[];
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
  /** 对端最近一条验过的 hello。**活过自己这一轮** —— 换了自己的 eph 之后要拿它
      当场重新派生:对端可能早就 ready 了,不会为我这一轮再送一次 */
  let lastPeerHello: HandshakeHello | null = null;
  /** 当前这套 self 已经派生过的对端 ephPub。见 onHello 上面那段 */
  let usedPeerEphs = new Set<string>();

  /** 一次连接里最多重新派生这么多次。对端是中继送来的,次数不该由它说了算 */
  const MAX_DERIVES = 64;

  /** 只清这一轮的会话状态。self / lastPeerHello 属于**这条连接**,不在这儿动 */
  function clearSession(): void {
    if (phase === "closed") return;
    const wasReady = phase === "ready";
    phase = "handshaking";
    sealer = null;
    opener = null;
    if (wasReady) opts.onReady(false);
  }

  /** 连接没了:这条连接上的一切都作废,包括记住的那份对端 hello */
  function resetRound(): void {
    clearSession();
    self = null;
    lastPeerHello = null;
    usedPeerEphs = new Set();
  }

  /**
   * 用 (当前 self, 这条 peer hello) 派生并装上密钥。
   * **调用方负责保证这一对没用过** —— 见 onHello。
   */
  function adopt(hello: HandshakeHello): void {
    if (!self) return;
    const pinned = opts.peerIdentities();
    if (pinned.length === 0) return log("手机桥:还没配对过任何电脑,拒绝握手");
    // 逐把试,理由同桌面侧:哪一把对由签名说了算,不由对端自称的 deviceId 说了算
    let keys = null as ReturnType<typeof deriveSession>;
    for (const pub of pinned) {
      keys = deriveSession(p, { self, peerHello: hello, peerIdentityPub: pub });
      if (keys) break;
    }
    if (!keys) {
      // TOFU 报警就在这条路上:公钥对不上就是对不上,不静默接受
      return log("手机桥:电脑的身份验不过(公钥 pin 不上 / 签名不对),不建立会话");
    }
    usedPeerEphs.add(hello.ephPub);
    lastPeerHello = hello;
    sealer = createSealer(p, keys.send.key, keys.send.prefix);
    opener = createOpener(p, keys.recv.key, keys.recv.prefix);
    phase = "ready";
    // 每次派生都报一次 ready:上层据此重发 watch —— 换了密钥之后
    // 桌面那侧的订阅是听不见旧密钥封的帧的
    opts.onReady(true);
  }

  /** 唯一的触发者是 onPeer:对端不在场时发 hello 只是喂虚空(中继不排队) */
  function startRound(): void {
    if (phase === "closed") return;
    clearSession();
    // 每连接必须新鲜的 eph/nonceHalf —— 同 key 同 nonce 复用 =
    // ChaCha20-Poly1305 的机密性和认证性一起崩掉(见 handshake.ts 的注释)
    // 先把上一轮记住的那份接住:下面的 adopt 会覆写 lastPeerHello
    const carried = lastPeerHello;
    self = newConnectionParty(p, { role: "mobile", deviceId: opts.deviceId, identity: opts.identity });
    // self 换了 ⇒ 同一个对端 eph 也会算出一把新钥匙,旧的"用过"名单跟着作废
    usedPeerEphs = new Set();
    opts.transport.send(JSON.stringify(buildHello(p, self)));
    // 对端不会为我这一轮再发一次 hello(它可能早就 ready 了),拿记住的那份当场重派生。
    // **phase 这一问是必须的**:上面那行 send 可能是同步投递的,对端崭新的 hello
    // 说不定已经在里面派生完了 —— 那份比手上这份旧的新,别拿旧的盖回去
    if (carried && phase !== "ready") adopt(carried);
  }

  /**
   * 收到对端的握手包。**规则是"永远用对端最新的那一条",不是"只认第一条"**。
   *
   * 只认第一条会死锁,而且是这条链路上最常见的死法:中继在**任何一端 attach 时
   * 都会给两边各发一次 `:peer`**(relay.ts),而手机重连一次,桌面那侧就会收到
   * 一条 `:peer` 并重开一轮;手机自己那条 `:peer` 却是写给正在被拆掉的旧连接的,
   * 收不到。于是桌面开了两轮(D1、D2)、手机只开了一轮(M1):手机锁死在先到的
   * D1 上,桌面锁死在 M1 + 自己最新的 D2 上。两边都自认为 ready,而每一帧都
   * 解不开 —— 就是真机上那屏"没等到时间线"加满屏"帧解密或计数器校验失败"。
   * 死锁没有出口:不再有 `:peer`,就不再有新的一轮。
   *
   * 改成"取最新"之后两边收敛:各自永远用 (我最新的 self, 对端最新的 hello),
   * 而这两样都会经由有序的中继流告诉对方,最终一定落到同一对上。
   *
   * **那道 phase 门原本挡的东西必须原样挡住**:重放一条 hello 会让
   * deriveSession 用没换过的 self.eph/nonceHalf 算出**同一把密钥和同一条 nonce
   * 前缀**,而 createSealer 又从 counter=0n 起算 —— 同 key 同 nonce 加密两段不同
   * 明文,ChaCha20-Poly1305 的机密性和认证性一起崩(keystream 可还原、Poly1305
   * 一次性密钥可还原)。握手包是明文过中继的,网关运营者手里始终有副本。
   *
   * 换成一道**更准的**门:同一对 (self.eph, peerEph) 只许派生一次。
   * 密钥 = HKDF(x25519(selfEph, peerEph), salt=两半 nonce),所以
   * 「这一对没用过」⇒「这把密钥没用过」⇒ counter 从 0 起算是安全的。
   * 换了 self(startRound)才清空名单 —— 那时 x25519 的另一半也换了。
   *
   * 剩下的余地只有 DoS:中继可以塞旧 hello 逼我们反复重派生。它本来就能直接
   * 丢包,拿不到比这更多的东西;MAX_DERIVES 给它封了顶。
   */
  function onHello(line: string): void {
    if (phase === "closed") return;
    if (!self) {
      log("手机桥:这一轮还没开始(没收到在场信号),忽略握手包");
      return;
    }
    let hello: HandshakeHello;
    try {
      hello = JSON.parse(line) as HandshakeHello;
    } catch {
      log("手机桥:握手包不是合法 JSON,丢弃");
      return;
    }
    // 名单以 ephPub 为键,先确认它真是个字符串再拿去查
    if (typeof hello?.ephPub !== "string") {
      log("手机桥:握手包缺 ephPub,丢弃");
      return;
    }
    if (usedPeerEphs.has(hello.ephPub)) {
      log("手机桥:这条握手包这一轮已经派生过(重放或重复),忽略");
      return;
    }
    if (usedPeerEphs.size >= MAX_DERIVES) {
      log("手机桥:这一轮重新派生的次数到顶了,忽略");
      return;
    }
    adopt(hello);
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
