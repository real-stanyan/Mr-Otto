// 盲管道。它做的全部事情:按 user_id 把桌面那一端和手机那一端的字节互转。
//
// 三条它**不做**的事,每一条都是安全性质,不是懒:
//   1. 不解析负载 —— 端到端加密的密文对它就该是不透明字节
//   2. 不落盘 —— 会话内容一个字节都不进库(spec 第一节不变量 3)
//   3. 不打印负载 —— tests/gateway/relay.test.ts 有一条测试专门钉这个,
//      因为"调试时顺手 console.log 一下"是这类系统最常见的泄漏方式
//
// 一户一桌面一手机:同角色重连顶掉旧连接。多设备是后话,现在多开只会让
// "该发给谁"变成一个需要路由的问题,而那不是这一版要解决的。

export type RelayRole = "desktop" | "mobile";

export interface RelaySink {
  write(chunk: string): void;
}

interface UserSlot {
  desktop: RelaySink | null;
  mobile: RelaySink | null;
}

const other = (r: RelayRole): RelayRole => (r === "desktop" ? "mobile" : "desktop");

/** SSE 的一条事件。负载是 base64url 密文,天然没有换行,不用转义 */
const sseEvent = (payload: string): string => `data: ${payload}\n\n`;

/**
 * 在场信号。**这是握手能开始的唯一前提**:握手是双向的,两端都要拿到对方的
 * hello 才能派生会话密钥;而中继不排队(不变量 2),桌面又是长命的那一端 ——
 * 它开机时盲发的 hello 必然掉进虚空,手机几小时后才连上来。
 * 谁到场只有中继同时看得见两个槽的人知道,所以由它说。
 *
 * 走 SSE 注释行(':' 开头)而不是 data 帧:控制信道与端到端载荷彻底分开。
 * 标准 SSE 解析器本来就跳过注释,中继依旧只知道"谁在线",内容一个字节都不碰。
 */
const PEER_PRESENT = ":peer\n\n";

export function createRelay(): {
  attach(userId: string, role: RelayRole, sink: RelaySink): () => void;
  deliver(userId: string, fromRole: RelayRole, payload: string): boolean;
  peerOnline(userId: string, role: RelayRole): boolean;
} {
  const slots = new Map<string, UserSlot>();

  const slotOf = (userId: string): UserSlot => {
    let s = slots.get(userId);
    if (!s) {
      s = { desktop: null, mobile: null };
      slots.set(userId, s);
    }
    return s;
  };

  const gc = (userId: string): void => {
    const s = slots.get(userId);
    if (s && !s.desktop && !s.mobile) slots.delete(userId);
  };

  return {
    attach(userId, role, sink) {
      const s = slotOf(userId);
      s[role] = sink; // 同角色重连顶掉旧的
      const peer = s[other(role)];
      if (peer) {
        // 两侧都通知:新来的那端要知道对端已在,在位的那端要知道该重开一轮。
        // 同角色重连也会再走一遍 —— 手机切后台回来就是这条路径,
        // 旧连接的密钥已经作废,不重开的话桌面会停在 ready 往虚空封帧
        sink.write(PEER_PRESENT);
        peer.write(PEER_PRESENT);
      }
      return () => {
        // 只有还是自己那条连接时才摘 —— 否则"旧连接的清理"会把新连接踢下线
        if (s[role] === sink) s[role] = null;
        gc(userId);
      };
    },

    deliver(userId, fromRole, payload) {
      const peer = slots.get(userId)?.[other(fromRole)];
      if (!peer) return false; // 对端不在线:丢弃,不排队(排队 = 落盘)
      peer.write(sseEvent(payload));
      return true;
    },

    peerOnline(userId, role) {
      return Boolean(slots.get(userId)?.[other(role)]);
    },
  };
}
