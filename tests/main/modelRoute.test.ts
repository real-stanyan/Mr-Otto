import { describe, expect, it } from "vitest";
import { routeImage, routeModel, routeTts } from "../../src/main/modelRoute.js";
import { findModel, resolveModel } from "../../src/shared/modelCatalog.js";

const deepseek = findModel("deepseek-v4-flash")!;
const glm = findModel("glm-4.7-flash")!;

// ADR-0129 之后只剩两种结局:有 key(或免 key 的本机 Ollama)直连,否则 blocked。
// 曾经的第三条(走 otto-gateway 花官方赠额)连同 officialGrant 开关一起删了,
// 所以这个文件里再也没有 "officialGrant=true 的旧形态" 那一半。
const route = (over: Partial<Parameters<typeof routeModel>[0]> = {}) =>
  routeModel({ choice: deepseek, ownKey: "", ...over });

describe("routeModel", () => {
  it("自带 key → 直连，用目录里的端点", () => {
    expect(route({ ownKey: "sk-mine" })).toEqual({
      kind: "direct",
      baseUrl: deepseek.baseUrl,
      apiKey: "sk-mine",
    });
  });

  it("自带 key 且自带端点（自建代理/本地 vLLM）→ 端点也用自己的", () => {
    expect(route({ ownKey: "sk-mine", ownBaseUrl: "http://127.0.0.1:8000/v1" })).toMatchObject({
      kind: "direct",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
  });

  it("没 key 就是 blocked,出路只有自己配", () => {
    const r = route();
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain(deepseek.apiKeyEnv);
  });

  it("空串 key 不算配过（keyVault 用空串表示清除）", () => {
    expect(route({ ownKey: "" }).kind).toBe("blocked");
  });

  it("DeepSeek 不再有特殊待遇:和别家一样看 key", () => {
    expect(route({ choice: deepseek }).kind).toBe(route({ choice: glm }).kind);
  });

  it("非 DeepSeek 自带 key → 照常直连", () => {
    expect(route({ choice: glm, ownKey: "glm-key" })).toMatchObject({
      kind: "direct",
      baseUrl: glm.baseUrl,
      apiKey: "glm-key",
    });
  });
});

// 旧日志必须永远可重放(硬规则):lane=grant 是 ADR-0045 时代落进事件日志的真值,
// 今天重放到路由这里不能炸,也不能装作无事发生 —— 得说清楚那条路已经没了
describe("老日志里的 lane=grant", () => {
  it("重放到路由 → blocked 且点名赠额已停", () => {
    const r = route({ lane: "grant" });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("停止");
  });

  it("但配了自己的 key → 直连:选择失效后回落到能跑的那条路,而不是报错", () => {
    expect(route({ ownKey: "sk-mine", lane: "grant" }).kind).toBe("direct");
  });
});

// 托管出路（ADR-0176 决定二）：付费订阅下，托管优先于自带 key——绕过用户
// 买的东西去烧他自己的 key 才是意外。
describe("routeModel：托管优先（ADR-0176 决定二）", () => {
  const hosted = { subscribed: true, exhausted: false, supportsModel: true };
  const hostedArgs = { hosted, hostedBaseUrl: "https://edge/llm/v1", hostedToken: "jwt" };

  it("有订阅 + 未耗尽 + 网关供这款 → hosted，哪怕配了自己的 key", () => {
    expect(route({ ownKey: "sk-mine", ...hostedArgs })).toEqual({
      kind: "hosted",
      baseUrl: "https://edge/llm/v1",
      apiKey: "jwt",
    });
  });

  // 这三条原来断言的是「订阅用户退回自带 key」。#1051 把那条路整个关了（维护者
  // 的产品口径：订阅用户不可以使用自带 api key），所以三条一起翻面——**不是删测试
  // 换绿**，是同一个问题在新规则下的新答案，产品代码就在同一个 diff 里。
  it("耗尽 + 有自己的 key → 仍然 blocked（#1051：订阅这一侧没有 direct）", () => {
    // 悄悄改烧用户自己的账号正是 ADR-0233 点名不许的失败模式，本机这一半同理
    const r = route({ ownKey: "sk-mine", ...hostedArgs, hosted: { ...hosted, exhausted: true, resetAt: 5 } });
    expect(r.kind).toBe("blocked");
    // 措辞里不许再出现「填自己的 key」——那条建议在新规则下无法执行
    expect(r.kind === "blocked" && r.reason).not.toContain(deepseek.apiKeyEnv);
    expect(r.kind === "blocked" && r.reason).toContain("加购");
  });

  it("耗尽 + 没 key → blocked，措辞带恢复时间", () => {
    const r = route({ ...hostedArgs, hosted: { ...hosted, exhausted: true, resetAt: Date.UTC(2026, 8, 2, 10) } });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toMatch(/额度.*恢复/);
  });

  it("订阅不供这款 → blocked，措辞指向选单里换一款（那里现在只列订阅供的）", () => {
    const r = route({ ...hostedArgs, hosted: { ...hosted, supportsModel: false } });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("换一款");
    expect(r.kind === "blocked" && r.reason).not.toContain(deepseek.apiKeyEnv);
  });

  it("无订阅 + 没 key → blocked，措辞把两条出路都说出来", () => {
    const r = route({ hosted: { subscribed: false, exhausted: false, supportsModel: true } });
    expect(r.kind === "blocked" && r.reason).toMatch(/订阅/);
    expect(r.kind === "blocked" && r.reason).toContain(deepseek.apiKeyEnv);
  });

  it("有订阅但没拿到 JWT（token 过期）→ blocked 且**说清是连不上**，不发空 Bearer 也不改烧自己的 key", () => {
    // 这一条以前是悄悄退回 direct 的。说成「你没订阅」会让一个正在付钱的人
    // 去点续费解决一个不存在的问题（同 ADR-0233 把三种 blocked 分开措辞）
    const r = route({ ownKey: "sk", hosted, hostedBaseUrl: "https://edge/llm/v1" });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("连不上");
    expect(r.kind === "blocked" && r.reason).not.toMatch(/没有订阅|去订阅/);
  });

  it("Ollama 也在射程内：订阅用户不给本机免 key 的路（选单里没有、路由却通 = 两边说两句话）", () => {
    const ollama = { ...deepseek, model: "ollama/llama3", keyless: true, apiKeyEnv: "OLLAMA_API_KEY" };
    // 网关当然不供本机型号，所以 supportsModel 是 false —— 关键在于此时**不再**
    // 掉进那条 keyless 直连，而是 blocked
    const subscribedHosted = { ...hostedArgs, hosted: { ...hosted, supportsModel: false } };
    expect(routeModel({ choice: ollama, ownKey: "", ...subscribedHosted }).kind).toBe("blocked");
    // 没订阅的人照旧直连本机
    expect(
      routeModel({ choice: ollama, ownKey: "", hosted: { subscribed: false, exhausted: false, supportsModel: false } }).kind
    ).toBe("direct");
  });
});

describe("免 key 的本机厂商（Ollama）", () => {
  // 目录里没有 Ollama 的型号(本机装了什么只有本机知道),id 靠前缀认领
  const ollama = resolveModel("ollama/qwen3:30b");

  it("两个 id 各司其职：日志留前缀，发给 Ollama 的是裸 tag", () => {
    expect(ollama.model).toBe("ollama/qwen3:30b");
    expect(ollama.wireModel).toBe("qwen3:30b");
    expect(ollama.keyless).toBe(true);
  });

  it("没 key 也不 blocked：直连本机端点", () => {
    const r = route({ choice: ollama });
    expect(r.kind).toBe("direct");
    expect(r).toMatchObject({ baseUrl: "http://127.0.0.1:11434/v1" });
  });

  it("端点覆盖仍然生效：远端 Ollama 换 OLLAMA_BASE_URL 即可", () => {
    expect(route({ choice: ollama, ownBaseUrl: "http://box.lan:11434/v1" })).toMatchObject({
      kind: "direct",
      baseUrl: "http://box.lan:11434/v1",
    });
  });
});

// ── 出图那条路（#1081） ───────────────────────────────────────────────
//
// 与 routeModel 的差别只有一处、但那一处是根本的：**出图没有「自带 key」这一档**。
// 官方 key 只活在 Worker secret 里，客户端一个字节都拿不到，所以这条路要么走托管、
// 要么走不通——没有第三种结局，也就没有「悄悄改烧你自己的账号」这个失败模式。

describe("routeImage", () => {
  const base = { hostedBaseUrl: "https://edge/llm/v1", hostedToken: "jwt" };
  const hosted = (over: Partial<{ subscribed: boolean; exhausted: boolean; resetAt: number; imageModels: string[] }> = {}) =>
    ({ subscribed: true, exhausted: false, imageModels: ["gemini-3.1-flash-image"], ...over });

  it("订阅 + 网关供 + 拿得到 JWT → 走网关的 /images，没选过就点名最便宜那款", () => {
    // `/images` 不是 `/chat/completions`（#1086）：纯出图模型在后者上一律 404
    const r = routeImage({ ...base, hosted: hosted({ imageModels: ["cheap-image", "pricey-image"] }) });
    expect(r).toEqual({ kind: "hosted", url: "https://edge/llm/v1/images", model: "cheap-image" });
  });

  it("选过的那款优先（#1086）；网关下架了它就回落最便宜那款，不报错", () => {
    // 回落而不是报错，同 visionModelFor / helperModelFor 的纪律：网关下架一款不该让
    // 出图整个不通，而「你选的那款没了」这件事没有任何用户能据此行动的出路
    const models = ["cheap-image", "pricey-image"];
    const pick = (preferred?: string) =>
      routeImage({ ...base, hosted: hosted({ imageModels: models }), ...(preferred === undefined ? {} : { preferred }) });
    expect(pick("pricey-image")).toMatchObject({ model: "pricey-image" });
    expect(pick("gone-image")).toMatchObject({ model: "cheap-image" });
    expect(pick()).toMatchObject({ model: "cheap-image" });
  });

  it("没订阅：说订阅，**不提「填自己的 key」** —— 出图压根没有那条路（ADR-0248 的措辞纪律）", () => {
    const r = routeImage({ ...base, hosted: hosted({ subscribed: false }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("订阅");
    expect(r.reason).not.toContain("key");
  });

  it("额度用完：报恢复时间 + 加购这条真点得动的路", () => {
    const r = routeImage({ ...base, hosted: hosted({ exhausted: true, resetAt: Date.UTC(2026, 8, 8, 6, 30) }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("额度已用完");
    expect(r.reason).toContain("加购");
  });

  it("网关一款出图模型都不供：说的是「不供出图」，**不是「你没订阅」** —— 后者会让一个正在付钱的人去点续费解决一个不存在的问题", () => {
    const r = routeImage({ ...base, hosted: hosted({ imageModels: [] }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("出图");
    expect(r.reason).not.toContain("没有订阅");
  });

  it("拿不到 JWT / 网关地址：说连不上，同样不许写成「你没订阅」", () => {
    for (const partial of [{ hostedBaseUrl: base.hostedBaseUrl }, { hostedToken: base.hostedToken }]) {
      const r = routeImage({ ...partial, hosted: hosted() });
      expect(r.kind).toBe("blocked");
      if (r.kind !== "blocked") continue;
      expect(r.reason).toContain("连不上");
    }
  });

  it("没装配托管（子会话 / 探针 / 测试）：走不通", () => {
    expect(routeImage({ ...base }).kind).toBe("blocked");
  });

  it("额度用完排在「不供出图」前面 —— 前者是网关亲口说的，后者只是一张清单读出来的", () => {
    const r = routeImage({ ...base, hosted: hosted({ exhausted: true, imageModels: [] }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("额度已用完");
  });
});

// ── 语音那条路（#1163） ───────────────────────────────────────────────
//
// 与出图同形：没有「自带 key」这一档，要么走托管、要么走不通。四种 blocked 分开措辞，
// 后两种（网关不供语音 / 连不上网关）不许写成「你没订阅」——那会让一个正在付钱的人去点续费。

describe("routeTts", () => {
  const base = { hostedBaseUrl: "https://edge/llm/v1", hostedToken: "jwt" };
  const hosted = (over: Partial<{ subscribed: boolean; exhausted: boolean; resetAt: number; ttsModels: string[] }> = {}) =>
    ({ subscribed: true, exhausted: false, ttsModels: ["speech-2.8-turbo"], ...over });

  it("订阅 + 网关供 + 拿得到 JWT → 走网关的 /speech，点名清单第一款", () => {
    expect(routeTts({ ...base, hosted: hosted() })).toEqual({ kind: "hosted", url: "https://edge/llm/v1/speech", model: "speech-2.8-turbo" });
  });

  it("没订阅：说订阅，不提 key", () => {
    const r = routeTts({ ...base, hosted: hosted({ subscribed: false }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("订阅");
    expect(r.reason).not.toContain("key");
  });

  it("额度用完：报恢复时间 + 加购", () => {
    const r = routeTts({ ...base, hosted: hosted({ exhausted: true, resetAt: Date.UTC(2026, 8, 8, 6, 30) }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("额度已用完");
    expect(r.reason).toContain("加购");
  });

  it("网关一款语音模型都不供：说「不供语音」，不是「你没订阅」", () => {
    const r = routeTts({ ...base, hosted: hosted({ ttsModels: [] }) });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toContain("语音");
    expect(r.reason).not.toContain("没有订阅");
  });

  it("拿不到 JWT / 网关地址：说连不上；没装配托管也走不通；额度用完排在「不供语音」前面", () => {
    for (const partial of [{ hostedBaseUrl: base.hostedBaseUrl }, { hostedToken: base.hostedToken }]) {
      const r = routeTts({ ...partial, hosted: hosted() });
      expect(r.kind).toBe("blocked");
      if (r.kind !== "blocked") continue;
      expect(r.reason).toContain("连不上");
    }
    expect(routeTts({ ...base }).kind).toBe("blocked");
    const r = routeTts({ ...base, hosted: hosted({ exhausted: true, ttsModels: [] }) });
    if (r.kind === "blocked") expect(r.reason).toContain("额度已用完");
  });
});
