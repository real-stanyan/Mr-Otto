// 盲管道的**纯逻辑**。它做的全部事情:决定这一帧该给谁、新连接该顶掉谁。
//
// 三条它**不做**的事,每一条都是安全性质,不是懒:
//   1. 不解析负载 —— 端到端加密的密文对它就该是不透明字节
//   2. 不落盘 —— 会话内容一个字节都不进库。在 Durable Object 里这条变成字面
//      意义:整个中继一个 storage API 都不调
//   3. 不打印负载 —— tests/edge/relay.test.ts 有一条测试专门钉这个,
//      因为"调试时顺手 console.log 一下"是这类系统最常见的泄漏方式
//
// 为什么是纯函数而不是一个持有状态的对象(ADR-0129):状态归 DO —— 一户一个实例,
// 它自己就是那个"槽",连接由运行时持有(ctx.getWebSockets()),睡醒后还在。
// 逻辑留在这里的好处是这三条不变量的测试不需要 workerd:安全不变量的测试必须
// 便宜到每次提交都跑,绑死在运行时上等于给它加一道门槛。

// 线上约定从 src/shared/remote/wire.ts 来 —— 三方共用一份。各写各的时,
// 一处对不上的表现是"连上了但握手永远开不起来":没有报错,只有一片安静。
export {
  CONTROL_PREFIX,
  MAX_FRAME_BYTES,
  PEER_PRESENT,
  PING,
  PONG,
  SUBPROTOCOL,
  isControl,
} from "../../../src/shared/remote/wire.js";

export type RelayRole = "desktop" | "mobile";

/** 一条连接在纯逻辑眼里的样子。DO 里是 WebSocket + tag,测试里是个记数组的假货 */
export interface RelayPeer {
  role: RelayRole;
  /** 还连着没有。顶掉旧连接是异步的,close() 之后它可能还在 getWebSockets() 里
      逗留一会儿 —— 挑对端时必须绕开那种,否则帧会发给一条正在死的连接 */
  open: boolean;
}

export const otherRole = (r: RelayRole): RelayRole => (r === "desktop" ? "mobile" : "desktop");

export function parseRole(v: string | null): RelayRole | null {
  return v === "desktop" || v === "mobile" ? v : null;
}

/**
 * 这一帧该给谁。找不到 = 对端不在线:**丢弃,不排队**(排队 = 落盘)。
 * 一户一桌面一手机,所以对端最多一条;真出现多条(顶替中的瞬间)取第一条活的。
 */
export function peerOf<T extends RelayPeer>(conns: readonly T[], from: RelayRole): T | undefined {
  const want = otherRole(from);
  return conns.find((c) => c.role === want && c.open);
}

/**
 * 新连接接入时该顶掉哪些。一户一桌面一手机:同角色重连顶掉旧的。
 * 多设备是后话 —— 现在多开只会让"该发给谁"变成一个需要路由的问题(ADR-0128
 * 明确保留「信任多台、同时连一台」;要真正同时在线见 issue #530)。
 */
export function supersededBy<T extends RelayPeer>(conns: readonly T[], role: RelayRole): T[] {
  return conns.filter((c) => c.role === role);
}
