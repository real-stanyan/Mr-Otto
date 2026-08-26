// Cloudflare Worker 的入口 + 中继的 Durable Object。**这是唯一依赖运行时的文件**,
// 所以它单独一份 tsconfig(@cloudflare/workers-types 不能进根 —— 会和 Electron
// 主进程那边的 fetch/Request/WebSocket 全局声明打架)。
//
// 路由逻辑在 edge.ts,配对逻辑在 relay.ts,线上约定在 src/shared/remote/wire.ts,
// 三个都是纯的、跑在根门禁里。这一层只做装配 + 握运行时的手。

import { DurableObject } from "cloudflare:workers";
import { createEdge, type RelayStub } from "./edge.js";
import {
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
  newCid,
  parseRole,
  peersOf,
  targetOf,
  type RelayRole,
} from "./relay.js";

export interface Env {
  /** Supabase 的 HS256 JWT secret。`wrangler secret put SUPABASE_JWT_SECRET` */
  SUPABASE_JWT_SECRET: string;
  RELAY: DurableObjectNamespace<Relay>;
}

/** getWebSockets() 回来的连接 + 它的两个 tag */
interface Live {
  ws: WebSocket;
  cid: string;
  role: RelayRole;
  open: boolean;
}

export class Relay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 心跳在边缘直接应答,**不唤醒 DO** —— 客户端要探半开连接,而这件事不该
    // 每 20 秒把一个本来在睡觉的对象叫起来收一次计费
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(CTRL_PING, CTRL_PONG));
  }

  /**
   * 当前连着的所有连接。**role 和 cid 存在 tag 里而不是实例字段上**:
   * DO 睡醒后构造函数重跑、内存清零,而 tag 跟着连接活着(ctx.getTags),
   * 这正是 Hibernation 要求的"状态别放在对象上"。
   */
  private live(): Live[] {
    const out: Live[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const [rawRole, cid] = this.ctx.getTags(ws);
      const role = parseRole(rawRole ?? null);
      if (role && cid) out.push({ ws, cid, role, open: ws.readyState === WebSocket.OPEN });
    }
    return out;
  }

  /** 这条连接的身份。tag 认不出 = 不是我们接进来的,一律不处理 */
  private who(ws: WebSocket): { cid: string; role: RelayRole } | null {
    const [rawRole, cid] = this.ctx.getTags(ws);
    const role = parseRole(rawRole ?? null);
    return role && cid ? { cid, role } : null;
  }

  override async fetch(req: Request): Promise<Response> {
    const role = parseRole(new URL(req.url).searchParams.get("role"));
    // 门口(edge.ts)已经验过一遍;这里是纵深,不是重复劳动 —— DO 也可能被别的
    // 代码路径调到,而"没有 role 就没法配对"是它自己的前提
    if (!role) return new Response("bad role", { status: 400 });

    const existing = this.live();
    if (existing.length >= MAX_CONNS_PER_USER) {
      return new Response("too many connections", { status: 503 });
    }

    const cid = newCid();
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // acceptWebSocket 而不是 server.accept():这一句就是休眠。连接由边缘代持,
    // DO 闲时出内存、不计时长,消息到达才重新构造出来。
    // 两个 tag 的**顺序是约定**:[role, cid],live()/who() 按位置读
    this.ctx.acceptWebSocket(server, [role, cid]);

    // 先告诉它自己是谁 —— 发帧要带收件人,而它得先知道自己的 cid 才能被回信
    server.send(`${CTRL_CID} ${cid}`);
    // 两侧都通知:新来的要知道对端有哪几条,在位的要知道该跟这条新的开一轮。
    // 同角色重连也走这条路(手机切后台回来就是),旧连接那套密钥已经作废,
    // 不重开的话对端会停在 ready 往虚空封帧
    for (const p of peersOf(existing, role)) {
      server.send(`${CTRL_PEER} ${p.cid}`);
      p.ws.send(`${CTRL_PEER} ${cid}`);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      // 只 echo 常量,不 echo token(客户端把 token 放在子协议的第二个值里)
      headers: { "sec-websocket-protocol": SUBPROTOCOL },
    });
  }

  override webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): void {
    // 只看长度,不看内容 —— 盲管道。上限挡的是内存,不是"内容不合法"
    const size = typeof msg === "string" ? msg.length : msg.byteLength;
    if (size > MAX_FRAME_BYTES) {
      ws.close(1009, "frame too large");
      return;
    }
    if (typeof msg !== "string") return; // 载荷约定是文本,二进制帧不该出现
    const me = this.who(ws);
    if (!me) return;

    // 读到第一个空格就够了:前面是收件人,后面那一大段密文碰都不用碰
    const frame = decodeFrame(msg);
    if (!frame) return;
    // 认不出收件人:丢弃。**不猜一条发过去** —— 收到的那端解不开,
    // 而发的那端以为发成功了,最难查的那种
    const target = targetOf(this.live(), me.role, frame.cid);
    // 对端不在线也是丢弃,不排队(排队 = 落盘)
    target?.ws.send(encodeFrame(me.cid, frame.payload));
  }

  override webSocketClose(ws: WebSocket): void {
    const me = this.who(ws);
    if (!me) return;
    // 向对端那一侧报丧:它们据此把这条连接对应的那套会话密钥丢掉,
    // 别再往一根断管子里封帧
    for (const p of peersOf(this.live(), me.role)) {
      if (p.cid !== me.cid) p.ws.send(`${CTRL_GONE} ${me.cid}`);
    }
  }
}

const handler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const handle = createEdge({
      config: { jwtSecret: env.SUPABASE_JWT_SECRET },
      relay: (userId): RelayStub => env.RELAY.getByName(userId),
    });
    return handle(req);
  },
};

export default handler;
