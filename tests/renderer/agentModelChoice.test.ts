import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL, agentModelOptions, chainWarning, modelsFromSelection, providerOfPlatform, selectedModelValue,
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
  it("Auto 永远排第一，且不带 logo", () => {
    expect(agentModelOptions(["a", "b"], [])[0]).toEqual({ value: AUTO_MODEL, label: "Auto", provider: null });
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

  // #1247：原来 label 直接写 id，于是同一款模型在这枚下拉里叫 `deepseek-flash`、
  // 在输入框那枚选择器里叫 `DeepSeek-V4.1-Flash`，而两处点下去跑的是同一条路。
  // 存回去的仍然是 id（`value`）—— 变的只是画出来的那串字
  it("画的是目录里那份显示名，不是裸 id —— 与输入框那枚选择器同一份判据", () => {
    const opts = agentModelOptions(["deepseek-flash", "glm-5.3-flash"], []);
    expect(opts.slice(1).map((o) => o.label)).toEqual(["DeepSeek-V4.1-Flash", "GLM-5.3 Flash"]);
    expect(opts.slice(1).map((o) => o.value)).toEqual(["deepseek-flash", "glm-5.3-flash"]);
  });

  it("目录外的型号原样显示 id —— 网关上了新款而目录还没跟上，不许留空", () => {
    expect(agentModelOptions(["新款x"], []).slice(1).map((o) => o.label)).toEqual(["新款x"]);
  });

  it("已下架那几行也走同一份显示名", () => {
    expect(agentModelOptions([], ["deepseek-flash"]).slice(1)[0]).toMatchObject({
      value: "deepseek-flash",
      label: "DeepSeek-V4.1-Flash",
      stale: true,
    });
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

  it("念的是显示名（#1247）—— 这句话就贴在那枚下拉底下，两处不能是两套名字", () => {
    expect(chainWarning(["deepseek-flash", "glm-5.3"])).toContain("DeepSeek-V4.1-Flash → GLM-5.3");
  });
});

describe("providerOfPlatform（#1011）", () => {
  it("三家平台各自对上", () => {
    expect(providerOfPlatform("deepseek")).toBe("deepseek");
    expect(providerOfPlatform("qwen")).toBe("qwen");
  });

  it("智谱那家两套名字差一处：路由表叫 zhipu，providerCatalog 叫 glm", () => {
    expect(providerOfPlatform("zhipu")).toBe("glm");
  });

  it("认不出的平台 / 缺席回 null —— 不画 logo，好过画错一个", () => {
    expect(providerOfPlatform("moonshot-cn")).toBeNull();
    expect(providerOfPlatform(undefined)).toBeNull();
  });
});

describe("agentModelOptions 的 logo 那一格", () => {
  it("有平台就带上", () => {
    const opts = agentModelOptions(["glm-5.3", "qwen3.8-max"], [], { "glm-5.3": "zhipu", "qwen3.8-max": "qwen" });
    expect(opts.map((o) => o.provider)).toEqual([null, "glm", "qwen"]);
  });

  it("平台表缺席（旧 edge 不发这一格）= 一枚都不画，不是画错", () => {
    expect(agentModelOptions(["glm-5.3"], []).every((o) => o.provider === null)).toBe(true);
  });

  it("已下架那几款同样查平台 —— 不因为下架就少一枚图标", () => {
    const opts = agentModelOptions([], ["gone"], { gone: "deepseek" });
    expect(opts.find((o) => o.value === "gone")).toEqual({ value: "gone", label: "gone", provider: "deepseek", stale: true });
  });
});
