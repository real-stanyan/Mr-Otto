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
import {
  decodeUpFrame, encodeFrame, type MobileMessage, type UpFrame,
} from "../shared/remote/frames.js";
import {
  buildHello, deriveSession, newConnectionParty,
  type HandshakeHello, type SelfParty, type SessionKeys,
} from "../shared/remote/handshake.js";
import { createOpener, createSealer } from "../shared/remote/sealedStream.js";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";
import type { RemoteTransport } from "../shared/remote/transport.js";
import type { IslandFleet } from "../shared/shellBridge.js";
import type { RemoteStats } from "../shared/remote/stats.js";

export type { RemoteTransport };

type Phase = "handshaking" | "ready" | "closed";

export function createRemoteBridge(opts: {
  crypto: RemoteCryptoPrimitives;
  /** 本机身份密钥(私钥来自 Keychain,不是 keyVault.ts 那个明文文件) */
  identity: KeyPair;
  deviceId: string;
  transport: RemoteTransport;
  /** cid = 哪一条手机连接发来的(ADR-0130)。上层据此分开每台手机的订阅 */
  onCommand: (c: UpFrame, cid: string) => void;
  /** 已 pin 住的对端身份公钥,**可能有多把**(用户配了几台手机就有几把)。
      空组 = 还没配对过 → 一律拒绝握手。握手时逐把试:hello 里的 deviceId 是明文、
      由对端自称,拿它来查表等于让对端自己指定用哪把公钥验自己,所以只能挨个验签名。
      TOFU 的存储与首次确认在调用方,本文件只负责"对不上就不进 ready" */
  peerIdentities: () => Uint8Array[];
  /** 这条**连接**没了。上层用它丢掉"手机正在看哪个会话":
      订阅是连接级的,连接没了还接着投影等于替一个不存在的观众干活。
      注意不再包含"重新握手":手机重连时订阅要留着,好在 onRekey 里补推 */
  onReset?: (cid: string) => void;
  /** 重新派生过密钥了(手机重连 / 中继补发在场信号都会走到)。fleet 快照桥自己
      会补推,时间线得上层来 —— 它才知道 watchedSession 和怎么算那份投影 */
  onRekey?: (cid: string) => void;
  /** 一次握手被挡下了(issue #485)。**这里不做节流** —— 传输层是退避重连的,
      每次重连都要重新握手,所以这个回调天然会重复触发;去重是上层的事
      (main/remoteRejections.ts),桥只负责如实报告每一次 */
  onRejected?: (r: { deviceId: string; reason: "unpaired" | "identity-mismatch" }) => void;
  log?: (m: string) => void;
}): {
  /** 广播给每一台连上来的手机:fleet 是所有人共享的那份状态 */
  pushFleet(f: IslandFleet): void;
  /** 只发给订阅了它的那一台。**时间线是每台手机各看各的** ——
      广播等于把 A 正在看的会话推到 B 的屏幕上 */
  pushTimeline(cid: string, sessionId: string, messages: MobileMessage[]): void;
  /** 只发给问的那一台:提示和统计都是"回答某一次操作",不是共享状态 */
  pushNotice(cid: string, text: string): void;
  pushStats(cid: string, stats: RemoteStats): void;
  /** 现在连着几台(诊断用) */
  connected(): string[];
  dispose(): void;
} {
  const p = opts.crypto;
  const log = opts.log ?? (() => {});

  /** 最后一份 fleet。**这是唯一跨连接共享的东西** —— 新连上来的那台要靠它补快照 */
  let last: IslandFleet | null = null;
  let disposed = false;

  /**
   * 一条对端连接的全部状态。原来这些是模块级的变量 —— 一户一手机的年代那样够用,
   * 多台之后每一样都得**按连接各存一份**:密钥是每次握手现协商的,去重基线跟着
   * 密钥走,而"这一轮派生过哪些 eph"更是只对这一条连接有意义。
   * 共用一份的话,第二台连上来会把第一台的密钥顶掉,而第一台毫不知情。
   */
  function makePeer(cid: string) {
  let phase: Phase = "handshaking";
  let self: SelfParty | null = null;
  let sealer: ReturnType<typeof createSealer> | null = null;
  let opener: ReturnType<typeof createOpener> | null = null;
  /** 上一次真正写下去的 fleet 线格式(明文帧,不是密文——密文每次都不同,去重不了) */
  let lastEncoded: string | null = null;
  /** 时间线的去重要和 fleet 分开:两条流各推各的,共用一个基线会互相把对方吞掉 */
  let lastTimeline: string | null = null;

  /** 对端最近一条验过的 hello。**活过自己这一轮** —— 换了自己的 eph 之后要拿它
      当场重新派生:手机可能早就 ready 了,不会为我这一轮再送一次 */
  let lastPeerHello: HandshakeHello | null = null;
  /** 当前这套 self 已经派生过的对端 ephPub。见 onHello 上面那段 */
  let usedPeerEphs = new Set<string>();

  /** 一次连接里最多重新派生这么多次。对端是中继送来的,次数不该由它说了算 */
  const MAX_DERIVES = 64;

  /** 只清这一轮的会话状态。self / lastPeerHello 属于**这条连接**,不在这儿动 */
  function clearSession(): void {
    if (phase === "closed") return;
    phase = "handshaking";
    sealer = null;
    opener = null;
  }

  /** 连接断了:这条连接上的一切都作废。**onReset 只在这条路上发** ——
      手机重连不再让桌面忘掉"它在看哪个会话":那份订阅正是重新派生之后要补推的东西 */
  function resetRound(): void {
    if (phase === "closed") return;
    clearSession();
    self = null;
    lastPeerHello = null;
    usedPeerEphs = new Set();
    // 新连接 = 新密钥 + 对端是空的。基线不清的话"和上次一样"会把整份快照吞掉
    // (islandBridge 里 helper 重启踩过同一个坑)
    lastEncoded = null;
    lastTimeline = null;
    opts.onReset?.(cid);
  }

  /**
   * 用 (当前 self, 这条 peer hello) 派生并装上密钥。
   * **调用方负责保证这一对没用过** —— 见 onHello。
   */
  function adopt(hello: HandshakeHello): void {
    if (!self) return;
    const pinned = opts.peerIdentities();
    if (pinned.length === 0) {
      log("远程桥:还没配对过任何手机,拒绝握手");
      opts.onRejected?.({ deviceId: hello.deviceId, reason: "unpaired" });
      return;
    }
    // 逐把试。deriveSession 里就带了签名校验,验不过回 null —— 所以"哪一把是对的"
    // 由密码学回答,而不是由 hello 里那个对端自称的 deviceId 回答
    let keys: SessionKeys | null = null;
    for (const pub of pinned) {
      keys = deriveSession(p, { self, peerHello: hello, peerIdentityPub: pub });
      if (keys) break;
    }
    if (!keys) {
      // 这里包含了 TOFU 报警的那一路:公钥对不上就是对不上,不静默接受
      log("远程桥:对端身份验不过(公钥 pin 不上 / 签名不对),不建立会话");
      opts.onRejected?.({ deviceId: hello.deviceId, reason: "identity-mismatch" });
      return;
    }
    usedPeerEphs.add(hello.ephPub);
    lastPeerHello = hello;
    sealer = createSealer(p, keys.send.key, keys.send.prefix);
    opener = createOpener(p, keys.recv.key, keys.recv.prefix);
    phase = "ready";
    // 换了密钥 = 对端手里什么都没有,去重基线必须跟着清,否则"和上次一样"会把补推吞掉
    lastEncoded = null;
    lastTimeline = null;
    if (last) pushFleet(last); // 补推快照:对端是新的,它什么都还没有
    opts.onRekey?.(cid);       // 上层据此把时间线也补一份(订阅还在,见 resetRound)
  }

  /** 开一轮握手。**唯一的触发者是 onPeer** —— 对端不在场时发 hello 只是喂虚空 */
  function startRound(): void {
    if (phase === "closed") return;
    clearSession();
    // 每连接必须新鲜的 eph/nonceHalf 由 newConnectionParty 现场生成——
    // 手搭字面量会让"忘记换新"变成默认路径而不是需要主动犯的错
    // (同 key 同 nonce 复用 = ChaCha20-Poly1305 机密性和认证性一起崩掉)
    // 先把上一轮记住的那份接住:下面的 adopt 会覆写 lastPeerHello
    const carried = lastPeerHello;
    self = newConnectionParty(p, { role: "desktop", deviceId: opts.deviceId, identity: opts.identity });
    // self 换了 ⇒ 同一个对端 eph 也会算出一把新钥匙,旧的"用过"名单跟着作废
    usedPeerEphs = new Set();
    opts.transport.send(JSON.stringify(buildHello(p, self)), cid);
    // 对端不会为我这一轮再发一次 hello(它可能早就 ready 了),拿记住的那份当场重派生。
    // **phase 这一问是必须的**:上面那行 send 可能是同步投递的,对端崭新的 hello
    // 说不定已经在里面派生完了 —— 那份比手上这份旧的新,别拿旧的盖回去
    if (carried && phase !== "ready") adopt(carried);
  }

  /**
   * 收到对端的握手包。**规则是"永远用对端最新的那一条",不是"只认第一条"**。
   *
   * 只认第一条会死锁,而且是这条链路上最常见的死法:中继在**任何一端 attach 时
   * 都会给两边各发一次 `:peer`**(services/edge/src/relay.ts)。手机重连一次,
   * 桌面这侧就收到一条 `:peer` 并重开一轮;手机自己那条 `:peer` 却写给了正在被
   * 拆掉的旧连接,收不到。于是桌面开了两轮(D1、D2)、手机只开了一轮(M1):
   * 手机锁死在先到的 D1 上,桌面停在 (D2, M1)。两边都自认为 ready,而每一帧都
   * 解不开 —— 真机上就是那屏"没等到时间线"配一串"帧解密或计数器校验失败"。
   * 而且没有出口:不再有 `:peer` 就不再有新的一轮。
   *
   * 改成"取最新"之后两边收敛:各自永远用 (我最新的 self, 对端最新的 hello),
   * 这两样都会经由有序的中继流告诉对方,最终一定落到同一对上。
   *
   * **原来那道 phase 门挡的东西必须原样挡住。** 重放一条 hello(握手包是明文过
   * 中继的,网关运营者手里始终有副本)会让 deriveSession 用没换过的
   * self.eph/nonceHalf 算出**同一把密钥和同一条 nonce 前缀**,而 createSealer 又
   * 从 counter=0n 重新起算 —— 同 key 同 nonce 加密了两段不同明文:
   * c1^c2 = p1^p2 直接还原桌面→手机的明文(会话标题、pendingApproval 的动词/
   * 目标/全路径、workspace 路径),而且 Poly1305 的一次性密钥取自同一个 keystream
   * 块,连该计数器上的帧伪造也一并送出去。攻击者不需要任何密钥材料,只需要能
   * 重放一帧 —— 正是 spec 威胁模型里「服务器/网络主动篡改运行中的连接」那一行。
   *
   * 换成一道**更准的**门:同一对 (self.eph, peerEph) 只许派生一次。
   * 密钥 = HKDF(x25519(selfEph, peerEph), salt=两半 nonce),于是
   * 「这一对没用过」⇒「这把密钥没用过」⇒ counter 从 0 起算是安全的。
   * 只有 startRound 换掉 self 时才清空名单 —— 那时 x25519 的另一半也换了。
   * 顺带:opener 每次跟着换,严格递增计数器守的是**当前这把密钥**下的重放,
   * 换密钥之后旧帧根本解不开,那扇窗没有被重新打开。
   *
   * 剩下的余地只有 DoS:中继可以塞旧 hello 逼两端反复重派生。它本来就能直接
   * 丢包,拿不到比这更多的东西;MAX_DERIVES 给它封了顶。
   */
  function onHello(line: string): void {
    if (phase === "closed") return;
    if (!self) {
      // 还没收到 :peer 就来了握手包。中继保证 :peer 排在对端任何一帧之前,
      // 所以到这儿说明对面不是通过中继来的
      log("远程桥:这一轮还没开始(没收到在场信号),忽略握手包");
      return;
    }
    let hello: HandshakeHello;
    try {
      hello = JSON.parse(line) as HandshakeHello;
    } catch {
      log("远程桥:握手包不是合法 JSON,丢弃");
      return;
    }
    // 名单以 ephPub 为键,先确认它真是个字符串再拿去查
    if (typeof hello?.ephPub !== "string") {
      log("远程桥:握手包缺 ephPub,丢弃");
      return;
    }
    if (usedPeerEphs.has(hello.ephPub)) {
      log("远程桥:这条握手包这一轮已经派生过(重放或重复),忽略");
      return;
    }
    if (usedPeerEphs.size >= MAX_DERIVES) {
      log("远程桥:这一轮重新派生的次数到顶了,忽略");
      return;
    }
    adopt(hello);
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
    opts.onCommand(cmd, cid);
  }

  function pushFleet(f: IslandFleet): void {
    if (phase !== "ready" || !sealer) return;
    const wire = encodeFrame({ type: "fleet", fleet: f });
    if (wire === lastEncoded) return;
    lastEncoded = wire;
    opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(wire))), cid);
  }

  /** 时间线只在对端明确 watch 之后才有内容,所以**不做重连补推**:
      新连接上手机会自己重发 watch(订阅状态归它)。桌面这侧不留隔夜的订阅。 */
  function pushTimeline(sessionId: string, messages: MobileMessage[]): void {
    // 没建立会话就丢掉,但要说一声:上层刚算完一整份时间线,静默丢弃看起来
    // 和"算出来是空的"一模一样
    if (phase !== "ready" || !sealer) return log(`远程桥:会话没建立(${phase}),时间线没发出去`);
    const wire = encodeFrame({ type: "timeline", sessionId, messages });
    if (wire === lastTimeline) return;
    lastTimeline = wire;
    opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(wire))), cid);
  }

  /** 设置页那份统计。**刻意不去重**:手机是主动问的,问一次就该答一次 ——
      "和上次一样"在这里不是可以省掉的理由,那一屏正等着这个回答 */
  function pushStats(stats: RemoteStats): void {
    if (phase !== "ready" || !sealer) return log(`远程桥:会话没建立(${phase}),统计没发出去`);
    const wire = encodeFrame({ type: "stats", stats });
    opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(wire))), cid);
  }

  /** 一句给人看的话。**刻意不去重**:两次同样的拒收是两件事,
      第二次被吞掉的话用户会以为第二个文件传上去了 */
  function pushNotice(text: string): void {
    if (phase !== "ready" || !sealer) return log(`远程桥:会话没建立(${phase}),提示没发出去:${text}`);
    const wire = encodeFrame({ type: "notice", text });
    opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(wire))), cid);
  }

  return {
    onWire(payload: string): void {
      if (phase === "closed") return;
      // 首字符定型:'{' = 明文握手包,其余 = base64url 密文帧
      if (payload.startsWith("{")) onHello(payload);
      else onSealed(payload);
    },
    startRound,
    resetRound,
    pushFleet,
    pushTimeline,
    pushNotice,
    pushStats,
    close(): void {
      phase = "closed";
      sealer = null;
      opener = null;
    },
  };
  }

  type Peer = ReturnType<typeof makePeer>;
  /** 每条对端连接一个,键是中继编的 cid */
  const peers = new Map<string, Peer>();

  const peerFor = (cid: string): Peer => {
    let x = peers.get(cid);
    if (!x) {
      x = makePeer(cid);
      peers.set(cid, x);
    }
    return x;
  };

  opts.transport.onMessage((payload, from) => {
    if (disposed) return;
    // from 空串 = 老中继(不带发件人)。那种中继下对端只可能有一条,
    // 唯一那条就是发件人;一条都没有时丢掉——没有可以猜的余地
    if (from === "") {
      if (peers.size !== 1) return log("远程桥:老中继下收到帧但对端不止一条,丢弃");
      [...peers.values()][0]!.onWire(payload);
      return;
    }
    const peer = peers.get(from);
    // 没见过的 cid:中继保证 :peer 排在对端任何一帧之前,所以到这儿说明
    // 要么对面不是通过中继来的,要么我们漏了一条在场信号。不凭空建会话
    if (!peer) return log("远程桥:帧来自没打过招呼的连接,丢弃");
    peer.onWire(payload);
  });

  opts.transport.onPeer((cid) => {
    if (disposed) return;
    log(`远程桥:对端到场(${cid || "老中继"}),开一轮握手`);
    peerFor(cid).startRound();
  });

  opts.transport.onGone((cid) => {
    if (disposed) return;
    log(`远程桥:对端 ${cid} 离场,丢掉它那套会话`);
    const peer = peers.get(cid);
    if (!peer) return;
    peer.close();
    peers.delete(cid);
    // 那台手机的订阅跟着走。**必须在这儿发** —— 它不会再有 onClose 了
    opts.onReset?.(cid);
  });

  opts.transport.onClose(() => {
    if (disposed) return;
    log("远程桥:连接断开,等下一条在场信号");
    // 自己这条流断了 ⇒ 所有对端连接上的密钥都作废。**不删 peers**:
    // 重连后中继会重新announce 每一条,那时按 cid 认回来
    for (const peer of peers.values()) peer.resetRound();
  });

  return {
    pushFleet(f) {
      last = f;
      for (const peer of peers.values()) peer.pushFleet(f);
    },
    pushTimeline(cid, sessionId, messages) {
      peers.get(cid)?.pushTimeline(sessionId, messages);
    },
    pushNotice(cid, text) {
      peers.get(cid)?.pushNotice(text);
    },
    pushStats(cid, stats) {
      peers.get(cid)?.pushStats(stats);
    },
    connected() {
      return [...peers.keys()];
    },
    dispose() {
      disposed = true;
      for (const peer of peers.values()) peer.close();
      peers.clear();
      opts.transport.close();
    },
  };
}
