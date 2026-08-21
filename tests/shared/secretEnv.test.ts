import { describe, it, expect, afterEach } from "vitest";
import {
  markSecretEnv,
  unmarkSecretEnv,
  secretEnvNames,
  stripSecretEnv,
} from "../../src/shared/secretEnv.js";

// 登记处是模块级单例（进程里只有一份 process.env，名单也只该有一份）——
// 每条用例自己收尾，别把状态漏给下一条
afterEach(() => {
  for (const name of secretEnvNames()) unmarkSecretEnv(name);
});

describe("secretEnv 登记处", () => {
  it("登记过的名字进名单，撤销后离开", () => {
    markSecretEnv("DEEPSEEK_API_KEY");
    expect(secretEnvNames()).toContain("DEEPSEEK_API_KEY");
    unmarkSecretEnv("DEEPSEEK_API_KEY");
    expect(secretEnvNames()).not.toContain("DEEPSEEK_API_KEY");
  });

  it("重复登记不产生重复项", () => {
    markSecretEnv("A");
    markSecretEnv("A");
    expect(secretEnvNames().filter((n) => n === "A")).toHaveLength(1);
  });
});

describe("stripSecretEnv", () => {
  it("摘掉登记在案的，其余原样留着", () => {
    const out = stripSecretEnv(
      { PATH: "/usr/bin", HOME: "/Users/x", DEEPSEEK_API_KEY: "sk-real" },
      ["DEEPSEEK_API_KEY"]
    );
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/Users/x" });
  });

  it("不改动传进来的那份环境（子进程环境是拷贝）", () => {
    const src = { DEEPSEEK_API_KEY: "sk-real" };
    stripSecretEnv(src, ["DEEPSEEK_API_KEY"]);
    expect(src.DEEPSEEK_API_KEY).toBe("sk-real");
  });

  it("undefined 的值不进结果（子进程环境只收字符串）", () => {
    const out = stripSecretEnv({ A: "1", B: undefined });
    expect(out).toEqual({ A: "1" });
  });

  it("名单为空 = 什么都不摘", () => {
    const out = stripSecretEnv({ A: "1", DEEPSEEK_API_KEY: "sk" }, []);
    expect(out).toEqual({ A: "1", DEEPSEEK_API_KEY: "sk" });
  });

  it("不给 names 时用全局登记处", () => {
    markSecretEnv("ANTHROPIC_API_KEY");
    expect(stripSecretEnv({ ANTHROPIC_API_KEY: "sk", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
