import { describe, expect, it } from "vitest";
import { modelStatusText } from "../../src/renderer/src/lib/cloudModelStatus.js";

const cfg = { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-v4", hasKey: true };

describe("modelStatusText（#945）", () => {
  it("hosted：没配模型也不红，说托管型号；配了但网关退到别款，显示实际会用的那款", () => {
    expect(modelStatusText(null, { kind: "hosted", model: "deepseek-v4-flash" })).toEqual({
      short: "deepseek-v4-flash · 托管", bad: false, full: expect.stringContaining("订阅"),
    });
    expect(modelStatusText(cfg, { kind: "hosted", model: "glm-5" }).short).toBe("glm-5 · 托管");
  });
  it("workspace：走自带 key，沿用旧文案", () => {
    expect(modelStatusText(cfg, { kind: "workspace" })).toEqual({ short: "deepseek-v4", full: `${cfg.baseUrl}\n${cfg.modelId}`, bad: false });
  });
  it("blocked：两条路都没有才红，两条出路都说", () => {
    const r = modelStatusText(null, { kind: "blocked" });
    expect(r.bad).toBe(true);
    expect(r.full).toMatch(/订阅/);
    expect(r.full).toMatch(/key/);
  });
  it("route 探不到（null）：按旧规则退回 model 那一格，但措辞不说死「起不了 turn」", () => {
    expect(modelStatusText(null, null)).toEqual({ short: "未配模型", bad: false, full: expect.stringContaining("订阅") });
    expect(modelStatusText({ ...cfg, hasKey: false }, null).bad).toBe(true);
    expect(modelStatusText(cfg, null).short).toBe("deepseek-v4");
  });
});
