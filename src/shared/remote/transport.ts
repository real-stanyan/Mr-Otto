// 传输层的契约。桌面用 fetch 的流式 body 实现,手机用 XMLHttpRequest 实现
// (RN 的 fetch 没有可读的 body 流)。两端的桥都只认这个接口,谁也不知道对方怎么连的。
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
 *   重新发 `:peer`(同角色重连也发),下一轮由那条信号开。于是"传输在内部
 *   悄悄重建了 SSE 却没触发 onClose"不再是致命的 —— 新连接自带一条 `:peer`。
 * - **onClose 不得从 send 内部同步触发。** 发送失败请自己吞掉或异步上报;
 *   对端不在线(网关回 409)本来也不是"连接断了",不该走 onClose。
 *
 * 与 islandBridge.ts 的**刻意分歧**:那边有 MAX_RESTARTS = 3,helper 反复崩就
 * 放弃并出声。差别在于谁拥有对面那个东西 —— islandBridge **自己 spawn** 那个子进程,
 * 生命周期就是它的,连崩三次是它唯一能观察到的"这台机器上装不起来";
 * 这里对面是公网另一头的一条 HTTP 连接,断开是常态(Wi-Fi 切蜂窝、笔记本合盖、
 * nginx 到点掐 idle),按次数放弃只会让手机端在最正常的场景下永久失联。
 * 谁该退避、退多久,是**传输**才看得见的信息(HTTP 状态码、网络可达性、前后台状态),
 * 所以那个决定留在传输里。当前分支(plan A)不含真实现,这段是写给 plan B 的合同。
 */
export interface RemoteTransport {
  /** 发一帧。对端不在线不是错误(网关回 409),由实现自己吞掉——桥不关心 */
  send(payload: string): void;
  onMessage(cb: (payload: string) => void): void;
  /** 中继报告对端已在场(SSE 的 `:peer` 注释行)。每来一条,桥就开一轮新握手 */
  onPeer(cb: () => void): void;
  /** 连接已断。见接口注释:桥只清状态、不发东西;不许在 send 里同步调 */
  onClose(cb: () => void): void;
  close(): void;
}
