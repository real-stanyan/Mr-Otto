// runtime 的 env 装配（ADR-0199）。这份测试存在的直接理由是 issue #844：
// **MODEL_* 不再是必需项**，而"少了一个必需项"这件事没有任何症状——daemon
// 照常启动，只有在第一次有人 @Agent 时才发现哪里不对。

import { describe, expect, it } from "vitest";
import { MissingConfigError, resolveConfig } from "../../services/runtime/src/config.js";

const full: NodeJS.ProcessEnv = {
  RUNTIME_SECRET: "s",
  SUPABASE_JWT_SECRET: "j",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "k",
  EDGE_BASE: "https://edge.example",
  RELAY_BASE: "https://edge.example",
};

describe("resolveConfig", () => {
  it("六个必需项齐了就装得出来，DATA_DIR 有默认值", () => {
    const cfg = resolveConfig({ ...full });
    expect(cfg.runtimeSecret).toBe("s");
    expect(cfg.dataDir).toBe("/var/lib/otto-runtime");
  });

  it("缺哪个就报哪个（fail fast 的那份清单）", () => {
    const { RUNTIME_SECRET: _a, EDGE_BASE: _b, ...rest } = full;
    try {
      resolveConfig(rest);
      throw new Error("应该抛 MissingConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingConfigError);
      expect((err as MissingConfigError).missing).toEqual(["RUNTIME_SECRET", "EDGE_BASE"]);
    }
  });

  // issue #844（推翻 ADR-0199 决策⑥）：模型 key 跟着工作区走，runtime 这个
  // 进程不持有任何模型 key。**也不做 env 兜底**——有兜底就等于"忘了配的
  // 工作区默默烧维护者的钱"
  it("MODEL_* 全缺照样装得出来 —— 模型 key 不是 runtime 的东西了", () => {
    expect(() => resolveConfig({ ...full })).not.toThrow();
  });

  it("就算 env 里塞了 MODEL_*，配置对象里也没有它们的位置", () => {
    const cfg = resolveConfig({
      ...full,
      MODEL_BASE_URL: "https://api.deepseek.com/v1",
      MODEL_API_KEY: "sk-maintainer-key",
      MODEL_ID: "deepseek-v4-flash",
    });
    // 这条断言的意义不在类型（tsc 已经拦了），在于**留一份会红的证据**：
    // 哪天有人"顺手加回兜底"，这里会红，而不是等某个工作区默默烧了别人的钱
    expect(Object.keys(cfg).some((k) => k.toLowerCase().includes("model"))).toBe(false);
  });
});
