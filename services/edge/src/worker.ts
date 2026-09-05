// Cloudflare Worker 的入口 + 中继的 Durable Object。**这是唯一依赖运行时的文件**,
// 所以它单独一份 tsconfig(@cloudflare/workers-types 不能进根 —— 会和 Electron
// 主进程那边的 fetch/Request/WebSocket 全局声明打架)。
//
// 路由逻辑在 edge.ts,配对逻辑在 relay.ts,线上约定在 src/shared/remote/wire.ts,
// 计量在 quota.ts、网关在 llmGateway.ts、Stripe 在 billing.ts、查询串在 billingQueries.ts,
// 全都是纯的、跑在根门禁里。这一层只做装配 + 握运行时的手:三个 DO(Relay/Escrow/Quota)、
// Supabase 与 Stripe 的真实 HTTP、以及 ctx.waitUntil。

import { DurableObject } from "cloudflare:workers";
import { createEdge, type RelayStub } from "./edge.js";
import {
  appendAudit, friendshipQuery, grantedView, membershipQuery, openEscrow, parseEscrowDoc,
  parseFriendshipRows, parseMembershipRows, pxGate, pxMcpCall, pxRefreshTokens, sealEscrow,
  workspaceIdsOf,
  type EscrowDoc, type PxAudit,
} from "./px.js";
import { createLlmGateway, type QuotaPort, type RouteRow } from "./llmGateway.js";
import {
  addonExpiresAt, addonMicro, addonSinceOf, hold as quotaHold, rebuild, rebuildWindowSince, release as quotaRelease,
  remaining as quotaRemaining, roll, settle as quotaSettle, view as quotaView,
  type PlanSnapshot, type QuotaState, type WindowState,
} from "./quota.js";
import { checkoutParams, portalParams } from "./billing.js";
import { handleWebhookEvent } from "./webhookHandler.js";
import {
  grantsQuery, meFromParts, pageAll, parseGrantRows, parsePlanRows, parseRouteRows, parseSubscriptionRows,
  parseUsageEventRows, planSnapshotOf, plansQuery, routesQuery, subscriptionQuery, usageEventInsert, usageEventsQuery,
  type SubscriptionRow,
} from "./billingQueries.js";
import {
  aggregateByAgent, memberQuery, parseAttributionRows, parseOwnerRows, usageWindowFor, workspaceOwnerQuery, workspaceUsageQuery,
} from "./usageAttribution.js";
import type { BillingPort, CheckoutTarget } from "./edge.js";
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
  /** 托管网关的上游 key（spec 2026-09-02 第 2 节）。
      `wrangler secret put DEEPSEEK_API_KEY` / `ZHIPU_API_KEY`。
      没配的平台在网关里回 502「服务端没配 key」——不是静默降级 */
  DEEPSEEK_API_KEY?: string;
  ZHIPU_API_KEY?: string;
  /** Stripe。`wrangler secret put STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RELAY: DurableObjectNamespace<Relay>;
  ESCROW: DurableObjectNamespace<Escrow>;
  /** 一户一个额度实例：getByName(uid) */
  QUOTA: DurableObjectNamespace<Quota>;
}

/** getWebSockets() 回来的连接 + 它的三个 tag */
interface Live {
  ws: WebSocket;
  cid: string;
  role: RelayRole;
  /** 连接计数桶（issue #824）：edge.ts 的 connCountKey 算好递下来的
      「同一个人在这个房间里」的分组键。不是身份——DO 拿它只能数数 */
  ck: string;
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
      // 第三个 tag（ck）是后加的（issue #824）：部署那一刻还连着的老连接
      // 没有它，`?? ""` 让它们落进同一个桶——与改之前的行为等价，且随着
      // 那批连接断开自然消失
      const [rawRole, cid, ck] = this.ctx.getTags(ws);
      const role = parseRole(rawRole ?? null);
      if (role && cid) out.push({ ws, cid, role, ck: ck ?? "", open: ws.readyState === WebSocket.OPEN });
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
    const ck = params.get("ck") ?? "";
    const existing = this.live();
    // **按人数，不按房间总数**（issue #824）：这个上限的名字一直是
    // "PER_USER"，但数的是房间里的连接总数——只有自远程那种"房间键就是
    // userId"的房间里两者才碰巧相等。cs-ctl 是全平台一个固定房，于是它
    // 变成了"全平台同时最多 16 条人类连接"，一个人握住 16 条 socket 就能
    // 让所有人建不了云会话。ck 是 edge.ts 按 (房间, 用户) 算出来的不可逆
    // 分桶键（见那里的注释）：DO 数的是"这个桶里已经有几条"
    if (!isSvcRuntime && existing.filter((l) => l.ck === ck).length >= MAX_CONNS_PER_USER) {
      return new Response("too many connections", { status: 503 });
    }

    const cid = newCid();
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // acceptWebSocket 而不是 server.accept():这一句就是休眠。连接由边缘代持,
    // DO 闲时出内存、不计时长,消息到达才重新构造出来。
    // 三个 tag 的**顺序是约定**:[role, cid, ck],live()/who() 按位置读。
    // ck 为空(没经过 edge.ts 的那条纵深路径)时不挂这个 tag——空串 tag 是
    // 运行时的未定义地带,而"不挂"与改动之前的行为完全一致
    this.ctx.acceptWebSocket(server, ck ? [role, cid, ck] : [role, cid]);

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

/** PostgREST 小工具：读写都走 service role key（这些表对 authenticated 一律无写策略，
    见 0017 末尾）。失败一律抛，调用方自己决定要不要吞——哪几处该吞在各自的注释里写着 */
function supa(env: Env) {
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const rest = `${env.SUPABASE_URL}/rest/v1`;
  const write = async (verb: string, path: string, prefer: string, body: unknown): Promise<void> => {
    const res = await fetch(`${rest}/${path}`, {
      method: verb,
      headers: { ...headers, "content-type": "application/json", prefer },
      body: JSON.stringify(body),
    });
    // 错误正文截 200 字：PostgREST 的报错里有列名和约束名，是查这类故障唯一的线索；
    // 全量进日志则可能把一整行数据抄进去
    if (!res.ok) throw new Error(`supabase ${verb} ${path.split("?")[0]} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  };
  return {
    async get(query: string): Promise<unknown> {
      const res = await fetch(`${rest}/${query}`, { headers });
      if (!res.ok) throw new Error(`supabase GET ${query.split("?")[0]} ${res.status}`);
      return res.json();
    },
    /** `onConflict` = 冲突判据那一列。**必须显式给**：PostgREST 的
        `resolution=ignore-duplicates` 默认只认**主键**，而 usage_event / credit_grant 的
        幂等键是各自那个 unique 列（request_id / stripe_payment_intent_id），主键是 identity。
        不给的话重投会撞 unique 约束直接 409，而不是被安静忽略（I4） */
    insert: (table: string, body: unknown, opts: { ignoreDuplicates?: boolean; onConflict?: string } = {}): Promise<void> =>
      write(
        "POST",
        opts.onConflict ? `${table}?on_conflict=${encodeURIComponent(opts.onConflict)}` : table,
        opts.ignoreDuplicates ? "resolution=ignore-duplicates,return=minimal" : "return=minimal",
        body
      ),
    upsert: (table: string, body: unknown): Promise<void> =>
      write("POST", table, "resolution=merge-duplicates,return=minimal", body),
    patch: (query: string, body: unknown): Promise<void> => write("PATCH", query, "return=minimal", body),
  };
}

/**
 * 一户一个额度实例（spec 2026-09-02 第 2 节，ADR-0174）。storage 只有一把钥匙：
 * `state`（QuotaState 投影）。**投影不是事实** —— 钱的事实是 usage_event 表，
 * 这里存的是"为了不每次都扫全表"的那份缓存。
 *
 * 三件事值得写下来：
 * ① 档位快照在内存里带 60s TTL：DO 睡醒即失，回 DB 读一次，不是每请求读一次；
 * ② 冷启动没有 state 时**从事实重建**（一次范围查询），不是从零开始 ——
 *    从零开始 = 睡一觉醒来额度全满；
 * ③ 所有 op 走 fetch（同 Escrow 的写法）。DO 单线程，读改写在一次 fetch 里做完，
 *    天然无竞态，quota.ts 因此可以是一组纯函数。
 */
/** 重建拿不到事实时抛这个。**不是普通的 Error**：DO 的每个 op 认它 → 503，
    而 503 的意思是"稍后再试"，不是"你没花过钱"。C1 的整改就靠这个类型区分：
    以前这里返回 emptyState()，三个 op 会把那份空投影**落盘**，于是一次 Supabase
    抖动 = 这个人的窗口用量永久归零、买过的加购余额凭空消失 */
class QuotaUnavailable extends Error {}

/** 加购通知的去重环（I5）。DO 侧按 payment_intent 记账，所以 webhook 可以放心重投：
    「插库成功了但通知没送到」这种半截状态，靠 Stripe 的重试就能治好 */
const GRANT_SEEN_MAX = 200;

export class Quota extends DurableObject<Env> {
  private planCache: { v: PlanSnapshot | null; sub: SubscriptionRow | null; exp: number } | null = null;

  /** 这一份额度是谁的：**只认 DO 的实例名**。实例名是 edge 拿验过的 JWT sub 调
      getByName 时钉死的；请求体里可以写任何字，所以请求体里根本不带身份 */
  private uid(): string {
    return this.ctx.id.name ?? "";
  }

  private async plan(force = false): Promise<{ plan: PlanSnapshot | null; sub: SubscriptionRow | null }> {
    if (!force && this.planCache && this.planCache.exp > Date.now()) {
      return { plan: this.planCache.v, sub: this.planCache.sub };
    }
    const db = supa(this.env);
    const [subRows, planRows] = await Promise.all([db.get(subscriptionQuery(this.uid())), db.get(plansQuery())]);
    const sub = parseSubscriptionRows(subRows);
    const v = planSnapshotOf(sub, parsePlanRows(planRows));
    this.planCache = { v, sub, exp: Date.now() + 60_000 };
    return { plan: v, sub };
  }

  private async state(plan: PlanSnapshot | null): Promise<QuotaState> {
    const stored = await this.ctx.storage.get<QuotaState>("state");
    if (stored) return stored;
    // 冷启动：从事实重建。没订阅也要建 —— 加购余额不依赖订阅。
    // I2：重建包在 blockConcurrencyWhile 里。DO 单线程只保证「一次 fetch 内的读改写
    // 没人插队」，await 之间照样会切出去 —— 一个冷 DO 同时进来两个请求时，两边都读到
    // 「没有 state」、各自重建、各自 put，后写的那份把前一个的 hold 抹掉（那笔调用
    // 从此没人记账）。blockConcurrencyWhile 把「查库 + 落盘」变成一个原子段，
    // 段内再查一次 storage：第二个请求进来时已经有 state 了，直接用
    return this.ctx.blockConcurrencyWhile(async () => {
      const again = await this.ctx.storage.get<QuotaState>("state");
      if (again) return again;
      const db = supa(this.env);
      const uid = this.uid();
      const now = Date.now();
      try {
        // #858：三条都分页翻到底，翻到上限抛错（→ 503），不静默截断。
        // #863：grant 先拉（全部，含过期），addon 事件的起点由它算——没有活着的 grant 就一行都不拉；
        // window 事件从「周段起点 / now−5h」较早者起拉，跨周边界还开着的 5h 窗才不会被截半。
        const grants = parseGrantRows(await pageAll(db.get, grantsQuery(uid)));
        const addonSince = addonSinceOf(grants, now);
        const [win, add] = await Promise.all([
          plan ? pageAll(db.get, usageEventsQuery(uid, "window", rebuildWindowSince(plan, now))) : Promise.resolve([]),
          addonSince === null ? Promise.resolve([]) : pageAll(db.get, usageEventsQuery(uid, "addon", addonSince)),
        ]);
        const rebuilt = rebuild({ events: [...parseUsageEventRows(win), ...parseUsageEventRows(add)], grants }, plan, now);
        // #862：把此刻活着的 grant 的幂等键并进 grantSeen。竞态是「webhook 插行 → 冷 DO 重建把
        // 这行算进来 → webhook 通知 addonGranted」：通知到达时 storage 已有 state，不并进来
        // 就会 append 第二份。blockConcurrencyWhile 保证通知要么排在重建前（冷、只留记号）、
        // 要么排在重建后（记号已在 → dup），没有第三种交错
        const seen = (await this.ctx.storage.get<string[]>("grantSeen")) ?? [];
        const liveIds = grants.filter((g) => g.expiresAt > now && g.paymentIntentId).map((g) => g.paymentIntentId as string);
        const nextSeen = [...new Set([...seen, ...liveIds])].slice(-GRANT_SEEN_MAX);
        await this.ctx.storage.put({ state: rebuilt, grantSeen: nextSeen });
        return rebuilt;
      } catch (err) {
        // C1：重建失败**既不落盘也不返回空投影**，而是抛 —— 调用方回 503。
        // 返回 emptyState() 的话，hold/view/planChanged 会把它当成"这个人没花过钱"
        // 直接 put 进 storage：一次 Supabase 抖动就把窗口用量清零、把买过的加购
        // 余额抹掉，而且从此不会再重建（storage 里有 state 了）。少扣对用户有利
        // 那条只适用于"一笔账没落"，不适用于"整份余额归零"
        console.error(`quota rebuild 失败（${uid}）：${err instanceof Error ? err.message : String(err)}`);
        throw new QuotaUnavailable(err instanceof Error ? err.message : String(err));
      }
    });
  }

  override async fetch(req: Request): Promise<Response> {
    const json = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    try {
      return await this.dispatch(req, json);
    } catch (err) {
      // C1：重建拿不到事实 = 这一刻算不出额度，回 503「稍后再试」。
      // 别的异常照抛 —— 把所有错误都译成 503 会把真 bug 伪装成暂时性故障
      if (err instanceof QuotaUnavailable) {
        return json({ error: { message: `额度暂时算不出来：${err.message}`, type: "otto_edge", code: "quota_unavailable" } }, 503);
      }
      throw err;
    }
  }

  private async dispatch(req: Request, json: (payload: unknown, status?: number) => Response): Promise<Response> {
    const op = new URL(req.url).pathname.slice(1);
    const body: unknown = await req.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const now = Date.now();

    if (op === "hold") {
      const { plan } = await this.plan();
      const r = quotaHold(await this.state(plan), plan, String(b.requestId), Number(b.estimateMicro), now);
      if (r.ok) await this.ctx.storage.put("state", r.state);
      // 被拒的那三支形状就是 HoldOutcome（code/window/resetAt），原样回
      return json(r.ok ? { ok: true, chargedTo: r.chargedTo } : r);
    }

    if (op === "settle") {
      const { plan } = await this.plan();
      // **不在这里先 roll**：quota.settle 自己 roll，且刻意先查 hold 再 roll ——
      // 先 roll 会把超过 HOLD_TTL_MS 的 hold 当成没人认领直接释放掉，
      // 这笔已经花出去的成本就没人记账了（quota.ts 文件头 fix round 2）
      const r = quotaSettle(await this.state(plan), String(b.requestId), Number(b.costMicro), now, plan);
      if (!r) return json({ ok: false, reason: "no_hold" }); // 已结算/已释放：幂等，调用方据此不写 usage_event
      await this.ctx.storage.put("state", r.state);
      // #863：这笔成本落进了哪扇 5h 窗——只有真有钱进窗时才带（addon 没溢出就是 null），
      // usage_event 记下它，冷启动重建按锚算窗，不再按事件链猜
      return json({ ok: true, chargedTo: r.hold.chargedTo, windowOpenAt: r.windowMicro > 0 ? r.state.open5hAt : null });
    }

    if (op === "release") {
      // M9：先读 storage。没有 state = 没有任何挂着的 hold，本来就没什么可释放的——
      // 为它查一次档位再整份重建，纯属白花两次往返（而且重建失败会把一次
      // no-op 变成 503）。网关在 settle 失败后还会再 release 一次，这条路要最便宜
      const stored = await this.ctx.storage.get<QuotaState>("state");
      if (!stored) return json({ ok: true });
      const next = quotaRelease(stored, String(b.requestId));
      // 认不出的 requestId：quota.release 原样回同一个对象 —— 这就是网关要的 no-op，
      // 连写盘都不必
      if (next !== stored) await this.ctx.storage.put("state", next);
      return json({ ok: true });
    }

    if (op === "remaining") {
      const { plan } = await this.plan();
      return json({ ...quotaRemaining(await this.state(plan), plan, now), plan: plan?.planId ?? null });
    }

    if (op === "view") {
      const { plan, sub } = await this.plan();
      const st = roll(await this.state(plan), now, plan);
      await this.ctx.storage.put("state", st); // roll 掉的过期窗/过期加购顺手落盘，别每次读都重算
      return json({
        sub, windows: quotaView(st, plan, now),
        addon: { remainingMicro: addonMicro(st), expiresAt: addonExpiresAt(st) },
      });
    }

    if (op === "planChanged") {
      // webhook 刚改了订阅：丢缓存重读。周窗锚定日可能跟着变了，
      // roll 会按新的 periodStart 重算当前周段（对不上就整段归零）
      const { plan } = await this.plan(true);
      await this.ctx.storage.put("state", roll(await this.state(plan), now, plan));
      return json({ ok: true });
    }

    if (op === "addonGranted") {
      // 加购入账：**append 一笔**，不是往一个标量上加 —— 分两次买的额度各自到期，
      // 合成一个数会让先买的那份被后买的那份的到期日一起打成 0（quota.ts C2）。
      //
      // I5：按 payment_intent 幂等。这条 op 因此**可以被重投**——「credit_grant 插进去了、
      // 通知这一步炸了」以前是个治不好的半截状态（重投会被 webhook 那边的查重挡掉，
      // 而热 DO 又永远等不到这笔额度）。现在 webhook 撞见重复行也照样通知，
      // 由这里的 grantSeen 环去重，Stripe 的重试就把它治好了
      const paymentIntentId = typeof b.paymentIntentId === "string" ? b.paymentIntentId : "";
      const micro = Number(b.micro);
      const expiresAt = Number(b.expiresAt);
      if (!paymentIntentId || !Number.isFinite(micro) || micro <= 0 || !Number.isFinite(expiresAt)) {
        return json({ ok: false, reason: "bad_grant" });
      }
      const seen = (await this.ctx.storage.get<string[]>("grantSeen")) ?? [];
      if (seen.includes(paymentIntentId)) return json({ ok: true, dup: true });
      const nextSeen = [...seen, paymentIntentId].slice(-GRANT_SEEN_MAX);

      const stored = await this.ctx.storage.get<QuotaState>("state");
      if (!stored) {
        // 冷的：这笔 grant 已经在 credit_grant 表里了（webhook 先插再通知），
        // 下一次操作的冷启动重建会把它算进来 —— 这里再 append 一次就是发两份额度。
        // 但**记号照留**：不然重投打到一个已经重建过的热 DO 上，就真的会 append 第二份
        await this.ctx.storage.put("grantSeen", nextSeen);
        return json({ ok: true, note: "cold: rebuild 会从 credit_grant 把它算进来" });
      }
      const grants = [...stored.grants, { micro, expiresAt }].sort((g1, g2) => g1.expiresAt - g2.expiresAt);
      // 两把钥匙一次写完：分两次 put 的话，「余额加了、记号没落」那半会在重投时再加一份
      await this.ctx.storage.put({ state: { ...stored, grants }, grantSeen: nextSeen });
      return json({ ok: true });
    }

    return json({ error: { message: `没有这个内部操作:${op}`, type: "otto_edge", code: "not_found" } }, 404);
  }
}

/** 打这个人的 Quota DO。实例按 uid 取名，DO 自己从实例名读身份 ——
    请求体里不带 uid，也就没有「body 里冒充别人」这条路。
    非 2xx 一律抛：让调用方走它自己的失败路径，而不是把一份错误信封
    当成额度回执解析（那会把 500 读成「太多并发请求」） */
async function quotaCall<T = Record<string, unknown>>(env: Env, uid: string, op: string, body: unknown): Promise<T> {
  const res = await env.QUOTA.getByName(uid).fetch(new Request(`https://quota/${op}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  if (!res.ok) throw new Error(`quota ${op} ${res.status}`);
  return (await res.json()) as T;
}

function quotaPort(env: Env): QuotaPort {
  const db = supa(env);
  return {
    async hold(uid, requestId, estimateMicro) {
      const r = await quotaCall(env, uid, "hold", { requestId, estimateMicro });
      if (r.ok === true) return { ok: true, chargedTo: r.chargedTo === "addon" ? "addon" : "window" };
      if (r.code === "quota_exhausted") {
        return { ok: false, code: "quota_exhausted", window: r.window === "week" ? "week" : "5h", resetAt: Number(r.resetAt) };
      }
      return { ok: false, code: r.code === "no_subscription" ? "no_subscription" : "too_many_inflight" };
    },
    async settle(uid, requestId, meta) {
      const r = await quotaCall(env, uid, "settle", { requestId, costMicro: meta.costMicro });
      if (r.ok !== true) return; // 没有挂着的 hold（重复 settle / 已释放）：不记账，幂等
      const chargedTo = r.chargedTo === "addon" ? "addon" : "window";
      const windowOpenAt = typeof r.windowOpenAt === "number" && Number.isFinite(r.windowOpenAt) ? r.windowOpenAt : null;
      try {
        await db.insert("usage_event", usageEventInsert(requestId, meta, chargedTo, windowOpenAt), {
          ignoreDuplicates: true, onConflict: "request_id", // 主键是 identity，幂等键是这一列（I4）
        });
      } catch (err) {
        // 投影已经扣了、事实没落 —— 下次 DO 冷启动重建时会少算这一笔。记日志，**不回滚投影**：
        // 少扣对用户有利，回滚才会把「已经给出去的内容」变成既没扣钱也没记录
        console.error(`usage_event 落库失败（${uid}/${requestId}）：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async release(uid, requestId) { await quotaCall(env, uid, "release", { requestId }); },
    async remaining(uid) {
      const r = await quotaCall(env, uid, "remaining", {});
      return { h5: Number(r.h5), week: Number(r.week), addon: Number(r.addon), plan: typeof r.plan === "string" ? r.plan : null };
    },
  };
}

/** model_route 的 60s 缓存。isolate 级、best-effort —— 边缘上有很多个 isolate，
    这不是"全局一份"，只是"同一个 isolate 里一分钟内不重复查" */
let routesCache: { v: RouteRow[]; exp: number } | null = null;
async function routesOf(env: Env): Promise<RouteRow[]> {
  if (routesCache && routesCache.exp > Date.now()) return routesCache.v;
  const v = parseRouteRows(await supa(env).get(routesQuery()));
  routesCache = { v, exp: Date.now() + 60_000 };
  return v;
}

/** 计费面（spec 2026-09-02 第 3 节）：Stripe 是订阅状态的事实来源，
    subscription 表是投影，Quota DO 是投影的投影。写库顺序永远是
    「先落事实（表），再通知投影（DO）」—— 反过来的话通知成功、落库失败，
    投影里凭空多出一份没有凭据的额度 */
function billingPort(env: Env): BillingPort {
  const db = supa(env);
  const stripe = async (path: string, params: URLSearchParams): Promise<Record<string, unknown>> => {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY ?? ""}`, "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = body.error as { message?: string } | undefined;
      throw new Error(`stripe ${path} ${res.status}: ${e?.message ?? "?"}`);
    }
    return body;
  };

  return {
    async me(uid) {
      const v = await quotaCall<{
        sub: SubscriptionRow | null;
        windows: { h5: WindowState; week: WindowState } | null;
        addon: { remainingMicro: number; expiresAt: number | null };
      }>(env, uid, "view", {});
      const [routes, plans] = await Promise.all([routesOf(env), db.get(plansQuery()).then(parsePlanRows)]);
      const models = [...new Set(routes.map((x) => x.logicalModel))];
      return meFromParts(v.sub, v.windows, v.addon, models, plans);
    },

    // 归因从 usage_event 现算（不碰 Quota DO —— 那是限流用的投影，没有 agent 维度）。
    // 顺序是先查 owner 再查在籍：工作区不存在与「存在但你不在里面」是两件事，
    // 合成一个 404 的话，被踢出去的人看到的是「这个工作区没了」
    async workspaceUsage(uid, workspaceId) {
      const owner = parseOwnerRows(await db.get(workspaceOwnerQuery(workspaceId)));
      if (!owner) return { ok: false, code: "not_found", message: "没有这个工作区" };
      const member = await db.get(memberQuery(workspaceId, uid));
      if (!Array.isArray(member) || member.length === 0) return { ok: false, code: "not_member", message: "你不在这个工作区里" };
      const sub = parseSubscriptionRows(await db.get(subscriptionQuery(owner)));
      const window = usageWindowFor(Date.now(), sub ? Date.parse(sub.current_period_start) : null);
      const rows = parseAttributionRows(await pageAll(db.get, workspaceUsageQuery(owner, workspaceId, window.weekStartAt)));
      return { ok: true, value: { workspaceId, ownerUid: owner, ...window, rows: aggregateByAgent(rows) } };
    },

    async checkout(uid, target: CheckoutTarget, origin) {
      if (!env.STRIPE_SECRET_KEY) return { error: "服务端没配 Stripe" };
      try {
        const [plans, sub] = await Promise.all([
          db.get(plansQuery()).then(parsePlanRows),
          db.get(subscriptionQuery(uid)).then(parseSubscriptionRows),
        ]);
        // C2：已经有一条**没退订**的订阅时，再开一张订阅 Checkout = Stripe 那边
        // 长出第二条订阅，两笔一起扣款（升档按钮以前就是这么点的）。换档的正路是
        // Customer Portal（`portal`），它在同一条订阅上改 price 并按比例结算。
        // canceled 放行：那是「退订过又想回来」，本来就该重新开一张。
        // 加购（payment 模式）不受这条管——它是一次性购买，跟订阅条数无关。
        if ("planId" in target && sub && sub.status !== "canceled") {
          return { error: "已有订阅，换档请走「管理」", code: "already_subscribed" };
        }
        const wanted = "planId" in target ? target.planId : "addon";
        const row = plans.find((p) => p.id === wanted);
        if (!row || !row.stripe_price_id) return { error: `${wanted} 这个档位还没配 Stripe price` };
        const params = checkoutParams({
          mode: "planId" in target ? "subscription" : "payment",
          priceId: row.stripe_price_id, quantity: "planId" in target ? 1 : target.quantity, uid,
          // 已经有 customer 就复用：同一个人在 Stripe 那边不该长出第二个客户
          ...(sub?.stripe_customer_id ? { customerId: sub.stripe_customer_id } : {}),
          successUrl: `${origin}/billing/v1/done?ok=1`, cancelUrl: `${origin}/billing/v1/done?ok=0`,
        });
        const s = await stripe("checkout/sessions", params);
        return typeof s.url === "string" ? { url: s.url } : { error: "Stripe 没回 url" };
      } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
    },

    async portal(uid, origin) {
      if (!env.STRIPE_SECRET_KEY) return { error: "服务端没配 Stripe" };
      try {
        const sub = parseSubscriptionRows(await db.get(subscriptionQuery(uid)));
        if (!sub?.stripe_customer_id) return { error: "还没有订阅记录" };
        const s = await stripe("billing_portal/sessions", portalParams(sub.stripe_customer_id, `${origin}/billing/v1/done?ok=1`));
        return typeof s.url === "string" ? { url: s.url } : { error: "Stripe 没回 url" };
      } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
    },

    // 编排抽在 webhookHandler.ts（#854）：三条钱路（乱序闸 / 加购去重+通知 DO /
    // planChanged）是纯函数可测的，这里只剩把真实的 Supabase/Stripe 递进去
    webhook: (payload, signatureHeader) =>
      handleWebhookEvent({ db, quotaCall: (uid, op, body) => quotaCall(env, uid, op, body) },
        payload, signatureHeader, env.STRIPE_WEBHOOK_SECRET ?? "", Math.floor(Date.now() / 1000)),
  };
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
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handle = createEdge({
      config: { jwtSecret: env.SUPABASE_JWT_SECRET, runtimeSecret: env.RUNTIME_SECRET },
      relay: (userId): RelayStub => env.RELAY.getByName(userId),
      escrow: (hostUid): RelayStub => env.ESCROW.getByName(hostUid),
      isFriend: friendChecker(env),
      llm: createLlmGateway({
        routes: () => routesOf(env),
        quota: quotaPort(env),
        upstreamKey: (platform) => (platform === "deepseek" ? env.DEEPSEEK_API_KEY : platform === "zhipu" ? env.ZHIPU_API_KEY : undefined),
        // 流式响应的 settle 发生在响应已经发出之后。没有 waitUntil，Worker 会在
        // 返回响应那一刻把这个 isolate 收掉 —— 结算就永远不会落地（额度白送）
        waitUntil: (p) => ctx.waitUntil(p),
      }),
      billing: billingPort(env),
    });
    return handle(req);
  },
};

export default handler;
