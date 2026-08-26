// 盲管道的**纯逻辑**。它做的全部事情:在同一户的几条连接里,决定这一帧该塞进
// 哪根管子、新连接该通知谁、断的那条该向谁报丧。
//
// 三条它**不做**的事,每一条都是安全性质,不是懒:
//   1. 不解析负载 —— 端到端加密的密文对它就该是不透明字节
//   2. 不落盘 —— 会话内容一个字节都不进库。在 Durable Object 里这条变成字面
//      意义:整个中继一个 storage API 都不调
//   3. 不打印负载 —— tests/edge/relay.test.ts 有一条测试专门钉这个,
//      因为"调试时顺手 console.log 一下"是这类系统最常见的泄漏方式
//
// **一户多连接,按 cid 寻址**(ADR-0130)。为什么必须寻址而不是广播:每条连接
// 有自己一套会话密钥,广播过去的帧在别人那儿解不开,而 sealedStream 还带
// 计数器校验 —— 收到别人的帧会被判成异常而不是无害的噪音。
//
// 为什么是纯函数而不是一个持有状态的对象(ADR-0129):状态归 DO —— 一户一个实例,
// 连接由运行时持有(ctx.getWebSockets()),睡醒后还在,cid 存在 tag 里。
// 逻辑留在这里的好处是这三条不变量的测试不需要 workerd:安全不变量的测试必须
// 便宜到每次提交都跑,绑死在运行时上等于给它加一道门槛。

// 线上约定从 src/shared/remote/wire.ts 来 —— 三方共用一份。各写各的时,
// 一处对不上的表现是"连上了但握手永远开不起来":没有报错,只有一片安静。
export {
  CONTROL_PREFIX,
  CTRL_CID,
  CTRL_GONE,
  CTRL_PEER,
  CTRL_PING,
  CTRL_PONG,
  MAX_CONNS_PER_USER,
  MAX_FRAME_BYTES,
  SUBPROTOCOL,
  decodeFrame,
  encodeFrame,
  isControl,
  newCid,
  parseControl,
} from "../../../src/shared/remote/wire.js";

export type RelayRole = "desktop" | "mobile";

/** 一条连接在纯逻辑眼里的样子。DO 里是 WebSocket + 两个 tag,测试里是个假货 */
export interface RelayPeer {
  cid: string;
  role: RelayRole;
  /** 还连着没有。close() 之后连接可能还在 getWebSockets() 里逗留一会儿 ——
      挑收件人时必须绕开那种,否则帧会发给一条正在死的连接 */
  open: boolean;
}

export const otherRole = (r: RelayRole): RelayRole => (r === "desktop" ? "mobile" : "desktop");

export function parseRole(v: string | null): RelayRole | null {
  return v === "desktop" || v === "mobile" ? v : null;
}

/**
 * 对端那一侧还活着的连接。**只认对端角色** —— 同角色之间不该能互相发东西
 * (桌面发给另一台桌面在这套协议里没有意义,而它会让"我在跟谁说话"多一种可能性)。
 */
export function peersOf<T extends RelayPeer>(conns: readonly T[], from: RelayRole): T[] {
  const want = otherRole(from);
  return conns.filter((c) => c.role === want && c.open);
}

/**
 * 这一帧该塞给谁。**必须指名**:对端有好几条而 to 认不出时丢弃 ——
 * 猜一条发过去,收到的那端解不开,而发的那端以为发成功了,最难查的那种。
 */
export function targetOf<T extends RelayPeer>(
  conns: readonly T[],
  from: RelayRole,
  to: string
): T | undefined {
  return peersOf(conns, from).find((c) => c.cid === to);
}
