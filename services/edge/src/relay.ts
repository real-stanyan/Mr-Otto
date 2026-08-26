// 盲管道。它做的全部事情:按 user_id 把同一个账号下的几条连接的字节互转。
//
// 三条它**不做**的事,每一条都是安全性质,不是懒:
//   1. 不解析负载 —— 端到端加密的密文对它就该是不透明字节
//   2. 不落盘 —— 会话内容一个字节都不进库(spec 第一节不变量 3)
//   3. 不打印负载 —— tests/edge/relay.test.ts 有一条测试专门钉这个,
//      因为"调试时顺手 console.log 一下"是这类系统最常见的泄漏方式
//
// **一户多连接,按 cid 寻址**(ADR-0130,推翻原来的"一户一桌面一手机")。
// 每条连接分一个随机 cid,中继把它告诉自己(`:cid`)、把对端的告诉对端(`:peer`)。
// 发送方在 POST 上带 `to=<cid>` 指定发给谁 —— 中继仍然不知道内容是什么,
// 只知道"这一份字节该塞进哪根管子"。
//
// 为什么必须寻址而不是广播:每条连接有自己的一套会话密钥(每次握手现协商),
// 广播过去的帧在别人那儿解不开,而 sealedStream 还带计数器校验 ——
// 收到别人的帧不只是浪费,是会把自己那条流的计数器判成异常。
//
// **老客户端不能被这次改动打死。** 装在别人机器上的旧版本只认裸 `:peer`、
// POST 不带 to。所以:裸 `:peer` 照发一条(旧客户端靠它开握手),to 缺席时
// 退回"对端只有一条就发给它"。新客户端认 `:cid` —— 收到过它就知道对面是新中继,
// 于是忽略裸 `:peer`,只按 `:peer <cid>` 走。

export type RelayRole = "desktop" | "mobile";

export interface RelaySink {
  write(chunk: string): void;
}

interface Conn {
  cid: string;
  role: RelayRole;
  sink: RelaySink;
  /** 这条连接认不认寻址那一套(attach 时声明 v=2)。**决定它收到的字节长什么样**:
      认的加一行 `event: <发件人 cid>`,不认的收到和从前逐字节一样的 `data:` 一行。
      不能"反正都发,老客户端会跳过" —— 老解析器是整块前缀匹配的,
      两行的事件它会整条丢掉,表现是连上了但一帧都收不到 */
  addressed: boolean;
}

const other = (r: RelayRole): RelayRole => (r === "desktop" ? "mobile" : "desktop");

/** SSE 的一条事件。负载是 base64url 密文,天然没有换行,不用转义 */
const sseEvent = (payload: string): string => `data: ${payload}\n\n`;
/** 带发件人的那一版。桌面接着几台手机时,不知道是谁发的就不知道用哪套密钥解 */
const sseEventFrom = (from: string, payload: string): string =>
  `event: ${from}\ndata: ${payload}\n\n`;

/**
 * 在场信号。**这是握手能开始的唯一前提**:握手是双向的,两端都要拿到对方的
 * hello 才能派生会话密钥;而中继不排队(不变量 2),桌面又是长命的那一端 ——
 * 它开机时盲发的 hello 必然掉进虚空,手机几小时后才连上来。
 * 谁到场只有中继同时看得见所有连接的人知道,所以由它说。
 *
 * 走 SSE 注释行(':' 开头)而不是 data 帧:控制信道与端到端载荷彻底分开。
 * 标准 SSE 解析器本来就跳过注释,中继依旧只知道"谁在线",内容一个字节都不碰。
 *
 * cid 跟在后面。**它是中继编的,不是设备自称的** —— 端到端身份仍然只由
 * 握手里的签名决定,cid 只回答"这份字节塞哪根管子"。
 */
const PEER_PRESENT = ":peer\n\n";
const peerPresent = (cid: string): string => `:peer ${cid}\n\n`;
/** 对端那条连接没了。收到它就把对应的那套会话密钥丢掉,别再往一根断管子里封帧 */
const peerGone = (cid: string): string => `:gone ${cid}\n\n`;
const myCid = (cid: string): string => `:cid ${cid}\n\n`;

/** 同一户里最多几条连接。挡的是内存,不是"不合法" —— 一个账号真开这么多端是异常 */
const MAX_CONNS_PER_USER = 16;

export function createRelay(deps?: { newCid?: () => string }): {
  attach(
    userId: string, role: RelayRole, sink: RelaySink, opts?: { addressed?: boolean }
  ): (() => void) | null;
  deliver(
    userId: string, fromRole: RelayRole, payload: string, opts?: { to?: string; from?: string }
  ): boolean;
  peerOnline(userId: string, role: RelayRole): boolean;
} {
  const users = new Map<string, Map<string, Conn>>();
  let seq = 0;
  // 默认实现不用 crypto:cid 不是秘密,它只是"这一户里的第几根管子"。
  // 猜到别人的 cid 也发不进去 —— deliver 只往**对端角色**的连接写,
  // 而真正的门是握手签名(cid 冒充不了身份)
  const newCid = deps?.newCid ?? (() => `c${++seq}`);

  const connsOf = (userId: string): Map<string, Conn> => {
    let m = users.get(userId);
    if (!m) {
      m = new Map();
      users.set(userId, m);
    }
    return m;
  };

  const peersOf = (m: Map<string, Conn>, role: RelayRole): Conn[] =>
    [...m.values()].filter((c) => c.role === other(role));

  return {
    /** 满了回 null(调用方转成 503);否则回 detach */
    attach(userId, role, sink, opts) {
      const m = connsOf(userId);
      if (m.size >= MAX_CONNS_PER_USER) return null;
      const cid = newCid();
      const me: Conn = { cid, role, sink, addressed: opts?.addressed === true };
      m.set(cid, me);

      // 先告诉它自己是谁 —— 这条同时是"对面是新中继"的信号
      sink.write(myCid(cid));
      const peers = peersOf(m, role);
      if (peers.length > 0) {
        // 裸的那条只发一次:旧客户端靠它开握手,而它不带信息,发 N 条没有意义
        sink.write(PEER_PRESENT);
        for (const p of peers) {
          // 两侧都通知:新来的要知道对端有哪几条,在位的要知道该跟这条新的开一轮。
          // 同角色重连也会走一遍(手机切后台回来就是这条路径),旧连接那套密钥
          // 已经作废,不重开的话对端会停在 ready 往虚空封帧
          sink.write(peerPresent(p.cid));
          p.sink.write(PEER_PRESENT);
          p.sink.write(peerPresent(cid));
        }
      }
      return () => {
        // 只有还是自己那条连接时才摘 —— 否则"旧连接的清理"会把新连接踢下线
        if (m.get(cid) !== me) return;
        m.delete(cid);
        for (const p of peersOf(m, role)) p.sink.write(peerGone(cid));
        if (m.size === 0) users.delete(userId);
      };
    },

    /**
     * 转一帧。`to` 指定塞给哪条连接;缺席时退回"对端只有一条就发给它"
     * —— 那是老客户端(不认 cid)唯一能走的路。对端有好几条而 to 缺席时**丢弃**:
     * 猜一条发过去,收到的那端解不开,而发的那端以为发成功了,最难查的那种。
     */
    deliver(userId, fromRole, payload, opts) {
      const m = users.get(userId);
      if (!m) return false;
      const peers = peersOf(m, fromRole);
      if (peers.length === 0) return false; // 对端不在线:丢弃,不排队(排队 = 落盘)
      const write = (c: Conn): void => {
        c.sink.write(
          c.addressed && opts?.from ? sseEventFrom(opts.from, payload) : sseEvent(payload)
        );
      };
      const to = opts?.to;
      if (to === undefined) {
        if (peers.length !== 1) return false;
        write(peers[0]!);
        return true;
      }
      // 只认对端角色的连接:同角色之间不该能互相发东西(桌面发给另一台桌面
      // 在这套协议里没有意义,而它会让"我在跟谁说话"多一种可能性)
      const target = peers.find((c) => c.cid === to);
      if (!target) return false;
      write(target);
      return true;
    },

    peerOnline(userId, role) {
      const m = users.get(userId);
      return m ? peersOf(m, role).length > 0 : false;
    },
  };
}
