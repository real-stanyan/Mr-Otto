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

  // 这条断言的作用不是"锁死数字"，是拦住"手滑多打一个零"。
  // 上界是钱的闸门：注册是敞开的（issue #122），赠额 × 任何人都能注册 = 漏钱速度。
  // 下界拦的是反向手滑：赠额掉到零附近，新用户第一次对话就报余额不足，
  // 表现成"登录了但用不了"，比多送钱更难查
  it("默认赠额的最坏成本落在 5 USD 以内（flash 出价 0.42、pro 出价 2.19 USD/1M）", () => {
    const worstUsd =
      (DEFAULT_GRANTS.flash * 0.42 + DEFAULT_GRANTS.pro * 2.19) / 1_000_000;
    expect(worstUsd).toBeLessThanOrEqual(5);
    expect(worstUsd).toBeGreaterThan(3);
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
