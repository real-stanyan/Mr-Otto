import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL, agentModelOptions, chainWarning, modelsFromSelection, selectedModelValue,
} from "../../src/renderer/src/lib/agentModelChoice.js";

describe("selectedModelValue / modelsFromSelection", () => {
  it("空链 = Auto，来回一趟不变形", () => {
    expect(selectedModelValue([])).toBe(AUTO_MODEL);
    expect(modelsFromSelection(AUTO_MODEL)).toEqual([]);
  });

  it("单款来回一趟不变形", () => {
    expect(selectedModelValue(["glm-5.3"])).toBe("glm-5.3");
    expect(modelsFromSelection("glm-5.3")).toEqual(["glm-5.3"]);
  });

  it("长度 > 1 的链选中的是第一款 —— 那也正是网关实际会用的那一款（ADR-0232）", () => {
    expect(selectedModelValue(["glm-5.3", "qwen3.8-max"])).toBe("glm-5.3");
  });

  it("Auto 的值不是空串 —— Radix 的 SelectItem 禁止空串 value，塞进去运行时抛错", () => {
    expect(AUTO_MODEL).not.toBe("");
  });
});

describe("agentModelOptions", () => {
  it("Auto 永远排第一", () => {
    expect(agentModelOptions(["a", "b"], [])[0]).toEqual({ value: AUTO_MODEL, label: "Auto" });
  });

  it("网关供的那几款按原顺序列出，不去重成乱序", () => {
    expect(agentModelOptions(["b", "a"], []).slice(1).map((o) => o.value)).toEqual(["b", "a"]);
  });

  it("重复的 available 只出现一次", () => {
    expect(agentModelOptions(["a", "a"], []).filter((o) => o.value === "a")).toHaveLength(1);
  });

  it("agent 指着一款已经不在路由表里的 —— 照样画出来并标 stale，不静默丢", () => {
    const opts = agentModelOptions(["a"], ["gone"]);
    expect(opts.map((o) => o.value)).toEqual([AUTO_MODEL, "a", "gone"]);
    expect(opts.find((o) => o.value === "gone")?.stale).toBe(true);
  });

  it("选中的那款就在表里时不标 stale", () => {
    expect(agentModelOptions(["a"], ["a"]).find((o) => o.value === "a")?.stale).toBeUndefined();
  });

  it("清单拉不到时只剩 Auto + 存量 —— 不假装「一款都没有」", () => {
    expect(agentModelOptions([], ["glm-5.3"]).map((o) => o.value)).toEqual([AUTO_MODEL, "glm-5.3"]);
  });
});

describe("chainWarning", () => {
  it("没有链就不出声", () => {
    expect(chainWarning([])).toBeNull();
    expect(chainWarning(["a"])).toBeNull();
  });

  it("有链时把整条链念出来 —— 选一款会把后面几款丢掉，得先说一声", () => {
    expect(chainWarning(["a", "b"])).toContain("a → b");
  });
});
