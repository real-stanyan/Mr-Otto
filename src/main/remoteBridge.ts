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

export type { RemoteTransport };

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
  /** 这一轮结束了(断线/重握手)。上层用它丢掉"手机正在看哪个会话":
      订阅是连接级的,连接没了还接着投影等于替一个不存在的观众干活 */
  onReset?: () => void;
  log?: (m: string) => void;
}): {
  pushFleet(f: IslandFleet): void;
  pushTimeline(sessionId: string, messages: MobileMessage[]): void;
  pushNotice(text: string): void;
  dispose(): void;
} {
  const p = opts.crypto;
  const log = opts.log ?? (() => {});

  let phase: Phase = "handshaking";
  let self: SelfParty | null = null;
  let sealer: ReturnType<typeof createSealer> | null = null;
  let opener: ReturnType<typeof createOpener> | null = null;
  /** 最后一份 fleet。重连后要靠它把快照补推给新的对端 */
  let last: IslandFleet | null = null;
  /** 上一次真正写下去的 fleet 线格式(明文帧,不是密文——密文每次都不同,去重不了) */
  let lastEncoded: string | null = null;
  /** 时间线的去重要和 fleet 分开:两条流各推各的,共用一个基线会互相把对方吞掉 */
  let lastTimeline: string | null = null;

  /** 把这一轮的全部状态清干净。连接断了走这条:不发任何东西,发了也是丢 */
  function resetRound(): void {
    if (phase === "closed") return;
    phase = "handshaking";
    self = null;
    sealer = null;
    opener = null;
    // 新连接 = 新密钥 + 对端是空的。基线不清的话"和上次一样"会把整份快照吞掉
    // (islandBridge 里 helper 重启踩过同一个坑)
    lastEncoded = null;
    lastTimeline = null;
    opts.onReset?.();
  }

  /** 开一轮握手。**唯一的触发者是 onPeer** —— 对端不在场时发 hello 只是喂虚空 */
  function startRound(): void {
    if (phase === "closed") return;
    resetRound();
    // 每连接必须新鲜的 eph/nonceHalf 由 newConnectionParty 现场生成——
    // 手搭字面量会让"忘记换新"变成默认路径而不是需要主动犯的错
    // (同 key 同 nonce 复用 = ChaCha20-Poly1305 机密性和认证性一起崩掉)
    self = newConnectionParty(p, { role: "desktop", deviceId: opts.deviceId, identity: opts.identity });
    opts.transport.send(JSON.stringify(buildHello(p, self)));
  }

  function onHello(line: string): void {
    // 只有 handshaking 阶段收握手包。**这道门挡的是灾难性的 nonce 复用**:
    // ready 之后再收一条 hello,等于攻击者把手机先前那条原样回放(握手包是明文过中继的,
    // 网关运营者手里始终有一份副本)。此时 self.eph / self.nonceHalf 一个都没换过,
    // deriveSession 于是算出**与上一次完全相同**的会话密钥和 nonce 前缀,
    // 而 createSealer 又从 counter=0n 重新起算 —— 同一把 key、同一个 nonce
    // 加密了两段不同明文:c1^c2 = p1^p2 直接还原桌面→手机的明文(会话标题、
    // pendingApproval 的动词/目标/全路径、workspace 路径),而且 Poly1305 的一次性密钥
    // 取自同一个 keystream 块,连该计数器上的帧伪造也一并送出去。
    // 攻击者不需要任何密钥材料,只需要能重放一帧 —— 正是 spec 威胁模型里
    // 「服务器/网络主动篡改运行中的连接 → 签名挡住 ✅」那一行声称挡住的对手。
    //
    // 顺带两条同源缺陷也一起关掉:重开 opener 会把 highest 退回 -1n,
    // 重新打开 sealedStream 严格递增计数器本来封死的上行重放窗口;
    // 而重新派生密钥却不清 lastEncoded,会让重握手后的补推被去重整帧吞掉。
    //
    // 合法的重新握手只有一条路:onPeer → startRound() —— 那里才会
    // 用 newConnectionParty 换一套新鲜的 eph/nonceHalf 并清掉 lastEncoded。
    // 而中继在对端每次 attach(含同角色重连)时都会发 `:peer`,所以手机切后台
    // 回来那条最常见的路径本来就走 startRound,不需要在这儿开后门。
    // 这里只放一道门,不要在这儿长出一套 re-key 协议。
    if (phase !== "handshaking") {
      log("远程桥:已建立会话,忽略这一轮之外的握手包");
      return;
    }
    if (!self) {
      // 还没收到 :peer 就来了握手包。中继保证 :peer 排在对端任何一帧之前,
      // 所以到这儿说明对面不是通过中继来的
      log("远程桥:这一轮还没开始(没收到在场信号),忽略握手包");
      return;
    }
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

  /** 时间线只在对端明确 watch 之后才有内容,所以**不做重连补推**:
      新连接上手机会自己重发 watch(订阅状态归它)。桌面这侧不留隔夜的订阅。 */
  function pushTimeline(sessionId: string, messages: MobileMessage[]): void {
    // 没建立会话就丢掉,但要说一声:上层刚算完一整份时间线,静默丢弃看起来
    // 和"算出来是空的"一模一样
    if (phase !== "ready" || !sealer) return log(`远程桥:会话没建立(${phase}),时间线没发出去`);
    const wire = encodeFrame({ type: "timeline", sessionId, messages });
    if (wire === lastTimeline) return;
    lastTimeline = wire;
    opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(wire))));
  }

  /** 一句给人看的话。**刻意不去重**:两次同样的拒收是两件事,
      第二次被吞掉的话用户会以为第二个文件传上去了 */
  function pushNotice(text: string): void {
    if (phase !== "ready" || !sealer) return log(`远程桥:会话没建立(${phase}),提示没发出去:${text}`);
    const wire = encodeFrame({ type: "notice", text });
    opts.transport.send(b64encode(sealer.seal(new TextEncoder().encode(wire))));
  }

  opts.transport.onMessage((payload) => {
    if (phase === "closed") return;
    // 首字符定型:'{' = 明文握手包,其余 = base64url 密文帧
    if (payload.startsWith("{")) onHello(payload);
    else onSealed(payload);
  });

  opts.transport.onPeer(() => {
    if (phase === "closed") return;
    log("远程桥:对端到场,开一轮握手");
    startRound();
  });

  opts.transport.onClose(() => {
    if (phase === "closed") return;
    log("远程桥:连接断开,等下一条在场信号");
    resetRound();
  });

  return {
    pushFleet,
    pushTimeline,
    pushNotice,
    dispose() {
      phase = "closed";
      sealer = null;
      opener = null;
      opts.transport.close();
    },
  };
}
