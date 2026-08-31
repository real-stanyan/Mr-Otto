// Cloudflare Worker 的入口 + 中继的 Durable Object。**这是唯一依赖运行时的文件**,
// 所以它单独一份 tsconfig(@cloudflare/workers-types 不能进根 —— 会和 Electron
// 主进程那边的 fetch/Request/WebSocket 全局声明打架)。
//
// 路由逻辑在 edge.ts,配对逻辑在 relay.ts,线上约定在 src/shared/remote/wire.ts,
// 三个都是纯的、跑在根门禁里。这一层只做装配 + 握运行时的手。

import { DurableObject } from "cloudflare:workers";
import { createEdge, type RelayStub } from "./edge.js";
import {
  appendAudit, friendshipQuery, grantedView, membershipQuery, openEscrow, parseEscrowDoc,
  parseFriendshipRows, parseMembershipRows, pxGate, pxMcpCall, pxRefreshTokens, sealEscrow,
  workspaceIdsOf,
  type EscrowDoc, type PxAudit,
} from "./px.js";
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
  /** 托管箱的应用层 AES-GCM key（32 字节 base64）。`wrangler secret put ESCROW_KEY` */
  ESCROW_KEY: string;
  /** Supabase service role key（关系闸查 friendships）。`wrangler secret put SUPABASE_SERVICE_KEY` */
  SUPABASE_SERVICE_KEY: string;
  /** Supabase 项目根 URL（vars，不是 secret） */
  SUPABASE_URL: string;
  /** 平台身份（VPS 云 runtime）的共享密钥。`wrangler secret put RUNTIME_SECRET`
      （ADR-0199）——本地/测试环境常常不配，px.ts/edge.ts 的 runtime 分支
      因此整个不存在，不是"配了空字符串所以永远比不中" */
  RUNTIME_SECRET: string;
  RELAY: DurableObjectNamespace<Relay>;
  ESCROW: DurableObjectNamespace<Escrow>;
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
    const params = new URL(req.url).searchParams;
    const role = parseRole(params.get("role"));
    // 门口(edge.ts)已经验过一遍;这里是纵深,不是重复劳动 —— DO 也可能被别的
    // 代码路径调到,而"没有 role 就没法配对"是它自己的前提
    if (!role) return new Response("bad role", { status: 400 });

    // 平台身份（svc-runtime）豁免连接数上限（ADR-0199）：同一枚 runtime 账号
    // 从多台 VPS 并发连是合法的多实例形态,不是滥用信号。DO 自己不认识
    // userId,只认识 edge.ts 验完 secret 后打在转发请求里的这个显式标记
    const isSvcRuntime = params.get("svc") === "1";
    const existing = this.live();
    if (!isSvcRuntime && existing.length >= MAX_CONNS_PER_USER) {
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

/**
 * 托管箱 DO（ADR-0197）：一户（hostUid）一箱。凭据只在这里解封——edge 层
 * 转进来的请求已验过 JWT 并做完关系闸，这里只剩白名单闸 + 执行 + 审计。
 * storage：`sealed`（AES-GCM 密封的 EscrowDoc）、`audit`（PxAudit[] 环形 500）。
 */
export class Escrow extends DurableObject<Env> {
  private async doc(): Promise<EscrowDoc | null> {
    const sealed = await this.ctx.storage.get<string>("sealed");
    return sealed ? openEscrow(this.env.ESCROW_KEY, sealed) : null;
  }

  private async audit(entry: PxAudit): Promise<void> {
    const list = (await this.ctx.storage.get<PxAudit[]>("audit")) ?? [];
    await this.ctx.storage.put("audit", appendAudit(list, entry));
  }

  /** 工作区关系闸的查询（ADR-0198 切片 1）：照 friendChecker 的写法，
      60s 内存缓存，DO 睡醒即失（best-effort，不需要跨睡眠持久） */
  private msCache = new Map<string, { v: Set<string>; exp: number }>();
  private async workspaceOk(doc: EscrowDoc | null, fromUid: string): Promise<Set<string>> {
    const ids = workspaceIdsOf(doc);
    if (ids.length === 0 || !doc) return new Set();
    const key = `${fromUid}|${ids.join(",")}`;
    const hit = this.msCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    try {
      const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/${membershipQuery(ids, fromUid, doc.hostUid)}`, {
        headers: { apikey: this.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${this.env.SUPABASE_SERVICE_KEY}` },
      });
      const v = res.ok ? parseMembershipRows(await res.json(), fromUid, doc.hostUid) : new Set<string>();
      this.msCache.set(key, { v, exp: Date.now() + 60_000 });
      return v;
    } catch { return new Set(); } // 关系闸失败关闭
  }

  override async fetch(req: Request): Promise<Response> {
    const op = new URL(req.url).pathname.slice(1);
    const body: unknown = await req.json().catch(() => ({}));
    const b = body as Record<string, unknown>;
    const json = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } });

    if (op === "put") {
      const doc = parseEscrowDoc(b.doc);
      if (!doc) return json(400, { error: { message: "托管文档形状不对", type: "otto_edge", code: "bad_doc" } });
      await this.ctx.storage.put("sealed", await sealEscrow(this.env.ESCROW_KEY, doc));
      return json(200, { ok: true, services: doc.services.length, grants: doc.grants.length });
    }
    if (op === "delete") {
      // 撤销 = 凭据即刻消失。审计留着——「借出过、后来撤了」是 A 该拉得回的历史
      await this.ctx.storage.delete("sealed");
      return json(200, { ok: true });
    }
    if (op === "grants") {
      const fromUid = typeof b.fromUid === "string" ? b.fromUid : "";
      const friendAccepted = b.friendAccepted === true;
      const doc = await this.doc();
      return json(200, grantedView(doc, fromUid, { friendAccepted, workspaceOk: await this.workspaceOk(doc, fromUid) }));
    }
    if (op === "audit") {
      const since = typeof b.since === "number" ? b.since : 0;
      const list = (await this.ctx.storage.get<PxAudit[]>("audit")) ?? [];
      return json(200, { audits: list.filter((a) => a.ts > since) });
    }
    if (op === "call") {
      const fromUid = typeof b.fromUid === "string" ? b.fromUid : "";
      const serverId = typeof b.serverId === "string" ? b.serverId : "";
      const tool = typeof b.tool === "string" ? b.tool : "";
      const friendAccepted = b.friendAccepted === true;
      const doc = await this.doc();
      const gate = pxGate(doc, { fromUid, serverId, tool }, { friendAccepted, workspaceOk: await this.workspaceOk(doc, fromUid) });
      if (!gate.ok) {
        await this.audit({ ts: Date.now(), fromUid, serverId, tool, outcome: "denied", note: gate.message });
        return json(gate.status, { error: { message: gate.message, type: "otto_edge", code: gate.code } });
      }
      const fetchLike = (url: string, init: RequestInit) => fetch(url, init);
      let r = await pxMcpCall(fetchLike, gate.service, tool, b.args);
      if (!r.ok && r.code === "upstream_auth") {
        // 兜底自刷一次（ADR-0197「token 生死」）：刷成就更新密封箱再重试
        const oauth = await pxRefreshTokens(fetchLike, gate.service);
        if (oauth && doc) {
          const updated: EscrowDoc = {
            ...doc,
            services: doc.services.map((s) => (s.serverId === serverId ? { ...s, oauth } : s)),
            updatedTs: Date.now(),
          };
          await this.ctx.storage.put("sealed", await sealEscrow(this.env.ESCROW_KEY, updated));
          r = await pxMcpCall(fetchLike, { ...gate.service, oauth }, tool, b.args);
        }
      }
      if (!r.ok) {
        await this.audit({ ts: Date.now(), fromUid, serverId, tool, outcome: "error", note: r.message });
        const msg = r.code === "upstream_auth" ? "托管凭据已失效——让对方上线重新授权一次" : r.message;
        return json(r.status, { error: { message: msg, type: "otto_edge", code: r.code } });
      }
      await this.audit({ ts: Date.now(), fromUid, serverId, tool, outcome: "ok" });
      return json(200, { result: r.content });
    }
    return json(404, { error: { message: `没有这个内部操作:${op}`, type: "otto_edge", code: "not_found" } });
  }
}

/** 关系闸：service role 查 friendships，60s 内存缓存（DO 睡醒即失，best-effort） */
function friendChecker(env: Env): (a: string, b: string) => Promise<boolean> {
  const cache = new Map<string, { v: boolean; exp: number }>();
  return async (a, b) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    try {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${friendshipQuery(a, b)}`, {
        headers: { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
      });
      const v = res.ok && parseFriendshipRows(await res.json());
      cache.set(key, { v, exp: Date.now() + 60_000 });
      return v;
    } catch {
      return false; // 关系闸失败关闭
    }
  };
}

const handler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const handle = createEdge({
      config: { jwtSecret: env.SUPABASE_JWT_SECRET, runtimeSecret: env.RUNTIME_SECRET },
      relay: (userId): RelayStub => env.RELAY.getByName(userId),
      escrow: (hostUid): RelayStub => env.ESCROW.getByName(hostUid),
      isFriend: friendChecker(env),
    });
    return handle(req);
  },
};

export default handler;
