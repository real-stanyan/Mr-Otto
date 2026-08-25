import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUserHooks } from "../../src/main/userHooksStore.js";
import { tempDir } from "../helpers/tempDir.js";

describe("loadUserHooks（issue #395，execPolicyStore 同款 fail-safe）", () => {
  it("没有文件 = 正常空态，无错误", () => {
    const v = loadUserHooks(join(tempDir("otter-hooks-"), "hooks.json"));
    expect(v).toEqual({ hooks: [] });
  });

  it("坏 JSON = 空钩子 + 错误留在返回值（不炸、不半份生效）", () => {
    const p = join(tempDir("otter-hooks-"), "hooks.json");
    writeFileSync(p, "{broken");
    const v = loadUserHooks(p);
    expect(v.hooks).toEqual([]);
    expect(v.error).toContain("不是合法 JSON");
  });

  it("合法文件：钩子加载成功", () => {
    const p = join(tempDir("otter-hooks-"), "hooks.json");
    writeFileSync(
      p,
      JSON.stringify({ hooks: [{ name: "g", phase: "pre", tools: ["bash"], command: "./g.sh" }] })
    );
    const v = loadUserHooks(p);
    expect(v.error).toBeUndefined();
    expect(v.hooks[0]?.name).toBe("g");
  });
});
