// Cloudflare Worker 的入口 + 中继的 Durable Object。**这是唯一依赖运行时的文件**,
// 所以它单独一份 tsconfig(@cloudflare/workers-types 不能进根 —— 会和 Electron
// 主进程那边的 fetch/Request/WebSocket 全局声明打架)。
//
// 路由逻辑在 edge.ts,配对逻辑在 relay.ts,两个都是纯的、跑在根门禁里。
// 这一层只做装配 + 握运行时的手,所以它薄到几乎没有可测的东西。

import { DurableObject } from "cloudflare:workers";
import { createEdge, type RelayStub } from "./edge.js";
import {
  MAX_FRAME_BYTES,
  PEER_PRESENT,
  PING,
  PONG,
  SUBPROTOCOL,
  parseRole,
  peerOf,
  supersededBy,
  type RelayRole,
} from "./relay.js";

export interface Env {
  /** Supabase 的 HS256 JWT secret。`wrangler secret put SUPABASE_JWT_SECRET` */
  SUPABASE_JWT_SECRET: string;
  RELAY: DurableObjectNamespace<Relay>;
}

/** getWebSockets() 回来的连接 + 它的 role(存在 tag 里) */
interface Live {
  ws: WebSocket;
  role: RelayRole;
  open: boolean;
}

export class Relay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 心跳在边缘直接应答,**不唤醒 DO** —— 客户端要探半开连接,而这件事不该
    // 每 25 秒把一个本来在睡觉的对象叫起来收一次计费
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * 当前连着的两端。**role 存在 tag 里而不是实例字段上**:DO 睡醒后构造函数
   * 重跑、内存清零,而 tag 跟着连接活着(ctx.getTags),这正是 Hibernation 要求的
   * "状态别放在对象上"。
   */
  private live(): Live[] {
    const out: Live[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const role = parseRole(this.ctx.getTags(ws)[0] ?? null);
      if (role) out.push({ ws, role, open: ws.readyState === WebSocket.OPEN });
    }
    return out;
  }

  override async fetch(req: Request): Promise<Response> {
    const role = parseRole(new URL(req.url).searchParams.get("role"));
    // 门口(edge.ts)已经验过一遍;这里是纵深,不是重复劳动 —— DO 也可能被别的
    // 代码路径调到,而"没有 role 就没法配对"是它自己的前提
    if (!role) return new Response("bad role", { status: 400 });

    // 同角色重连顶掉旧的。**必须排在 accept 之前**:accept 之后自己也在
    // getWebSockets() 里,再关就把自己关了
    for (const old of supersededBy(this.live(), role)) {
      old.ws.close(1000, "superseded");
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // acceptWebSocket 而不是 server.accept():这一句就是休眠。连接由边缘代持,
    // DO 闲时出内存、不计时长,消息到达才重新构造出来
    this.ctx.acceptWebSocket(server, [role]);

    const peer = peerOf(this.live(), role);
    if (peer) {
      // 两侧都通知:新来的那端要知道对端已在,在位的那端要知道该重开一轮。
      // 同角色重连也会走到这里 —— 手机切后台回来就是这条路径,旧连接的密钥
      // 已经作废,不重开的话桌面会停在 ready 往虚空封帧
      server.send(PEER_PRESENT);
      peer.ws.send(PEER_PRESENT);
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
    const from = parseRole(this.ctx.getTags(ws)[0] ?? null);
    if (!from) return;
    // 对端不在线:丢弃,不排队(排队 = 落盘)
    peerOf(this.live(), from)?.ws.send(msg);
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
