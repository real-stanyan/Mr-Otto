// 目录的一致性断言。两张表拆开之后，"型号指向的厂商存在吗"这类问题不再是
// 编译期能兜住的（provider 是联合类型，但端点/key 是运行期查表拼出来的），
// 所以把它钉在测试里：目录长歪了要在 CI 就红，而不是等用户点开下拉框才发现。
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  MODEL_CATALOG,
  describeModel,
  findModel,
  modelsByProvider,
  ollamaTag,
  resolveModel,
} from "../../src/shared/modelCatalog.js";
import { PROVIDER_CATALOG, findProvider, providerKeyEnvs } from "../../src/shared/providerCatalog.js";

describe("providerCatalog", () => {
  it("厂商 id 唯一", () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每家都有 key 变量、端点和领 key 的地方", () => {
    for (const p of PROVIDER_CATALOG) {
      expect(p.apiKeyEnv, p.id).toMatch(/^[A-Z0-9_]+$/);
      // 本机服务走 http 回环（没有中间人可防，Ollama 也不发证书）；出网的一律 https
      expect(p.baseUrl, p.id).toMatch(p.region === "local" ? /^http:\/\/localhost/ : /^https:\/\//);
      expect(p.consoleUrl, p.id).toMatch(/^https:\/\//);
    }
  });

  it("免 key 的厂商只有本机那一档 —— 出网的服务不该被标成不要凭据", () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.keyless) expect(p.region, p.id).toBe("local");
    }
  });

  it("key 白名单 = 厂商目录的 apiKeyEnv 集合", () => {
    expect(new Set(providerKeyEnvs())).toEqual(new Set(PROVIDER_CATALOG.map((p) => p.apiKeyEnv)));
  });
});

describe("modelCatalog", () => {
  it("型号 id 唯一", () => {
    const ids = MODEL_CATALOG.map((m) => m.model);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个型号的端点三件套都来自它自己那家厂", () => {
    for (const m of MODEL_CATALOG) {
      const p = findProvider(m.provider);
      expect(p, m.model).toBeDefined();
      expect(m.baseUrl, m.model).toBe(p!.baseUrl);
      expect(m.baseUrlEnv, m.model).toBe(p!.baseUrlEnv);
      expect(m.apiKeyEnv, m.model).toBe(p!.apiKeyEnv);
    }
  });

  it("默认型号在目录里，且是 DeepSeek —— 官方赠额只覆盖这一家", () => {
    expect(findModel(DEFAULT_MODEL)?.provider).toBe("deepseek");
  });

  it("分组投影不丢型号，顺序跟厂商目录走", () => {
    const groups = modelsByProvider();
    expect(groups.flatMap((g) => g.models).length).toBe(MODEL_CATALOG.length);
    const order = PROVIDER_CATALOG.map((p) => p.id).filter((id) =>
      MODEL_CATALOG.some((m) => m.provider === id)
    );
    expect(groups.map((g) => g.provider)).toEqual(order);
  });

  it("keyless 从厂商表传到每个型号上 —— 路由读的是型号，不会回头查厂商", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.keyless, m.model).toBe(findProvider(m.provider)!.keyless ?? false);
    }
  });

  it("Ollama 一个型号都不写死 —— 写死就会跟本机 ollama list 对不上", () => {
    expect(MODEL_CATALOG.some((m) => m.provider === "ollama")).toBe(false);
    expect(modelsByProvider().some((g) => g.provider === "ollama")).toBe(false);
  });

  it("ollama/ 前缀 = 本机型号：认得出厂商，也剥得回裸 tag", () => {
    const m = describeModel("ollama/qwen3.5:27b-coding-mxfp8")!;
    expect(m.provider).toBe("ollama");
    expect(m.model).toBe("qwen3.5:27b-coding-mxfp8"); // 发给 API 的是裸 tag
    expect(m.label).toBe("qwen3.5:27b-coding-mxfp8");
    expect(ollamaTag("ollama/x")).toBe("x");
    expect(ollamaTag("deepseek-v4-flash")).toBeNull();
  });

  it("describeModel 认不出就返回 undefined，不像 resolveModel 那样兜底成 DeepSeek", () => {
    expect(describeModel("some-unknown-id")).toBeUndefined();
    expect(resolveModel("some-unknown-id").provider).toBe("deepseek");
  });

  it("至少有一款视觉型号 —— vision-bridge 的代读员得存在", () => {
    expect(MODEL_CATALOG.some((m) => m.supportsVision)).toBe(true);
  });
});
