import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  modelsForMe, grantByPaymentIntentQuery, grantInsertBody, grantsQuery, meFromParts, pageAll, pagedQuery, parseGrantRow,
  parseGrantRows, parsePlanRows, parseRouteRows, parseSubscriptionOwner, parseSubscriptionRows, parseUsageEventRows,
  planIdForPrice, planSnapshotOf, plansQuery, REBUILD_PAGE_SIZE, routesQuery, subscriptionByStripeIdQuery,
  subscriptionQuery, subscriptionUpsertBody, usageEventInsert, usageEventsQuery,
} from "../../services/edge/src/billingQueries.js";

const plans = [
  { id: "lite", week_limit_micro: 3_325_000, window5h_limit_micro: 665_000, addon_unit_micro: 0, stripe_price_id: "price_lite", price_usd_cents: 1900, capabilities: { image: false, video: false, workspace: false } },
  { id: "addon", week_limit_micro: 0, window5h_limit_micro: 0, addon_unit_micro: 7_000_000, stripe_price_id: "price_addon", price_usd_cents: 1000, capabilities: { image: false, video: false, workspace: false } },
];
const sub = {
  user_id: "u1", plan_id: "lite", status: "active", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
  current_period_start: "2026-09-01T00:00:00+00:00", current_period_end: "2026-10-01T00:00:00+00:00",
  last_event_at: "2026-09-01T00:00:00+00:00",
};

describe("查询串", () => {
  it("subscriptionQuery 按 user_id 过滤且只取一行，select 带 last_event_at（乱序防护要读它）", () => {
    expect(subscriptionQuery("u1")).toBe("subscription?user_id=eq.u1&select=user_id,plan_id,status,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end,last_event_at&limit=1");
  });
  it("subscriptionByStripeIdQuery 按 stripe_subscription_id 反查 user_id", () => {
    expect(subscriptionByStripeIdQuery("sub_1")).toContain("stripe_subscription_id=eq.sub_1");
    expect(subscriptionByStripeIdQuery("sub_1")).toContain("select=user_id,last_event_at");
  });
  it("routesQuery 只取 enabled 且未量化、按 priority 升序", () => {
    expect(routesQuery()).toContain("enabled=eq.true");
    expect(routesQuery()).toContain("quantization=eq.none");
    expect(routesQuery()).toContain("order=priority.asc");
  });
  it("routesQuery 的 select 带 kind —— 出图行要能和聊天行分开（#1081）", () => {
    // 不带这一列，parseRouteRows 只能把每一行都当 chat，于是出图行会漏进
    // `me.models`（那是输入框那枚模型选择器的数据源），而 ADR-0237 的 Auto
    // 拿 `models.at(-1)` 当「最贵 = 最强」——$60/M 会让出图模型变成 hard 档主模型
    expect(routesQuery()).toContain("kind");
  });
  it("routesQuery 的排序是**全序**：priority 同分时按输出价、再同分按 id（#1009）", () => {
    // 这条断言钉的是两件事同时成立的前提：`me.models[0]` = 没指定型号时用哪款
    // （六行 priority 全是 10，只按 priority 排 = 未定义顺序 = 碰运气），
    // 以及 Auto 那一档拿「第一个/最后一个」当「最便宜/最贵」（autoModel.ts）。
    // 少一个键，那两处就同时从「承诺」退回「今天碰巧是这样」
    expect(routesQuery()).toContain("order=priority.asc,price_out_micro_per_m.asc,id.asc");
  });
  it("grantsQuery：拉这个人全部 grant（含过期）+ 幂等键，created_at,id 稳定全序（#863 / #862 / #858）", () => {
    const q = grantsQuery("u1");
    expect(q).toContain("credit_grant?user_id=eq.u1");
    expect(q).not.toContain("expires_at=gt."); // 过期的也要：重放里它们吸收自己那份历史消费
    expect(q).toContain("select=micro_usd,expires_at,created_at,stripe_payment_intent_id");
    expect(q).toContain("order=created_at.asc,id.asc");
    expect(q).not.toContain("limit="); // limit/offset 由 pageAll 追加
  });
  it("usageEventsQuery：按类别 + since，带 window_open_at 锚，稳定全序，不钉 limit", () => {
    const q = usageEventsQuery("u1", "window", Date.UTC(2026, 8, 1));
    expect(q).toContain("charged_to=eq.window");
    expect(q).toContain("created_at=gte.2026-09-01T00:00:00.000Z");
    expect(q).toContain("select=created_at,cost_micro,charged_to,window_open_at");
    expect(q).toContain("order=created_at.asc,id.asc");
    expect(q).not.toContain("limit=");
    expect(q).not.toContain("sum"); // 不用聚合（文件头）
    expect(usageEventsQuery("u1", "addon", 0)).toContain("charged_to=eq.addon");
  });
  it("pagedQuery 追加 limit/offset", () => {
    expect(pagedQuery("t?a=1", 1000, 2000)).toBe("t?a=1&limit=1000&offset=2000");
  });
  it("pageAll：翻到不足一页为止，把每页拼起来（#858：单次 limit 是硬上限，超了静默截断）", async () => {
    const seen: string[] = [];
    const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
    const get = async (q: string) => {
      seen.push(q);
      const m = /limit=(\d+)&offset=(\d+)/.exec(q)!;
      return rows.slice(Number(m[2]), Number(m[2]) + Number(m[1]));
    };
    const all = await pageAll(get, "usage_event?x=1");
    expect(all).toHaveLength(2500);
    expect(seen).toEqual([
      `usage_event?x=1&limit=${REBUILD_PAGE_SIZE}&offset=0`,
      `usage_event?x=1&limit=${REBUILD_PAGE_SIZE}&offset=${REBUILD_PAGE_SIZE}`,
      `usage_event?x=1&limit=${REBUILD_PAGE_SIZE}&offset=${2 * REBUILD_PAGE_SIZE}`,
    ]);
    // 正好整页：还要再翻一页确认没了
    const exact = await pageAll(async (q) => (q.includes("offset=0") ? [1, 2] : []), "t?y=1", { pageSize: 2 });
    expect(exact).toEqual([1, 2]);
  });
  it("pageAll：翻到上限抛错，不静默收口；回的不是数组也抛", async () => {
    const endless = async () => Array.from({ length: 10 }, () => ({}));
    await expect(pageAll(endless, "usage_event?x=1", { pageSize: 10, maxPages: 3 })).rejects.toThrow(/超过 30 行/);
    await expect(pageAll(async () => ({ error: "x" }), "t?y=1")).rejects.toThrow(/不是数组/);
  });
  it("grantByPaymentIntentQuery 按幂等键取金额与到期日（撞行时要用行里那份）", () => {
    const q = grantByPaymentIntentQuery("pi_1");
    expect(q).toContain("stripe_payment_intent_id=eq.pi_1");
    expect(q).toContain("select=micro_usd,expires_at");
    expect(q).toContain("limit=1");
  });
  it("plansQuery 取 plan 表", () => {
    expect(plansQuery()).toContain("plan?select=");
  });
});

describe("行解析", () => {
  it("parseSubscriptionRows：空数组回 null；形状对回一行", () => {
    expect(parseSubscriptionRows([])).toBeNull();
    expect(parseSubscriptionRows([sub])).toEqual(sub);
    expect(parseSubscriptionRows([{ ...sub, status: "weird" }])).toBeNull();
  });
  it("parseSubscriptionRows：缺 last_event_at 不整行作废（老行/select 少列时按空串，比不动）", () => {
    const { last_event_at: _dropped, ...withoutStamp } = sub;
    expect(parseSubscriptionRows([withoutStamp])?.last_event_at).toBe("");
  });
  it("parseSubscriptionOwner：反查行只有两列，缺 user_id 回 null", () => {
    expect(parseSubscriptionOwner([{ user_id: "u1", last_event_at: "2026-09-01T00:00:00Z" }]))
      .toEqual({ userId: "u1", lastEventAt: "2026-09-01T00:00:00Z" });
    expect(parseSubscriptionOwner([{ user_id: "u1" }])).toEqual({ userId: "u1", lastEventAt: "" });
    expect(parseSubscriptionOwner([])).toBeNull();
    expect(parseSubscriptionOwner(null)).toBeNull();
  });
  it("parseGrantRow：空/坏行回 null", () => {
    expect(parseGrantRow([{ micro_usd: 7_000_000, expires_at: "2027-09-01T00:00:00Z" }]))
      .toEqual({ microUsd: 7_000_000, expiresAt: "2027-09-01T00:00:00Z" });
    expect(parseGrantRow([{ micro_usd: 1 }])).toBeNull();
    expect(parseGrantRow([])).toBeNull();
  });
  it("parsePlanRows / parseRouteRows 丢掉坏行", () => {
    expect(parsePlanRows([...plans, { id: 1 }])).toHaveLength(2);
    const rows = parseRouteRows([{
      id: "r", logical_model: "deepseek-flash", platform: "deepseek", base_url: "https://u", wire_model: "w",
      price_in_micro_per_m: 1, price_cache_micro_per_m: 2, price_out_micro_per_m: 3, default_max_tokens: 100,
    }, { id: "bad" }]);
    expect(rows).toEqual([{ id: "r", logicalModel: "deepseek-flash", platform: "deepseek", baseUrl: "https://u", wireModel: "w", priceInMicroPerM: 1, priceCacheMicroPerM: 2, priceOutMicroPerM: 3, defaultMaxTokens: 100, kind: "chat" }]);
  });
  it("parseRouteRows 的 kind：缺席和认不出的值都按 chat —— 缺席 = 迁移还没跑，行为要与改动前一字不差（#1081）", () => {
    const row = (extra: Record<string, unknown>) => ({
      id: "r", logical_model: "m", platform: "p", base_url: "https://u", wire_model: "w",
      price_in_micro_per_m: 1, price_cache_micro_per_m: 2, price_out_micro_per_m: 3, default_max_tokens: 100, ...extra,
    });
    expect(parseRouteRows([row({})])[0]!.kind).toBe("chat");
    expect(parseRouteRows([row({ kind: "image" })])[0]!.kind).toBe("image");
    // 认不出的值按 chat 而不是丢掉整行：一个拼错的 kind 不该让这款模型从网关上消失
    expect(parseRouteRows([row({ kind: "vidoe" })])[0]!.kind).toBe("chat");
  });
  it("planSnapshotOf：订阅 + 档位 → 快照（period 转毫秒）；缺任一回 null", () => {
    const s = planSnapshotOf(sub as never, plans)!;
    expect(s).toMatchObject({ planId: "lite", status: "active", window5hLimitMicro: 665_000, weekLimitMicro: 3_325_000 });
    expect(s.periodStartMs).toBe(Date.UTC(2026, 8, 1));
    expect(planSnapshotOf(null, plans)).toBeNull();
    expect(planSnapshotOf({ ...sub, plan_id: "gone" } as never, plans)).toBeNull();
  });
  it("parseUsageEventRows：锚有就转毫秒，null 留 null（旧行退回链回放）；形状不对的行跳过", () => {
    const r = parseUsageEventRows([
      { created_at: "2026-09-01T01:00:00Z", cost_micro: 5, charged_to: "window", window_open_at: "2026-09-01T00:30:00Z" },
      { created_at: "2026-09-01T02:00:00Z", cost_micro: 7, charged_to: "addon", window_open_at: null },
      { created_at: "2026-09-01T02:00:00Z", cost_micro: "7", charged_to: "addon" },
      { created_at: "2026-09-01T02:00:00Z", cost_micro: 7, charged_to: "elsewhere" },
    ]);
    expect(r).toEqual([
      { at: Date.UTC(2026, 8, 1, 1), costMicro: 5, chargedTo: "window", windowOpenAt: Date.UTC(2026, 8, 1, 0, 30) },
      { at: Date.UTC(2026, 8, 1, 2), costMicro: 7, chargedTo: "addon", windowOpenAt: null },
    ]);
    expect(parseUsageEventRows(null)).toEqual([]);
  });
  it("parseGrantRows：带 created_at 与幂等键；缺 created_at 的行跳过（重放要它定「那一刻买了没」）", () => {
    const r = parseGrantRows([
      { micro_usd: 100, expires_at: "2027-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", stripe_payment_intent_id: "pi_1" },
      { micro_usd: 100, expires_at: "2027-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", stripe_payment_intent_id: null },
      { micro_usd: 100, expires_at: "2027-09-01T00:00:00Z" },
    ]);
    expect(r).toEqual([
      { micro: 100, expiresAt: Date.UTC(2027, 8, 1), createdAt: Date.UTC(2026, 8, 1), paymentIntentId: "pi_1" },
      { micro: 100, expiresAt: Date.UTC(2027, 8, 1), createdAt: Date.UTC(2026, 8, 1) },
    ]);
  });
});

describe("写入体", () => {
  it("usageEventInsert 列名与 0017/0018 一致；锚 null 落 null、有就转 ISO", () => {
    const meta = {
      caller: { uid: "u1", source: "runtime" as const, workspaceId: "w", sessionId: "s", agentId: "a_1" },
      route: { id: "r", logicalModel: "m", platform: "p", baseUrl: "", wireModel: "", priceInMicroPerM: 0, priceCacheMicroPerM: 0, priceOutMicroPerM: 0, defaultMaxTokens: 0, kind: "chat" as const },
      usage: { promptTokens: 10, cachedTokens: 2, completionTokens: 3 }, costMicro: 42,
    };
    expect(usageEventInsert("rid", meta, "addon", null)).toEqual({
      user_id: "u1", request_id: "rid", source: "runtime", workspace_id: "w", session_id: "s", agent_id: "a_1", logical_model: "m", route_id: "r",
      prompt_tokens: 10, cached_tokens: 2, completion_tokens: 3, cost_micro: 42, charged_to: "addon", window_open_at: null,
    });
    expect(usageEventInsert("rid", meta, "window", Date.UTC(2026, 8, 1)).window_open_at).toBe("2026-09-01T00:00:00.000Z");
  });
  it("subscriptionUpsertBody：period 毫秒转 ISO；planIdForPrice 反查档位；last_event_at 落 eventCreated", () => {
    expect(planIdForPrice(plans, "price_lite")).toBe("lite");
    expect(planIdForPrice(plans, "price_x")).toBeNull();
    expect(planIdForPrice(plans, "price_addon")).toBeNull(); // 加购不是订阅档位
    const b = subscriptionUpsertBody({ kind: "subscription_upsert", uid: "u1", priceId: "price_lite", customerId: "c", subscriptionId: "s", status: "active", periodStartMs: Date.UTC(2026, 8, 1), periodEndMs: Date.UTC(2026, 9, 1), eventCreated: Date.UTC(2026, 8, 2) }, "lite");
    expect(b).toMatchObject({ user_id: "u1", plan_id: "lite", status: "active", current_period_start: "2026-09-01T00:00:00.000Z", last_event_at: "2026-09-02T00:00:00.000Z" });
  });
  it("grantInsertBody：quantity × 单位额，12 个月后过期", () => {
    const now = Date.UTC(2026, 8, 2);
    const b = grantInsertBody({ kind: "grant", uid: "u1", paymentIntentId: "pi", quantity: 2 }, 7_000_000, now);
    expect(b).toMatchObject({ user_id: "u1", micro_usd: 14_000_000, stripe_payment_intent_id: "pi" });
    expect(new Date(b.expires_at as string).getUTCFullYear()).toBe(2027);
  });
});

describe("meFromParts", () => {
  it("没订阅：plan null / status none / 没有窗口，加购与型号照给", () => {
    const me = meFromParts(null, null, { remainingMicro: 500, expiresAt: 123 }, ["m1"], plans);
    expect(me).toEqual({
      plan: null, status: "none", windows: null, imageModels: [], ttsModels: [], addon: { remainingMicro: 500, expiresAt: 123 }, periodEnd: null, models: ["m1"],
      // 调用方没给平台表时是空对象（#1011）：那一格只喂桌面下拉里的 logo，
      // 缺席 = 不画，不该让 /me 的其余部分跟着变形
      modelPlatforms: {},
      // plans 只带三个订阅档（addon 是加购行，不是档位），价格与 capabilities 跟着下发（#856 / #864）
      plans: [{ id: "lite", priceUsdCents: 1900, capabilities: { image: false, video: false, workspace: false } }],
      // 调用方没给决策型号时缺省清空（#1281）：没有型号，uses 也一律清空
      decision: { models: [], uses: {} },
    });
  });

  it("给了平台表就原样带出（#1011）", () => {
    const me = meFromParts(null, null, { remainingMicro: 0, expiresAt: null }, ["glm-5.3"], plans, { "glm-5.3": "zhipu" });
    expect(me.modelPlatforms).toEqual({ "glm-5.3": "zhipu" });
  });
  it("订阅非 active：窗口不下发（hold 此时一律拒，报满额度是谎话）", () => {
    const windows = { h5: { usedMicro: 1, limitMicro: 2, resetAt: 3 }, week: { usedMicro: 1, limitMicro: 2, resetAt: 3 } };
    const me = meFromParts({ ...sub, status: "past_due" } as never, windows, { remainingMicro: 0, expiresAt: null }, [], plans);
    expect(me.status).toBe("past_due");
    expect(me.windows).toBeNull();
    expect(me.periodEnd).toBe(Date.UTC(2026, 9, 1));
  });
  it("active：窗口原样带出，plan 只认三个档位", () => {
    const windows = { h5: { usedMicro: 1, limitMicro: 2, resetAt: 3 }, week: { usedMicro: 4, limitMicro: 5, resetAt: 6 } };
    expect(meFromParts(sub as never, windows, { remainingMicro: 0, expiresAt: null }, [], plans).windows).toEqual(windows);
    expect(meFromParts({ ...sub, plan_id: "addon" } as never, windows, { remainingMicro: 0, expiresAt: null }, [], plans).plan).toBeNull();
  });
});

// ── 出图行不许漏进模型选择器（#1081） ────────────────────────────────
//
// 这段判断原来住在 worker.ts 的 `me()` 里（两行 map/for），而 **worker.ts 不进
// vitest** —— 同 usageAttribution 与 UPSTREAM_KEY_ENV 那两次的教训：唯一的判断
// 零执行覆盖。搬进这里就是为了下面这几条跑得到。

describe("modelsForMe", () => {
  const r = (id: string, logicalModel: string, platform: string, kind: "chat" | "image") => ({
    id, logicalModel, platform, baseUrl: "https://u", wireModel: logicalModel,
    priceInMicroPerM: 1, priceCacheMicroPerM: 1, priceOutMicroPerM: 1, defaultMaxTokens: 100, kind,
  });

  it("出图行不进 models —— 它进去就是输入框那枚选单里多一款点了不干活的型号", () => {
    const { models } = modelsForMe([
      r("a@deepseek", "deepseek-flash", "deepseek", "chat"),
      r("i@openrouter", "gemini-3.1-flash-image", "openrouter", "image"),
    ]);
    expect(models).toEqual(["deepseek-flash"]);
  });

  it("出图行也不进 modelPlatforms —— 那张表的消费方是同一枚选单里的厂商 logo", () => {
    const { modelPlatforms } = modelsForMe([
      r("a@deepseek", "deepseek-flash", "deepseek", "chat"),
      r("i@openrouter", "gemini-3.1-flash-image", "openrouter", "image"),
    ]);
    expect(modelPlatforms).toEqual({ "deepseek-flash": "deepseek" });
  });

  it("同一款多条路由只留第一条的平台，且顺序照抄传进来的那份（ADR-0237 的全序不能在这儿丢）", () => {
    const { models, modelPlatforms } = modelsForMe([
      r("a@deepseek", "deepseek-flash", "deepseek", "chat"),
      r("a@siliconflow", "deepseek-flash", "siliconflow", "chat"),
      r("b@zhipu", "glm-5.3", "zhipu", "chat"),
    ]);
    expect(models).toEqual(["deepseek-flash", "glm-5.3"]);
    expect(modelPlatforms["deepseek-flash"]).toBe("deepseek");
  });

  it("一行都没有时回空 —— 不兜底成任何一款默认型号", () => {
    expect(modelsForMe([])).toEqual({ models: [], imageModels: [], ttsModels: [], decisionModels: [], modelPlatforms: {} });
  });

  it("出图行进 imageModels（那是 generate_image 那把刀的清单），且同样从便宜到贵有序", () => {
    const { imageModels } = modelsForMe([
      r("a@deepseek", "deepseek-flash", "deepseek", "chat"),
      r("cheap@openrouter", "cheap-image", "openrouter", "image"),
      r("pricey@openrouter", "pricey-image", "openrouter", "image"),
    ]);
    expect(imageModels).toEqual(["cheap-image", "pricey-image"]);
  });
});

// ── 语音行（#1163）：第三张清单 ─────────────────────────────────────────
describe("modelsForMe / meFromParts：kind=tts 单列一张 ttsModels", () => {
  const row = (id: string, logicalModel: string, platform: string, kind: "chat" | "image" | "tts") => ({
    id, logicalModel, platform, baseUrl: "https://u", wireModel: logicalModel,
    priceInMicroPerM: 1, priceCacheMicroPerM: 1, priceOutMicroPerM: 1, defaultMaxTokens: 100, kind,
  });
  it("tts 行只进 ttsModels，不进 models / imageModels / modelPlatforms", () => {
    const out = modelsForMe([
      row("a@deepseek", "deepseek-flash", "deepseek", "chat"),
      row("i@openrouter", "gemini-3.1-flash-image", "openrouter", "image"),
      row("s@minimax", "speech-2.8-turbo", "minimax", "tts"),
    ]);
    expect(out).toEqual({
      models: ["deepseek-flash"], imageModels: ["gemini-3.1-flash-image"], ttsModels: ["speech-2.8-turbo"], decisionModels: [],
      modelPlatforms: { "deepseek-flash": "deepseek" },
    });
  });
  it("meFromParts 第八参透传；缺省 [] = 这台网关不供语音", () => {
    const withTts = meFromParts(null, null, { remainingMicro: 0, expiresAt: null }, [], plans, {}, [], ["speech-2.8-turbo"]);
    expect(withTts.ttsModels).toEqual(["speech-2.8-turbo"]);
    expect(meFromParts(null, null, { remainingMicro: 0, expiresAt: null }, [], plans).ttsModels).toEqual([]);
  });
});

describe("决策模型那一格（#1281）", () => {
  const raw = (over: Record<string, unknown>) => ({
    id: "x@p", logical_model: "x", platform: "p", base_url: "https://u", wire_model: "x",
    price_in_micro_per_m: 1, price_cache_micro_per_m: 0, price_out_micro_per_m: 1, default_max_tokens: 10, ...over,
  });
  it("kind='decision' 认得出；认不出的仍然按 chat（末端兜底不变）", () => {
    const rows = parseRouteRows([raw({ kind: "decision" }), raw({ id: "y@p", kind: "bogus" })]);
    expect(rows.map((r) => r.kind)).toEqual(["decision", "chat"]);
  });
  it("决策那一行**不进 models**（它输出价是 0，进去就是所有人的默认聊天款），单列一张 decisionModels", () => {
    const rows = parseRouteRows([
      raw({ id: "jev-1.13@openrouter", logical_model: "jev-1.13", platform: "openrouter", price_out_micro_per_m: 0, kind: "decision" }),
      raw({ id: "flash@deepseek", logical_model: "flash", kind: "chat" }),
    ]);
    const m = modelsForMe(rows);
    expect(m.models).toEqual(["flash"]);
    expect(m.decisionModels).toEqual(["jev-1.13"]);
    expect(m.modelPlatforms).toEqual({ flash: "p" });
  });
  it("meFromParts 第九参：有决策型号才带 uses；没有型号时 uses 一律清空", () => {
    // 测试也过 tsc：readonly 元组 spread 进不了可变数组形参，所以老老实实写全
    const addon = { remainingMicro: 0, expiresAt: null };
    expect(meFromParts(null, null, addon, ["flash"], [], {}, [], []).decision).toEqual({ models: [], uses: {} });
    expect(meFromParts(null, null, addon, ["flash"], [], {}, [], [], { models: ["jev-1.13"], uses: { dispatch: "shadow" } }).decision)
      .toEqual({ models: ["jev-1.13"], uses: { dispatch: "shadow" } });
    expect(meFromParts(null, null, addon, ["flash"], [], {}, [], [], { models: [], uses: { dispatch: "on" } }).decision)
      .toEqual({ models: [], uses: {} });
  });
});

// ── plans 的 isolate 级缓存（#1322）──────────────────────────────────────
// `/me` 里 `routesOf(env)` 有 60s 缓存，而**同一行**的 `plansQuery()` 没有，于是每一发
// `/me` 都真打一次 Supabase：HEL 上 290–326ms（与一整趟跨洲 DO 往返同价），SYD 上
// 115–353ms（那边 DO 往返只要 8–10ms，贵一个数量级）——数是 ADR-0305 那把尺子量出来的，
// 在 #1304 的评论里。而 `/me` 由 hostedProbe 每 60 秒刷一次、账号页与额度那两扇窗全靠它，
// 是条高频路径。
//
// worker.ts 进不了 vitest（一 import 就要 `cloudflare:workers` 的运行时），判据只好落在
// 源码上，同 tests/edge/quotaTiming.test.ts 那组接线断言。
describe("worker.ts：plans 的 60s isolate 缓存，只给 /me（#1322）", () => {
  const read = async (): Promise<string> =>
    readFile(new URL("../../services/edge/src/worker.ts", import.meta.url), "utf8");

  it("与 routesCache 同款：isolate 级模块变量 + 60s，不是 globalThis 也不是 DO", async () => {
    const src = await read();
    expect(src).toMatch(/^let plansCache: \{ v: PlanRow\[\]; exp: number \} \| null = null;$/m);
    expect(src).toContain("plansCache = { v, exp: Date.now() + 60_000 }");
    // 过期才重查——这一格写反（`<` 而不是 `>`）会让缓存**从不命中**，而线上唯一的症状
    // 是这条 issue 本身：一切照常，只是每一发都慢 300ms
    expect(src).toContain("if (plansCache && plansCache.exp > Date.now()) return plansCache.v;");
  });

  it("/me 那一行走缓存，不再直查", async () => {
    const src = await read();
    expect(src).toContain("Promise.all([routesOf(env), plansOf(env)])");
  });

  it("checkout 仍然直查——它是**开单**路径，拿一份最多陈旧 60 秒的价目去开 Stripe checkout 等于按旧价收一次钱", async () => {
    const src = await read();
    const from = src.indexOf("async checkout(uid");
    const to = src.indexOf("async portal(uid");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const body = src.slice(from, to);
    expect(body).toContain("db.get(plansQuery())");
    expect(body).not.toContain("plansOf(");
  });
});
