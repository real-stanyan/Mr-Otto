import { describe, expect, it } from "vitest";
import { routeModel } from "../../src/main/modelRoute.js";
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
