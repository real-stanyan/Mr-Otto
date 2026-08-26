// 中继的线上约定。**三方共用同一份**:桌面、手机、以及边缘服务
// (services/edge/src/relay.ts 从这里 re-export)。
//
// 为什么必须是一份而不是各写各的:这几个常量只要有一处对不上,表现就是
// "连上了但握手永远开不起来" —— 没有报错、没有断线,只有一片安静。
// 之前 SSE 时代它们确实是各写各的(中继里一份 `:peer`,客户端解析器里一份),
// 靠约定维持。放一起之后这类漂移在类型层面就不可能发生了。
//
// 纯文件:不许 import node builtin / electron(tests/architecture.test.ts 守着)。

/**
 * 控制信道的前缀。**载荷永远不会以它开头** —— 载荷是 base64url,字母表是
 * `A-Za-z0-9-_`,里面没有冒号。所以一个字节的前缀就足以把控制信道和端到端
 * 载荷分开,中继依旧不碰内容。这条不变量由 tests/shared/remote/wire.test.ts 钉住。
 *
 * 沿用 SSE 时代的写法(那时是注释行 `:peer\n\n`,标准解析器天然跳过注释)。
 * 换成 WebSocket 之后没有注释行这回事了,但约定保留:两端的判断逻辑不用改。
 */
export const CONTROL_PREFIX = ":";

/**
 * 在场信号。**这是握手能开始的唯一前提**:握手是双向的,两端都要拿到对方的
 * hello 才能派生会话密钥;而中继不排队,桌面又是长命的那一端 —— 它开机时
 * 盲发的 hello 必然掉进虚空,手机几小时后才连上来。
 * 谁到场只有中继知道(唯一同时看得见两个槽的人),所以由它说(ADR-0100)。
 */
export const PEER_PRESENT = ":peer";

/** 心跳。中继在**边缘**直接应答(setWebSocketAutoResponse),不唤醒 DO ——
    既探得出半开连接,又不产生计费时长(ADR-0129) */
export const PING = ":ping";
export const PONG = ":pong";

/**
 * 握手时选定的子协议。客户端发 `[SUBPROTOCOL, <Supabase JWT>]`,服务端只 echo
 * 回这个常量 —— token 不该出现在任何响应头里。
 *
 * 为什么 token 在子协议里:标准 WebSocket 构造函数只吃 `(url, protocols)`,
 * 带不了自定义头;而放 query 参数等于把 access token 写进各层访问日志和 Referer。
 */
export const SUBPROTOCOL = "mrotto.v1";

/** 单帧上限。挡的是内存,不是"内容不合法"(CF 的 WS 消息上限是 32 MiB,比这宽得多) */
export const MAX_FRAME_BYTES = 256 * 1024;

/** 控制消息还是载荷。中继和两端共用同一条判断 */
export const isControl = (msg: string): boolean => msg.startsWith(CONTROL_PREFIX);
