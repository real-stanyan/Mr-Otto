import { describe, expect, it } from "vitest";
import {
  bucketOf,
  DEFAULT_GRANTS,
  grantFor,
  MODEL_BUCKETS,
  TIERS,
  tokensSpent,
} from "../../services/gateway/src/buckets.js";

const noEnv = {} as NodeJS.ProcessEnv;

describe("bucketOf", () => {
  it("目录里的两个型号各进各的桶", () => {
    expect(bucketOf("deepseek-v4-flash")).toBe("flash");
    expect(bucketOf("deepseek-v4-pro")).toBe("pro");
  });

  it("DeepSeek 通用别名归 flash（实测回报 model 就是 v4-flash）", () => {
    expect(bucketOf("deepseek-chat")).toBe("flash");
  });

  it("表外型号 → null，让调用方拒收而不是悄悄扣最贵那桶", () => {
    expect(bucketOf("gpt-5")).toBeNull();
    expect(bucketOf("glm-4.5-flash")).toBeNull();
    expect(bucketOf("")).toBeNull();
  });

  it("桶名只有 TIERS 里那两个——多一个就是多一处没人发赠额的死账", () => {
    for (const tier of Object.values(MODEL_BUCKETS)) {
      expect(TIERS).toContain(tier);
    }
  });
});

describe("grantFor", () => {
  it("没配 env → 用默认赠额", () => {
    expect(grantFor("flash", noEnv)).toBe(DEFAULT_GRANTS.flash);
    expect(grantFor("pro", noEnv)).toBe(DEFAULT_GRANTS.pro);
  });

  it("env 可覆盖，取整", () => {
    const env = { OTTO_GRANT_FLASH_TOKENS: "1234.9" } as unknown as NodeJS.ProcessEnv;
    expect(grantFor("flash", env)).toBe(1234);
  });

  it("0 是合法的（想关掉某个桶的赠额）", () => {
    const env = { OTTO_GRANT_PRO_TOKENS: "0" } as unknown as NodeJS.ProcessEnv;
    expect(grantFor("pro", env)).toBe(0);
  });

  it("看不懂的值 / 负数 → 当没写，落回默认（笔误不该把赠额变成 NaN）", () => {
    for (const bad of ["", "很多", "-1", "1e999"]) {
      const env = { OTTO_GRANT_FLASH_TOKENS: bad } as unknown as NodeJS.ProcessEnv;
      expect(grantFor("flash", env)).toBe(DEFAULT_GRANTS.flash);
    }
  });

  // ADR-0085:官方停止供 token,注册不送任何额度。这条钉住"默认就是零"——
  // 谁想开回赠额得先改这条测试,顺便被逼着重读那份 ADR 的恢复清单。
  // (此前这里是 3~5 USD 的最坏成本区间断言,拦手滑;赠额归零后上下界都失义)
  it("默认赠额为零：注册不再送 token（ADR-0085）", () => {
    expect(DEFAULT_GRANTS.flash).toBe(0);
    expect(DEFAULT_GRANTS.pro).toBe(0);
  });
});

describe("tokensSpent", () => {
  it("进 + 出，桶内不分方向", () => {
    expect(tokensSpent({ promptTokens: 1000, completionTokens: 25 })).toBe(1025);
  });

  it("零用量算 0，不产生 -0 或 NaN", () => {
    expect(tokensSpent({ promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it("负数（上游给了怪值）不倒贴额度", () => {
    expect(tokensSpent({ promptTokens: -5, completionTokens: -5 })).toBe(0);
  });
});
