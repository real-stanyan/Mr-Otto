// 传输层的契约。**桌面和手机共用同一个实现**(src/shared/remote/wsTransport.ts):
// 两个运行时都有原生 WebSocket。桥只认这个接口,不知道下面是怎么连的。
//
// 纯文件:不许 import node builtin / electron。

/**
 * 传输层的契约。**连接生命周期归传输所有**,桥不管:
 *
 * - **重连、重连时机、退避,全部是实现方的事。**
 * - **握手由 onPeer 驱动,不由 onClose 驱动。** 中继在对端 attach 时往两侧各写
 *   一条 `:peer`(services/edge/src/relay.ts),传输把它转成 onPeer。
 *   这是握手唯一的起点:握手是双向的,而中继不排队 —— 桌面是长命的那一端,
 *   它开机时盲发的 hello 必然掉进虚空,手机几小时后才连上来。
 *   谁到场只有中继知道(它是唯一同时看得见两个槽的人),所以由它说。
 * - **onClose 只清状态,不发东西**:连接都断了,发出去也是丢。重连后中继会
 *   重新发 `:peer`(每条对端连接各一条),下一轮由那些信号开。于是"传输在内部
 *   悄悄重建了连接却没触发 onClose"不再是致命的 —— 新连接自带一轮 `:peer`。
 * - **onClose 不得从 send 内部同步触发。** 发送失败请自己吞掉或异步上报:
 *   send → onClose → startRound → send 会当场变成同步死循环。
 *
 * 与 islandBridge.ts 的**刻意分歧**:那边有 MAX_RESTARTS = 3,helper 反复崩就
 * 放弃并出声。差别在于谁拥有对面那个东西 —— islandBridge **自己 spawn** 那个子进程,
 * 生命周期就是它的,连崩三次是它唯一能观察到的"这台机器上装不起来";
 * 这里对面是公网另一头的一条 HTTP 连接,断开是常态(Wi-Fi 切蜂窝、笔记本合盖、
 * nginx 到点掐 idle),按次数放弃只会让手机端在最正常的场景下永久失联。
 * 谁该退避、退多久,是**传输**才看得见的信息(HTTP 状态码、网络可达性、前后台状态),
 * 所以那个决定留在传输里。
 */
export interface RemoteTransport {
  /**
   * 发一帧给**某一条**对端连接。对端不在线不是错误(中继直接丢弃,不排队),
   * 连接没开也不是——两种都由实现自己吞掉,桥不关心。
   *
   * `to` 是中继编的连接 id(ADR-0130),从 onPeer 拿到。**必须寻址、不能广播**:
   * 每条连接有自己一套会话密钥,广播过去的帧在别人那儿解不开,
   * 而 sealedStream 还带计数器校验 —— 收到别人的帧会被判成异常而不是无害的噪音。
   */
  send(payload: string, to: string): void;
  /** from = 发件人的 cid(中继在帧头给的,见 wire.ts 的 encodeFrame)。
      老中继给不出,是空串 */
  onMessage(cb: (payload: string, from: string) => void): void;
  /**
   * 中继报告某条对端连接到场(`:peer <cid>`)。每来一条,桥就跟**那一条**
   * 开一轮新握手。同一个 cid 再来一次 = 那边重连了,旧密钥作废,重开。
   */
  onPeer(cb: (cid: string) => void): void;
  /** 某条对端连接没了。桥据此丢掉那一套会话状态,别再往断管子里封帧 */
  onGone(cb: (cid: string) => void): void;
  /** 连接已断(自己这条)。见接口注释:桥只清状态、不发东西;不许在 send 里同步调 */
  onClose(cb: () => void): void;
  /**
   * 立刻换一条连接,不等退避。**两个平台各有各的触发时机**,所以由调用方接线:
   * 桌面接"登录那一刻"(没登录时不连也不排重连,issue #484),
   * 手机接"回到前台"(iOS 切后台掐 socket,而退避的 setTimeout 在后台也不走)。
   *
   * 不是通用重连入口:退避存在的理由是别把服务刷爆。
   */
  reconnectNow(why: string): void;
  close(): void;
}
