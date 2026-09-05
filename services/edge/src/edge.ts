// otto-edge 的请求路由层 —— 纯 Web Request/Response,不碰任何运行时。
// 这么分是为了能测:tests/edge/edge.test.ts 直接造 Request 打它,不起 workerd。
//
// 它只做两件事:
//   1. OAuth 落地页(无鉴权,浏览器裸访问)
//   2. 远程中继的**门口**:验 Supabase JWT 认人,然后把连接交给那个人的
//      Durable Object。DO 自己永远看不到 token —— 它只知道有两条连接、
//      一条标 desktop 一条标 mobile。爆炸半径比验在里面小。
//
//   3. 托管模型网关 + 计费面(订阅制,ADR-0174 起三篇 + spec 2026-09-02):
//      验人 → 交给 llmGateway(hold/转发/settle 都在那边)。ADR-0085 关掉、
//      ADR-0129 删掉的那一版是赠额形态;这一版是订阅形态,机制层复活。

import { authLandingResponse } from "./authLanding.js";
import { timingSafeEqual } from "./util.js";
import { verifyJwt } from "./jwt.js";
import { parseRole, SUBPROTOCOL, type RelayRole } from "./relay.js";
import { parseEscrowDoc } from "./px.js";
import { isCsChannel } from "../../../src/shared/remote/cloudSession.js";
import { MAX_GRANT_QUANTITY } from "./billing.js";
import type { Caller } from "./llmGateway.js";
import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, type BillingMe, type PlanId, type WorkspaceUsage } from "../../../src/shared/billing.js";
import { WORKSPACE_ID_RE } from "./usageAttribution.js";

export interface EdgeConfig {
  /** Supabase 的 HS256 JWT secret(验客户端令牌) */
  jwtSecret: string;
  /** 平台身份（VPS 上的云 runtime）的共享密钥。不配置就没有这条路
      （ADR-0199）——本地/测试环境常常没有,这条路径就该整个不存在,
      不是"配了空字符串所以永远比不中" */
  runtimeSecret?: string;
}

/** 平台身份认作的 userId。relay 房间键、px 三道闸都认这个常量当"不是真人" */
export const RUNTIME_SERVICE_UID = "svc-runtime";

/** 一个用户的中继实例。生产上是 DO stub,测试里是个假货 */
export interface RelayStub {
  fetch(req: Request): Promise<Response>;
}

export type CheckoutTarget = { planId: PlanId } | { addon: true; quantity: number };

/** Supabase 的 user id 形状（`x-otto-on-behalf-of` 的唯一合法值，见 callerOf） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 计费面（spec 2026-09-02 第 3 节）。生产上是 worker.ts 里握 Stripe + Supabase 的实现，测试里是假货 */
export interface BillingPort {
  me(uid: string): Promise<BillingMe>;
  /** origin = 请求的 origin（拼 success/cancel/return url）。
      `code` 是给失败分类用的：`already_subscribed` 译成 409（用户拿它当「去管理页换档」的
      指示），其余失败一律 502 upstream（Stripe 那边的事）。分类留在 BillingPort 里做，
      因为「已有订阅」这件事只有握着 Supabase 的那一侧看得见 */
  checkout(uid: string, target: CheckoutTarget, origin: string): Promise<{ url: string } | { error: string; code?: "already_subscribed" }>;
  portal(uid: string, origin: string): Promise<{ url: string } | { error: string }>;
  /** 验签 + 落库都在里面；回 HTTP 状态与 body */
  webhook(payload: string, signatureHeader: string): Promise<{ status: number; body: unknown }>;
  /** 设置页「用量」tab（#946）：调用者必须在籍；周窗与聚合在 usageAttribution.ts */
  workspaceUsage(uid: string, workspaceId: string): Promise<
    { ok: true; value: WorkspaceUsage } | { ok: false; code: "not_member" | "not_found"; message: string }
  >;
}

export interface EdgeDeps {
  config: EdgeConfig;
  /** 注入时钟:过期判断要能被测试钉死 */
  now?: () => number;
  /** 按 userId 取中继实例。不注入就没有 /rl/v1/* */
  relay?: (userId: string) => RelayStub;
  /** 按 hostUid 取托管箱实例（ADR-0197 执行面）。不注入就没有 /px/v1/* */
  escrow?: (hostUid: string) => RelayStub;
  /** 关系闸：两人是否 accepted 好友（worker 用 service role 查，60s 缓存在那边做） */
  isFriend?: (a: string, b: string) => Promise<boolean>;
  /** 托管模型网关（Task 4 的 createLlmGateway）。不注入就没有 /llm/v1/* */
  llm?: (req: Request, caller: Caller) => Promise<Response>;
  /** 计费面。不注入就没有 /billing/v1/*（webhook 也没有） */
  billing?: BillingPort;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** 错误形状。`type` 是这个服务的签名,客户端据此认出"这是 edge 说的话" */
const apiError = (status: number, message: string, code: string): Response =>
  json(status, { error: { message, type: "otto_edge", code } });

/**
 * 从 `Sec-WebSocket-Protocol` 里取 token。
 *
 * **为什么不走 Authorization 头**:标准 WebSocket 构造函数只吃 `(url, protocols)`,
 * 带不了自定义头。**为什么不走 query 参数**:access token 会进各层访问日志和
 * Referer —— 那是把凭据写在地址栏上。子协议是唯一一条既标准、两端都支持、
 * 又不把 token 暴露在 URL 里的路(实测 741 字节的 Supabase JWT 通过)。
 *
 * 约定:客户端发 `[SUBPROTOCOL, token]`,服务端只 echo 回 SUBPROTOCOL ——
 * token 不该出现在任何响应头里。
 */
function subprotocolToken(req: Request): string {
  const raw = req.headers.get("sec-websocket-protocol") ?? "";
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts[0] !== SUBPROTOCOL) return "";
  return parts[1] ?? "";
}

/** 连接计数键（issue #824）。
 *
 * `MAX_CONNS_PER_USER` 这个名字一直在撒谎：DO 数的是**一个房间里的连接
 * 总数**，只有自远程那种「房间键就是 userId」的房间里，两者才碰巧相等。
 * `cs-ctl` 是全平台一个固定房（cloudSession.ts 的 csCtlChannel），于是
 * 上限变成"全平台同时最多 16 条人类连接进控制房"——一个人握住 16 条
 * socket，所有人都建不了云会话。
 *
 * 修法不是给 DO 一个 userId：好友代理房间的设计前提正是**中继不懂参与者
 * 是谁**（ADR-0151，鉴权在握手层），把 uid 递下去等于顺手拆了它。给的是
 * 一个**按房间加盐**的不可逆标记——同一个人在同一个房间里稳定相同，
 * 跨房间互不关联，DO 拿它只能做一件事：数数。
 *
 * 64 bit 截断：同房间内两个不同用户撞上的后果只是"共用一个计数桶"，
 * 不是越权，量级上也不会在这个规模出现。 */
async function connCountKey(userId: string, roomKey: string): Promise<string> {
  // 分隔符写成转义而不是真的敲一个 NUL 进源码：字面 NUL 会让 git 把整个
  // 文件当二进制（没有 diff、没法 merge），而这一层要的只是「roomKey 和
  // uid 拼不出歧义」——uid 里不可能出现它
  const bytes = new TextEncoder().encode(`${roomKey}\u0000${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createEdge(deps: EdgeDeps): (req: Request) => Promise<Response> {
  const { config } = deps;
  const now = deps.now ?? (() => Date.now());

  /** 验签取 userId。失败回一个现成的 Response。
      平台身份分支放在最前面但**不提前返回错误** —— 比不中就直接落进下面
      普通 JWT 校验那条路,错 secret 的响应因此和"随便一个烂 token"长得
      一模一样,不额外泄露"这个服务认识 runtime secret 这回事"(ADR-0199) */
  async function identify(token: string): Promise<{ userId: string } | Response> {
    if (!token) return apiError(401, `缺少凭据:子协议要写成 ["${SUBPROTOCOL}", <Supabase JWT>]`, "no_token");
    if (config.runtimeSecret && timingSafeEqual(token, config.runtimeSecret)) {
      return { userId: RUNTIME_SERVICE_UID };
    }
    const verified = await verifyJwt(token, config.jwtSecret, Math.floor(now() / 1000));
    if (!verified.ok) return apiError(401, verified.reason, "bad_token");
    return { userId: verified.claims.sub };
  }

  async function relayConnect(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return apiError(426, "这个端点只收 WebSocket upgrade", "upgrade_required");
    }
    if (!deps.relay) return apiError(404, "这个服务没开远程中继", "relay_disabled");

    const who = await identify(subprotocolToken(req));
    if (who instanceof Response) return who;

    const params = new URL(req.url).searchParams;
    let role: RelayRole | null = parseRole(params.get("role"));
    if (!role) return apiError(400, "role 必须是 desktop/mobile/host/guest", "bad_role");

    // 房间键:带 channel 参数就按 channel 分房间(好友代理,issue #622),
    // 否则按 userId(自远程,向后兼容)。好友代理里 A 和 B 是两个 userId,
    // 只有按「同一个 channelId」才能进同一房间。channelId 是邀请码里的随机
    // 32 字节——知道它 = 被邀请,relay 不用懂好友关系(鉴权在握手层,ADR-0151)。
    const channel = params.get("channel");

    // cs-* 房间(工作区云会话,ADR-0199)角色收口(终审 C1):role=host 仅当
    // 对面是平台身份(VPS runtime,已在上面 identify() 里用
    // x-runtime-secret/子协议 secret 验过)。真人一律降级成 guest——cs 房名
    // 是 `cs-${workspaceId}-${sessionId}`,现任成员和被踢的前成员都知道,
    // 不做这道收口的话谁先连上谁就能抢到 host 角色,relay 会把它当权威向
    // 其余 guest 广播:真 runtime 的帧被丢弃、攻击者的帧被当权威(伪造
    // welcome/event,截获 say 正文与 approve)。好友代理房间不受影响——
    // 那里 host/guest 是两个真人各自的角色,鉴权在握手层(ADR-0151 的
    // tryPair),不是这里。
    //
    // 判据是 isCsChannel 的**精确格式匹配**,不是「以 cs- 开头」(终审复审
    // R1):好友代理的 channelId 是随机 base64url(b64encode(randomBytes(32)),
    // 字母表含 `-`),约 1/262144 的邀请码恰好会生成 `cs-` 开头的房名——
    // 只看前缀的话,撞上时代理房间里真人的 host 会被误降级成 guest,
    // 双方都变 guest 后 peersOf 永远配不上、也没有任何报错。isCsChannel
    // 与 csChannel()/csCtlChannel() 同源于 cloudSession.ts,要求精确长度 +
    // 十六进制字母表 + 固定短横线位置,随机串撞不上。
    if (role === "host" && channel !== null && isCsChannel(channel) && who.userId !== RUNTIME_SERVICE_UID) {
      role = "guest";
    }

    const roomKey = channel ? `proxy:${channel}` : who.userId;

    // 平台身份豁免 MAX_CONNS_PER_USER:同一枚 runtime 账号从多台 VPS 并发连,
    // 是合法的多实例形态,不是滥用信号。DO 自己不认识 userId(只认识这条
    // 转发请求),所以豁免要靠这个显式标记带过去,由 worker.ts 的 Relay.fetch 读
    const svcFlag = who.userId === RUNTIME_SERVICE_UID ? "&svc=1" : "";

    // 连接计数键（issue #824）：DO 按它分桶数连接数，见 connCountKey 的注释。
    // 它不是身份，只是"同一个人在这个房间里的第几条"的分组依据
    const ck = await connCountKey(who.userId, roomKey);

    // 转给 DO 的请求**不带 token**:验完就到此为止,DO 只需要知道 role。
    // 换一个干净的 Request 而不是原样转发 —— 原样转发等于把凭据再往下游递一层
    return deps.relay(roomKey).fetch(
      new Request(`https://relay/connect?role=${role}${svcFlag}&ck=${ck}`, {
        headers: { upgrade: "websocket" },
      })
    );
  }

  /** px 路由的鉴权走 Authorization: Bearer——普通 HTTP，没有 WS 的子协议限制。
      平台身份走另一个 header（`x-runtime-secret`），同一条"比不中就落进普通
      JWT 校验、不提前报错"的纪律（ADR-0199）：没带这个 header、带了但比不中，
      两种情况都直接往下走 Authorization 那条老路，响应形状不因为多试了一次
      secret 比对而变化 */
  async function pxIdentify(req: Request): Promise<{ userId: string } | Response> {
    const svc = req.headers.get("x-runtime-secret");
    if (svc !== null && config.runtimeSecret && timingSafeEqual(svc, config.runtimeSecret)) {
      return { userId: RUNTIME_SERVICE_UID };
    }
    const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
    if (!m) return apiError(401, "缺少凭据：Authorization: Bearer <Supabase JWT>", "no_token");
    const verified = await verifyJwt(m[1]!, config.jwtSecret, Math.floor(now() / 1000));
    if (!verified.ok) return apiError(401, verified.reason, "bad_token");
    return { userId: verified.claims.sub };
  }

  /** 好友代理云端执行面（ADR-0197）。edge 只做：验人 → 关系闸 → 转给 hostUid
      的托管箱 DO。白名单闸与执行在 DO 里（凭据不出 DO）。转发的请求不带 token，
      但带上已验实的 fromUid——与 relayConnect 同一条「验完就到此为止」的纪律 */
  async function px(req: Request, pathname: string): Promise<Response> {
    if (!deps.escrow || !deps.isFriend) return apiError(404, "这个服务没开云端执行面", "px_disabled");
    const who = await pxIdentify(req);
    if (who instanceof Response) return who;
    const forward = (hostUid: string, op: string, body: unknown): Promise<Response> =>
      deps.escrow!(hostUid).fetch(new Request(`https://px/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));

    if (pathname === "/px/v1/escrow") {
      // 自己的箱子自己写/删：hostUid 恒等于 JWT 的 sub，路径上不接受指定别人
      if (req.method === "PUT") {
        const doc = parseEscrowDoc(await req.json().catch(() => null));
        if (!doc) return apiError(400, "托管文档形状不对", "bad_doc");
        if (doc.hostUid !== who.userId) return apiError(403, "只能托管自己的服务", "not_yours");
        return forward(who.userId, "put", { doc });
      }
      if (req.method === "DELETE") return forward(who.userId, "delete", {});
      return apiError(405, "escrow 只收 PUT / DELETE", "method_not_allowed");
    }

    if (pathname === "/px/v1/grants" && req.method === "GET") {
      const host = new URL(req.url).searchParams.get("host") ?? "";
      if (!host) return apiError(400, "缺 host 参数", "bad_request");
      // 平台身份没有自己的 JWT sub 可用——它是替一个真用户在打这个接口,
      // 那个真用户是谁必须显式声明,不能像普通请求那样从 who.userId 直接拿
      // （ADR-0199）。三道闸照跑：下面这行 isFriend 用的就是声明出来的 fromUid
      let fromUid = who.userId;
      if (who.userId === RUNTIME_SERVICE_UID) {
        const declared = new URL(req.url).searchParams.get("fromUid") ?? "";
        if (!declared) return apiError(400, "平台身份必须显式声明 fromUid", "bad_request");
        fromUid = declared;
      }
      // 不再在门口拒非好友：同工作区成员不必是好友（ADR-0198）。
      // 关系闸整个下沉进 DO——它读得到 doc，才知道要查哪些 workspace 的在籍
      const friend = await deps.isFriend(fromUid, host);
      return forward(host, "grants", { fromUid, friendAccepted: friend });
    }

    if (pathname === "/px/v1/call" && req.method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      const b = body as { hostUid?: unknown; serverId?: unknown; tool?: unknown; args?: unknown; fromUid?: unknown } | null;
      if (!b || typeof b.hostUid !== "string" || typeof b.serverId !== "string" || typeof b.tool !== "string") {
        return apiError(400, "call 要 hostUid/serverId/tool", "bad_request");
      }
      // 同上：平台身份必须显式声明代理谁；普通用户继续按老规矩——身份闸
      // 比自报硬，fromUid 只能是 JWT 的 sub，body 里冒充别人没有用
      let fromUid = who.userId;
      if (who.userId === RUNTIME_SERVICE_UID) {
        if (typeof b.fromUid !== "string" || !b.fromUid) {
          return apiError(400, "平台身份必须显式声明 fromUid", "bad_request");
        }
        fromUid = b.fromUid;
      }
      const friend = await deps.isFriend(fromUid, b.hostUid);
      return forward(b.hostUid, "call", {
        fromUid, serverId: b.serverId, tool: b.tool, args: b.args ?? {}, friendAccepted: friend,
      });
    }

    if (pathname === "/px/v1/audit" && req.method === "GET") {
      const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
      return forward(who.userId, "audit", { since: Number.isFinite(since) ? since : 0 });
    }

    return apiError(404, `没有这个端点:${pathname}`, "not_found");
  }

  /** llm / billing 路由的身份：pxIdentify 那一套 + on-behalf-of。
      平台身份**必须**带 x-otto-on-behalf-of（它没有自己的 sub，代表谁要说清楚）；
      真人**不许**带（能代表别人的只有平台）。两条都是 400 而不是静默忽略——
      一个带着这个头却被当成本人处理的请求，正是「以为在替 A 扣、其实扣了自己」那种账 */
  async function callerOf(req: Request): Promise<Caller | Response> {
    const who = await pxIdentify(req);
    if (who instanceof Response) return who;
    const onBehalf = req.headers.get(ON_BEHALF_HEADER);
    // I4：这个头的值会直接变成 `uid`——被扣钱的那个人。它不经过任何签名，
    // 只靠「知道 RUNTIME_SECRET」这一条撑着，所以形状必须自己把一次关：
    // Supabase 的 user id 是 uuid，不是 uuid 的一律 400。不校验的话一个笔误
    // 就能凭空开出一个谁都不是的额度户头（DO 按 uid 分实例），而它在账上
    // 长得跟一个真人一模一样
    if (onBehalf !== null && !UUID_RE.test(onBehalf)) {
      return apiError(400, `${ON_BEHALF_HEADER} 必须是 uuid`, "bad_request");
    }
    let uid = who.userId;
    let source: Caller["source"] = "desktop";
    if (who.userId === RUNTIME_SERVICE_UID) {
      if (!onBehalf) return apiError(400, `平台身份必须声明 ${ON_BEHALF_HEADER}`, "bad_request");
      uid = onBehalf;
      source = "runtime";
    } else if (onBehalf !== null) {
      return apiError(400, `只有平台身份能带 ${ON_BEHALF_HEADER}`, "bad_request");
    }
    // 上限 128：这两个头最终落进 Task 7 的 DB 行，不截断就是把「请求头长度不设防」
    // 变成「数据库行长度不设防」——同一个把关做一次，放在身份出口最省心
    return {
      uid, source,
      workspaceId: (req.headers.get(WORKSPACE_HEADER) ?? "").slice(0, 128),
      sessionId: (req.headers.get(SESSION_HEADER) ?? "").slice(0, 128),
      agentId: (req.headers.get(AGENT_HEADER) ?? "").slice(0, 128),
    };
  }

  async function billingRoute(req: Request, pathname: string): Promise<Response> {
    if (!deps.billing) return apiError(404, "这个服务没开计费面", "billing_disabled");
    const origin = new URL(req.url).origin;

    // 付款完成/取消后浏览器落的页：给人看的一句话，不要令牌（同 /auth/landing 的理由）
    if (pathname === "/billing/v1/done") {
      const ok = new URL(req.url).searchParams.get("ok") !== "0";
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Mr Otto</title>` +
        `<body style="font-family:system-ui;padding:3rem;text-align:center">` +
        `<h1>${ok ? "付款完成" : "已取消"}</h1><p>${ok ? "回到 Mr Otto，额度已经生效。" : "什么都没发生，回到 Mr Otto 即可。"}</p></body>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    // Stripe → 我们。不验 JWT（Stripe 不带），验签在 BillingPort 里做
    if (pathname === "/billing/v1/webhook") {
      if (req.method !== "POST") return apiError(405, "只收 POST", "method_not_allowed");
      // 这条路没有 JWT 挡在前面，正文大小是唯一的门槛：真 Stripe 事件远小于 1 MB，
      // 读大正文之前先按 content-length 拒绝，别把整份未鉴权的 body 吃进内存
      if (Number(req.headers.get("content-length") ?? 0) > 1_000_000) {
        return apiError(413, "webhook 正文过大", "payload_too_large");
      }
      const r = await deps.billing.webhook(await req.text(), req.headers.get("stripe-signature") ?? "");
      return json(r.status, r.body);
    }

    const caller = await callerOf(req);
    if (caller instanceof Response) return caller;

    if (pathname === "/billing/v1/me" && req.method === "GET") {
      // 计费面后面是 Quota DO + Supabase：它们抖一下不该变成一个没有 otto_edge
      // 信封的裸 500 —— 客户端的 parseBillingError 认不出那种响应，界面上会
      // 退化成"未知错误"而不是"稍后再试"
      try {
        return json(200, await deps.billing.me(caller.uid));
      } catch (err) {
        return apiError(502, `取额度失败：${err instanceof Error ? err.message : String(err)}`, "upstream");
      }
    }

    if (pathname === "/billing/v1/workspace-usage" && req.method === "GET") {
      // 平台身份代表谁都没意义（它不会来看设置页），和下面 checkout/portal 同一条理由
      if (caller.source === "runtime") return apiError(403, "平台身份不能查工作区用量", "forbidden");
      const workspaceId = new URL(req.url).searchParams.get("workspace") ?? "";
      if (!WORKSPACE_ID_RE.test(workspaceId)) return apiError(400, "workspace 必须是 uuid", "bad_request");
      try {
        const r = await deps.billing.workspaceUsage(caller.uid, workspaceId);
        if (r.ok) return json(200, r.value);
        return apiError(r.code === "not_member" ? 403 : 404, r.message, r.code);
      } catch (err) {
        return apiError(502, `取用量失败：${err instanceof Error ? err.message : String(err)}`, "upstream");
      }
    }

    // 下面两条是人的动作：平台身份替人买东西没有意义（钱是人付的）
    if (caller.source === "runtime") return apiError(403, "平台身份不能发起购买", "forbidden");

    if (pathname === "/billing/v1/checkout" && req.method === "POST") {
      const b: unknown = await req.json().catch(() => null);
      const o = b as { planId?: unknown; addon?: unknown; quantity?: unknown } | null;
      let target: CheckoutTarget | null = null;
      if (o && (o.planId === "lite" || o.planId === "pro" || o.planId === "max")) target = { planId: o.planId };
      else if (o && o.addon === true) {
        const q = o.quantity;
        if (typeof q !== "number" || !Number.isInteger(q) || q <= 0 || q > MAX_GRANT_QUANTITY) {
          return apiError(400, `quantity 必须是 1..${MAX_GRANT_QUANTITY} 的整数`, "bad_request");
        }
        target = { addon: true, quantity: q };
      }
      if (!target) return apiError(400, "checkout 要 {planId: lite|pro|max} 或 {addon:true, quantity}", "bad_request");
      const r = await deps.billing.checkout(caller.uid, target, origin);
      if ("url" in r) return json(200, r);
      // C2：已有订阅还去开一张订阅 Checkout，Stripe 会**再建一条订阅**，两笔一起扣。
      // 这不是上游出错（502 会被客户端当成「稍后再试」然后重试，正好把第二笔开出来），
      // 是这次请求本身不该发生 —— 409，客户端据此把人引到「管理」页换档
      return r.code === "already_subscribed"
        ? apiError(409, r.error, "already_subscribed")
        : apiError(502, r.error, "upstream");
    }
    if (pathname === "/billing/v1/portal" && req.method === "POST") {
      const r = await deps.billing.portal(caller.uid, origin);
      return "url" in r ? json(200, r) : apiError(502, r.error, "upstream");
    }
    return apiError(404, `没有这个端点:${pathname}`, "not_found");
  }

  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/healthz") return json(200, { ok: true });
    // OAuth 落地页(无鉴权,浏览器裸访问):深链转发让登录流在浏览器里有个明确终点
    if (pathname === "/auth/landing") {
      return req.method === "GET"
        ? authLandingResponse()
        : apiError(405, "只收 GET", "method_not_allowed");
    }
    if (pathname === "/rl/v1/connect") return relayConnect(req);
    if (pathname.startsWith("/px/v1/")) return px(req, pathname);
    if (pathname === "/llm/v1/chat/completions") {
      if (!deps.llm) return apiError(404, "这个服务没开托管网关", "llm_disabled");
      if (req.method !== "POST") return apiError(405, "只收 POST", "method_not_allowed");
      const caller = await callerOf(req);
      if (caller instanceof Response) return caller;
      return deps.llm(req, caller);
    }
    if (pathname.startsWith("/billing/v1/")) return billingRoute(req, pathname);
    return apiError(404, `没有这个端点:${pathname}`, "not_found");
  };
}
