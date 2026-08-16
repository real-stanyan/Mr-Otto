import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeys, saveKey, applyToEnv } from "../../src/main/keyVault.js";

function vaultPath() {
  return join(mkdtempSync(join(tmpdir(), "otter-vault-")), "keys.json");
}

describe("keyVault", () => {
  it("roundtrip：存进去读出来一致；文件权限 0600", () => {
    const path = vaultPath();
    saveKey(path, "DEEPSEEK_API_KEY", "sk-test-1");
    expect(loadKeys(path)).toEqual({ DEEPSEEK_API_KEY: "sk-test-1" });
    expect(statSync(path).mode & 0o777).toBe(0o600); // 只有本人可读写
  });

  it("空串 = 清除该 key，其余不动", () => {
    const path = vaultPath();
    saveKey(path, "A_KEY", "1");
    saveKey(path, "B_KEY", "2");
    saveKey(path, "A_KEY", "");
    expect(loadKeys(path)).toEqual({ B_KEY: "2" });
  });

  it("文件不存在 / 坏 JSON → 空对象，不炸", () => {
    expect(loadKeys("/nonexistent/keys.json")).toEqual({});
  });

  it("applyToEnv 覆盖已有值：设置页的 key 优先于 .env", () => {
    const env: NodeJS.ProcessEnv = { GLM_API_KEY: "from-dotenv" };
    applyToEnv({ GLM_API_KEY: "from-settings" }, env);
    expect(env["GLM_API_KEY"]).toBe("from-settings");
  });
});
