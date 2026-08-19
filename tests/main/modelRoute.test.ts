import { describe, expect, it } from "vitest";
import { routeModel } from "../../src/main/modelRoute.js";
import { findModel, resolveModel } from "../../src/shared/modelCatalog.js";

const deepseek = findModel("deepseek-v4-flash")!;
const glm = findModel("glm-4.5-flash")!;
const GW = "https://gw.example/gw/v1";

const route = (over: Partial<Parameters<typeof routeModel>[0]> = {}) =>
  routeModel({
    choice: deepseek,
    ownKey: "",
    accessToken: null,
    gatewayBaseUrl: GW,
    ...over,
  });

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

  it("自带 key 优先于登录态——他自己付的钱，不该因为顺手登录就改花官方额度", () => {
    expect(route({ ownKey: "sk-mine", accessToken: "jwt" }).kind).toBe("direct");
  });

  it("没自己的 key 但登录了 → 走网关，凭据是 access token", () => {
    expect(route({ accessToken: "jwt-abc" })).toEqual({
      kind: "gateway",
      baseUrl: GW,
      apiKey: "jwt-abc",
    });
  });

  it("非 DeepSeek 型号不走网关——官方额度只买了 DeepSeek", () => {
    const r = route({ choice: glm, accessToken: "jwt" });
    expect(r.kind).toBe("blocked");
    // 与其让用户对着上游 400 发呆，不如直说缺什么
    expect(r.kind === "blocked" && r.reason).toContain(glm.apiKeyEnv);
  });

  it("非 DeepSeek 但自带 key → 照常直连", () => {
    expect(route({ choice: glm, ownKey: "glm-key", accessToken: null })).toMatchObject({
      kind: "direct",
      baseUrl: glm.baseUrl,
      apiKey: "glm-key",
    });
  });

  it("既没登录也没 key → blocked，且两条出路都说了", () => {
    const r = route();
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") throw new Error("unreachable");
    expect(r.reason).toContain("登录");
    expect(r.reason).toContain(deepseek.apiKeyEnv);
  });

  it("空串 key 不算配过（keyVault 用空串表示清除）", () => {
    expect(route({ ownKey: "", accessToken: "jwt" }).kind).toBe("gateway");
  });
});

describe("免 key 的本机厂商（Ollama）", () => {
  // 目录里没有 Ollama 的型号(本机装了什么只有本机知道),id 靠前缀认领
  const ollama = resolveModel("ollama/qwen3:30b");

  it("前缀被剥掉：发给 Ollama 的是它认得的裸 tag", () => {
    expect(ollama.model).toBe("qwen3:30b");
    expect(ollama.keyless).toBe(true);
  });

  it("没 key 也不 blocked：直连本机端点", () => {
    const r = route({ choice: ollama });
    expect(r.kind).toBe("direct");
    expect(r).toMatchObject({ baseUrl: "http://127.0.0.1:11434/v1" });
  });

  it("不走网关：登录了也不该去扣官方赠额", () => {
    expect(route({ choice: ollama, accessToken: "tok" }).kind).toBe("direct");
  });

  it("端点覆盖仍然生效：远端 Ollama 换 OLLAMA_BASE_URL 即可", () => {
    expect(route({ choice: ollama, ownBaseUrl: "http://box.lan:11434/v1" })).toMatchObject({
      kind: "direct",
      baseUrl: "http://box.lan:11434/v1",
    });
  });
});
