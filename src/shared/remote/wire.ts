// 中继的线上约定。**三方共用同一份**:桌面、手机、以及边缘服务
// (services/edge/src/relay.ts 从这里 re-export)。
//
// 为什么必须是一份而不是各写各的:这几个常量只要有一处对不上,表现就是
// "连上了但握手永远开不起来" —— 没有报错、没有断线,只有一片安静。
//
// **一户多连接,按 cid 寻址**(ADR-0130)。每条连接由中继分一个 cid;发帧必须
// 指名发给哪一条,收帧必须知道是谁发的 —— 每条连接有自己一套会话密钥,
// 广播过去的帧在别人那儿解不开,而 sealedStream 还带计数器校验,收到别人的帧
// 会被判成异常而不是无害的噪音。
//
// **cid 是中继编的,不是设备自称的。** 它只回答"这份字节塞哪根管子";
// 端到端身份始终只由握手里的签名决定。
//
// 与 SSE 那版(ADR-0130 原文)的两处差异,都是因为 WebSocket 是**离散消息**
// 而不是按行的文本流:
//   1. 没有 `event: <cid>` 行 —— 发件人直接编进帧(见 encodeFrame)
//   2. 没有 `v=2` 协商 —— 那是为了不打死只认单行 `data:` 的老解析器。
//      WebSocket 这边没有老客户端:它们连的是旧 VPS 上那个 SSE 中继,
//      两套在过渡期并存(ADR-0129 的发布顺序),各说各的话
//
// 纯文件:不许 import node builtin / electron(tests/architecture.test.ts 守着)。

/**
 * 控制信道的前缀。**载荷帧永远不会以它开头** —— 载荷帧长成 `<cid> <base64url>`,
 * 而 cid 由 newCid() 生成、必然以字母开头。所以一个字节的前缀就足以把控制信道
 * 和端到端载荷分开,中继依旧不碰内容。
 * 这条不变量由 tests/shared/remote/wire.test.ts 钉住。
 */
export const CONTROL_PREFIX = ":";

/** 中继告诉这条连接它自己的 cid。接上第一件事 */
export const CTRL_CID = ":cid";
/**
 * 在场信号。**这是握手能开始的唯一前提**:握手是双向的,两端都要拿到对方的
 * hello 才能派生会话密钥;而中继不排队,桌面又是长命的那一端 —— 它开机时
 * 盲发的 hello 必然掉进虚空,手机几小时后才连上来。
 * 谁到场只有中继知道(唯一同时看得见所有连接的人),所以由它说(ADR-0100)。
 *
 * 对端**每条**连接各一条。同一个 cid 再来一次 = 那边重连了,旧密钥作废,重开。
 */
export const CTRL_PEER = ":peer";
/** 对端那条连接没了。收到就把对应的那套会话密钥丢掉,别再往断管子里封帧 */
export const CTRL_GONE = ":gone";
/** 心跳。中继在**边缘**直接应答(setWebSocketAutoResponse),不唤醒 DO ——
    既探得出半开连接,又不产生计费时长(ADR-0129) */
export const CTRL_PING = ":ping";
export const CTRL_PONG = ":pong";

/**
 * 握手时选定的子协议。客户端发 `[SUBPROTOCOL, <Supabase JWT>]`,服务端只 echo
 * 回这个常量 —— token 不该出现在任何响应头里。
 *
 * 为什么 token 在子协议里:标准 WebSocket 构造函数只吃 `(url, protocols)`,
 * 带不了自定义头;而放 query 参数等于把 access token 写进各层访问日志和 Referer。
 */
export const SUBPROTOCOL = "mrotto.v1";

/** 单帧上限(算的是整条消息,含 cid 前缀)。挡的是内存,不是"内容不合法" */
export const MAX_FRAME_BYTES = 256 * 1024;

/** 同一户里最多几条连接。挡的是内存 —— 一个账号真开这么多端是异常 */
export const MAX_CONNS_PER_USER = 16;

/** 控制消息还是载荷帧。中继和两端共用同一条判断 */
export const isControl = (msg: string): boolean => msg.startsWith(CONTROL_PREFIX);

export type ControlKind = "cid" | "peer" | "gone" | "pong" | "ping";

/**
 * 控制消息 → 种类 + 它带的 cid(心跳不带)。认不出回 null。
 * **不抛异常**:线上来的字节永远可能是垃圾,而一条认不出的控制消息
 * 不该让整条连接陪葬。
 */
export function parseControl(msg: string): { kind: ControlKind; cid: string } | null {
  if (!isControl(msg)) return null;
  const sp = msg.indexOf(" ");
  const head = sp === -1 ? msg : msg.slice(0, sp);
  const cid = sp === -1 ? "" : msg.slice(sp + 1);
  switch (head) {
    case CTRL_CID:
      return cid ? { kind: "cid", cid } : null;
    case CTRL_PEER:
      return cid ? { kind: "peer", cid } : null;
    case CTRL_GONE:
      return cid ? { kind: "gone", cid } : null;
    case CTRL_PING:
      return { kind: "ping", cid: "" };
    case CTRL_PONG:
      return { kind: "pong", cid: "" };
    default:
      return null;
  }
}

/**
 * 载荷帧:`<cid> <payload>`。**两个方向同一条规则** ——
 * 上行时 cid 是收件人(发给谁),下行时是发件人(谁发的)。
 *
 * 用一个空格分隔而不是 JSON:中继只需要读到第一个空格就知道该塞进哪根管子,
 * 后面那一大段密文它连碰都不用碰。载荷是 base64url,里面不可能有空格。
 */
export const encodeFrame = (cid: string, payload: string): string => `${cid} ${payload}`;

/** 解不开(没有空格、cid 为空)回 null —— 同样不抛 */
export function decodeFrame(msg: string): { cid: string; payload: string } | null {
  const sp = msg.indexOf(" ");
  if (sp <= 0) return null;
  return { cid: msg.slice(0, sp), payload: msg.slice(sp + 1) };
}

/**
 * 生成一个 cid。**随机而不是递增**:Durable Object 睡醒后构造函数重跑、
 * 内存清零,一个实例字段上的计数器会归零,而那时还开着的连接仍持着老 cid ——
 * 撞号的表现是两条连接抢同一根管子,最难查的那种。随机没有这个问题,
 * 也不需要为它落盘(中继一个 storage API 都不调)。
 *
 * cid 不是秘密:猜到别人的也发不进去(只往**对端角色**的连接写),
 * 而真正的门是握手签名。以字母开头是刻意的 —— 载荷帧于是不可能以 `:` 开头。
 */
export const newCid = (): string => `c${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
