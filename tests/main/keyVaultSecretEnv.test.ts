import { describe, it, expect, afterEach } from "vitest";
import { applyToEnv } from "../../src/main/keyVault.js";
import { secretEnvNames, unmarkSecretEnv } from "../../src/shared/secretEnv.js";

afterEach(() => {
  for (const name of secretEnvNames()) unmarkSecretEnv(name);
});

describe("applyToEnv 顺手登记凭据名（issue #153）", () => {
  it("写进 env 的每个名字都进登记处", () => {
    const env: NodeJS.ProcessEnv = {};
    applyToEnv({ DEEPSEEK_API_KEY: "sk-a", ANTHROPIC_API_KEY: "sk-b" }, env);
    expect(env["DEEPSEEK_API_KEY"]).toBe("sk-a");
    expect([...secretEnvNames()].sort()).toEqual(["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"]);
  });

  it("没有 key 的时候不登记任何东西", () => {
    applyToEnv({}, {});
    expect(secretEnvNames()).toEqual([]);
  });
});
