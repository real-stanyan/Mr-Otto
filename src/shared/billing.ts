// 订阅计费的线上约定——edge Worker / 桌面主进程 / 云 runtime **三端共用一份**
// （纪律同 src/shared/remote/wire.ts：改这里 = 三端一起改）。
// 数字全是 micro-USD 整数（1 USD = 1_000_000），显示层才换成 credit。
// 1 credit = 1 美分 = 10_000 micro。用户看到的额度不是钱数，是 credit：
// 托管模式的花费和 BYOK 的「$X」不能长得一样（ADR-0176 决定五）。

export type PlanId = "lite" | "pro" | "max";
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "none";

export interface WindowState {
  usedMicro: number;
  limitMicro: number;
  /** 这个窗口什么时候清零（epoch ms）。倒计时从这里来 */
  resetAt: number;
}

/** 服务端下发的档位价目（plan 表是事实——改价不发版，客户端不抄）。
    三档之外还有 addon 行：它不下发，加购按钮的单价是 checkout 那边的参数 */
export interface PlanInfo {
  id: PlanId;
  /** 月费，美元分（plan.price_usd_cents） */
  priceUsdCents: number;
  /** 档位能力（plan.capabilities）。`image`/`video` 是多模态门禁：false 的档在 hosted
      路上收不到这类输入。`workspace` 是「这一档能不能建团队」（#1024）。
      三格一律「读不到按 false」—— 给没买的能力开门是漏钱，关门只是少一颗按钮；
      `workspace` 那一格的「服务端还没有这个概念」由 `workspaceAccess` 另行分辨，
      不在解析这一层猜（见那个文件的注释） */
  capabilities: { image: boolean; video: boolean; workspace: boolean };
}

export interface BillingMe {
  plan: PlanId | null;
  status: SubscriptionStatus;
  /** 全部档位的服务端价目。订阅卡片渲染这里的数（ADR-0203 偏差 (a)：
      渲染层那份写死的 PLAN_CARDS 价格曾经在改价那天与结账页对不上） */
  plans: PlanInfo[];
  /** null = 没有活跃订阅（没窗口可言） */
  windows: { h5: WindowState; week: WindowState } | null;
  addon: { remainingMicro: number; expiresAt: number | null };
  periodEnd: number | null;
  /** 网关此刻供的逻辑型号 id（model_route 里 enabled 的）。
      **从便宜到贵有序**（ADR-0237：routesQuery 按 priority,输出价,id 全序），
      所以 `models[0]` = 没指定型号时用的那款，`at(-1)` = 最贵那款 */
  models: string[];
  /** 网关此刻供的**出图**型号（`model_route` 里 kind='image' 那些，#1081）。
      与 `models` 分开是因为它们的消费方完全不同：`models` 喂输入框那枚模型选择器，
      这一格喂 `generate_image` 那把刀。合成一格的代价写在 ADR 里 —— ADR-0237 的
      Auto 拿 `models.at(-1)` 当「最贵 = 最强」，出图那款 $60/M 会直接变成 hard 档主模型。
      **缺席 = 空数组**（旧 edge / 迁移还没跑）＝ 这台网关不供出图，工具不挂 —— 
      也就是改动前的行为 */
  imageModels: string[];
  /** 型号 id → `model_route.platform`（`deepseek` / `zhipu` / `qwen`…，#1011）。
      **不靠 id 前缀猜**：`glm-*` 属于智谱今天成立，只是因为这些 id 是我们自己在
      `model_route` 里写的——那是巧合不是保证，而这一列就是答案。
      旧 edge 不发这一格 = 空对象，消费方（下拉里的 logo）画不出来就不画 */
  modelPlatforms: Record<string, string>;
}

export const BILLING_HEADERS = {
  h5: "x-otto-window-5h-remaining",
  week: "x-otto-window-week-remaining",
  addon: "x-otto-addon-remaining",
  plan: "x-otto-plan",
  /** 本次调用结算的 credit（micro-USD）。只有 2xx 的响应带它——hold 被拒的
      响应带的是剩余额度，没有「本次花费」可言。非 2xx 一律按 0 处理（上游出错
      release 了，没花钱） */
  cost: "x-otto-cost-micro",
} as const;

/** 流式响应里那笔「本次花费」的尾注（#857 的另一半）。
    响应头放不下它：流式的 settle 发生在流收尾那一刻，而响应头早在第一个字节之前
    就发出去了。所以它跟在最后一个上游帧（含 `data: [DONE]`）之后，写成一行
    **SSE 注释**——注释行以 `:` 开头，合规的 SSE 解析器一律跳过，对任何
    OpenAI 兼容客户端都是隐形的；换成一个自造的 `data:` 帧就得赌对方的解析器
    对不认识的 chunk 形状足够宽容，而那是它们没有义务做到的事。
    形如 `: otto-cost-micro 1234`（micro-USD）。 */
export const SSE_COST_COMMENT = ": otto-cost-micro ";

/** 一行 SSE 里读出那笔尾注；不是这行就 null。缺席 ≠ 0 —— 调用方据此不记这笔 */
export function parseSseCostComment(line: string): number | null {
  if (!line.startsWith(SSE_COST_COMMENT)) return null;
  const n = Number(line.slice(SSE_COST_COMMENT.length).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 平台身份（runtime）代表哪个真用户；桌面 JWT 带这个头一律 400 */
export const ON_BEHALF_HEADER = "x-otto-on-behalf-of";
export const WORKSPACE_HEADER = "x-otto-workspace";
export const SESSION_HEADER = "x-otto-session";
/** runtime 替工作区 agent 调网关时带的 agent_id（#946，spec §7）。桌面直连不带。
    值落 usage_event.agent_id；名字随时会改，所以带的是 id */
export const AGENT_HEADER = "x-otto-agent";

/** 单用户并发上限（ADR-0174 第 5 条「加购无视限速」的兜底）。**住在 shared 不住在
    edge**（#960）：闸门开在 edge 的 Quota DO 里，但撞上它的人在 runtime 和桌面，
    而给人看的那句话要把这个数字念出来（「同一时刻最多 N 条」）。抄一份到 runtime
    的下场是闸门改了、话没改——一个说 4、一个说 6，两句都言之凿凿。
    edge 的 `services/edge/src/quota.ts` 从这里 import 再 re-export（既有 import 方不变） */
export const MAX_INFLIGHT = 4;

export type BillingErrorCode =
  | "bad_token"
  | "no_subscription"
  | "quota_exhausted"
  | "unknown_model"
  | "upstream"
  | "too_many_inflight"
  | "bad_request"
  | "forbidden"
  /** 已经有一条非 canceled 的订阅，还想再开一张订阅 Checkout（C2）。
      不是「买不起」也不是「参数错」——换档要走 Stripe 的 Customer Portal，
      再开一张会在 Stripe 那边长出**第二条订阅**，两笔一起扣款 */
  | "already_subscribed"
  /** webhook 正文超过 1 MB 被 edge 在读 body 之前拒掉（413）。面向 Stripe 不面向客户端，
      列进来只是让 `parseBillingError` 认得 edge 发出的**每一个** code（#867） */
  | "payload_too_large"
  /** GET /billing/v1/workspace-usage：查的人已经不在这个工作区里了（403，#946 切片 3） */
  | "not_member"
  /** 同上端点：workspace id 查无此工作区（404） */
  | "not_found";

export interface BillingError {
  code: BillingErrorCode;
  message: string;
  window?: "5h" | "week";
  resetAt?: number;
}

const CODES: ReadonlySet<string> = new Set([
  "bad_token", "no_subscription", "quota_exhausted", "unknown_model", "upstream", "too_many_inflight", "bad_request",
  "forbidden", "already_subscribed", "payload_too_large", "not_member", "not_found",
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** 只认 edge 的信封（type: "otto_edge" + 认识的 code）。上游原样透传回来的错误不是它 */
export function parseBillingError(status: number, payload: unknown): BillingError | null {
  if (status < 400 || !isObj(payload) || !isObj(payload.error)) return null;
  const e = payload.error;
  if (e.type !== "otto_edge" || typeof e.code !== "string" || !CODES.has(e.code)) return null;
  const out: BillingError = {
    code: e.code as BillingErrorCode,
    message: typeof e.message === "string" ? e.message : "",
  };
  if (e.window === "5h" || e.window === "week") out.window = e.window;
  if (typeof e.resetAt === "number") out.resetAt = e.resetAt;
  return out;
}

function parseWindow(v: unknown): WindowState | null {
  if (!isObj(v)) return null;
  const { usedMicro, limitMicro, resetAt } = v;
  if (typeof usedMicro !== "number" || typeof limitMicro !== "number" || typeof resetAt !== "number") return null;
  return { usedMicro, limitMicro, resetAt };
}

export function parseBillingMe(payload: unknown): BillingMe | null {
  if (!isObj(payload)) return null;
  const plan = payload.plan === "lite" || payload.plan === "pro" || payload.plan === "max" ? payload.plan : null;
  const status = payload.status;
  if (status !== "active" && status !== "past_due" && status !== "canceled" && status !== "none") return null;
  let windows: BillingMe["windows"] = null;
  if (payload.windows !== null) {
    if (!isObj(payload.windows)) return null;
    const h5 = parseWindow(payload.windows.h5);
    const week = parseWindow(payload.windows.week);
    if (!h5 || !week) return null;
    windows = { h5, week };
  }
  if (!isObj(payload.addon) || typeof payload.addon.remainingMicro !== "number") return null;
  const expiresAt = typeof payload.addon.expiresAt === "number" ? payload.addon.expiresAt : null;
  const periodEnd = typeof payload.periodEnd === "number" ? payload.periodEnd : null;
  const models = Array.isArray(payload.models) ? payload.models.filter((m): m is string => typeof m === "string") : [];
  // 缺席 = 旧 edge / 迁移还没跑 = 这台网关不供出图。**不能让它把整份快照解析成 null**：
  // 那会把「edge 比我旧」升级成「拿不到订阅状态」（同下面 modelPlatforms 的立场）
  const imageModels = Array.isArray(payload.imageModels) ? payload.imageModels.filter((m): m is string => typeof m === "string") : [];
  // 缺席 / 形状不对一律回空对象——这一格只喂 logo，读不到就不画，不该让整份
  // 快照解析失败（那会把「edge 比我旧」升级成「拿不到订阅状态」）
  const modelPlatforms: Record<string, string> = {};
  if (isObj(payload.modelPlatforms)) {
    for (const [k, v] of Object.entries(payload.modelPlatforms)) {
      if (typeof v === "string") modelPlatforms[k] = v;
    }
  }
  const plans: PlanInfo[] = [];
  if (Array.isArray(payload.plans)) {
    for (const p of payload.plans) {
      if (!isObj(p)) continue;
      const pid = p.id;
      if ((pid === "lite" || pid === "pro" || pid === "max") && typeof p.priceUsdCents === "number" && Number.isFinite(p.priceUsdCents)) {
        const caps = isObj(p.capabilities) ? p.capabilities : {};
        plans.push({
          id: pid, priceUsdCents: p.priceUsdCents,
          // 缺省 false（关）：门禁漏报的能力按没有算——给没买的能力开门是漏钱，
          // 给买了的能力关门是 UI 上少一颗按钮，前者才不可逆
          capabilities: {
            image: caps.image === true,
            video: caps.video === true,
            workspace: caps.workspace === true,
          },
        });
      }
    }
  }
  return { plan, status, plans, windows, addon: { remainingMicro: payload.addon.remainingMicro, expiresAt }, periodEnd, models, imageModels, modelPlatforms };
}

export const MICRO_PER_CREDIT = 10_000;

export function creditOf(micro: number): number {
  return micro / MICRO_PER_CREDIT;
}

/** "12.3 credit"。整数不带小数点：0 credit 比 0.0 credit 读得顺 */
export function fmtCredit(micro: number): string {
  const c = creditOf(micro);
  return `${Number.isInteger(c) ? c : c.toFixed(1)} credit`;
}

/** 响应头里的剩余额度。缺的头不进结果——「没报」≠「剩 0」 */
export function remainingFromHeaders(h: Headers): { h5?: number; week?: number; addon?: number; plan?: string } {
  const out: { h5?: number; week?: number; addon?: number; plan?: string } = {};
  const num = (name: string): number | undefined => {
    const raw = h.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const h5 = num(BILLING_HEADERS.h5);
  const week = num(BILLING_HEADERS.week);
  const addon = num(BILLING_HEADERS.addon);
  const plan = h.get(BILLING_HEADERS.plan);
  if (h5 !== undefined) out.h5 = h5;
  if (week !== undefined) out.week = week;
  if (addon !== undefined) out.addon = addon;
  if (plan) out.plan = plan;
  return out;
}

/** 设置页「用量」tab 的一行：某只 agent 本周烧了多少（#946）。agentId 空串 = 未归因
    （桌面直连 / 0022 之前的旧行） */
export interface WorkspaceUsageRow {
  agentId: string;
  costMicro: number;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** GET /billing/v1/workspace-usage 的响应。周窗是 **owner** 的（ADR-0217：工作区烧的是
    owner 的额度），起点与 Quota DO 同一份 weekStartFor——同一扇窗两个界面不能给出两个数 */
export interface WorkspaceUsage {
  workspaceId: string;
  ownerUid: string;
  weekStartAt: number;
  weekEndAt: number;
  /** 所有者这一档的**周额度上限**（micro）——用量页把每只 agent 的花费换算成
      「占本周额度的百分之几」的那个分母（#1120）。credit 也是一笔钱数（1 credit =
      1 美分，见文件头注），而云会话统一走所有者的订阅额度（ADR-0233）：用户问这个数
      就是想知道「我还能干多久」，ADR-0209/0239 已经为账号页与浮层判过同一条。

      **`null` = 没有活跃订阅，或这台 edge 还不发这一格**（旧版本）。两种都表示
      「分母缺席」，界面退回「占本团队本周用量的百分比」并说明换了口径——**绝不
      回落到 credit**：那正是这次要拆掉的东西。 */
  weekLimitMicro: number | null;
  rows: WorkspaceUsageRow[];
}

export function parseWorkspaceUsage(payload: unknown): WorkspaceUsage | null {
  if (!isObj(payload)) return null;
  const { workspaceId, ownerUid, weekStartAt, weekEndAt } = payload;
  if (typeof workspaceId !== "string" || typeof ownerUid !== "string") return null;
  if (typeof weekStartAt !== "number" || typeof weekEndAt !== "number") return null;
  // 缺席 = null（旧 edge 不发这一格），不是解析失败：新客户端连老网关时整张表还得画得出来
  const rawLimit = payload.weekLimitMicro;
  const weekLimitMicro =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null;
  if (!Array.isArray(payload.rows)) return null;
  const rows: WorkspaceUsageRow[] = [];
  for (const r of payload.rows) {
    if (!isObj(r) || typeof r.agentId !== "string") return null;
    const nums = [r.costMicro, r.calls, r.promptTokens, r.cachedTokens, r.completionTokens];
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    rows.push({
      agentId: r.agentId, costMicro: r.costMicro as number, calls: r.calls as number,
      promptTokens: r.promptTokens as number, cachedTokens: r.cachedTokens as number, completionTokens: r.completionTokens as number,
    });
  }
  return { workspaceId, ownerUid, weekStartAt, weekEndAt, weekLimitMicro, rows };
}
