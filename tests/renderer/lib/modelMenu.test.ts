// 输入框那枚型号选择器列出哪几款（#1042）。
//
// 这几条断言存在的理由：改动前这个菜单只按「配没配 key」筛厂商，而 `routeModel` 里
// 托管**优先于**自带 key —— 一个付了钱、一把 key 都没配的用户打开它一组都看不到。
// 那个失败模式是安静的（菜单渲染不出错，只是少几行），本机三家 key 都配着更把它
// 完全掩盖了（同 #1040 那一族的盲区）。所以判据必须钉住，不能留在 useMemo 里。

import { describe, expect, it } from "vitest";
import { modelMenuGroups } from "../../../src/renderer/src/lib/modelMenu.js";
import { AUTO_MODEL } from "../../../src/shared/autoModel.js";

/** 网关真供的那六款（`model_route` 表，从便宜到贵） */
const HOSTED = [
  "deepseek-v4-flash",
  "glm-5.3-flash",
  "qwen3.8-flash",
  "deepseek-v4-pro",
  "glm-5.3",
  "qwen3.8-max",
];

const base = {
  hosted: [] as readonly string[],
  allowAuto: false,
  keyStatus: {} as Record<string, string>,
  ollamaModels: [],
  currentModel: "deepseek-v4-flash",
  filter: undefined,
};

const ids = (gs: ReturnType<typeof modelMenuGroups>, key: string) =>
  gs.find((g) => g.key === key)?.items.map((i) => i.id) ?? null;

describe("modelMenuGroups：订阅那一组", () => {
  it("一把 key 都没配的订阅用户，菜单里有网关供的每一款（这是 #1042 修的那件事）", () => {
    const gs = modelMenuGroups({ ...base, hosted: HOSTED });
    expect(ids(gs, "__hosted__")).toEqual(HOSTED);
  });

  it("顺序原样照抄网关那一份（从便宜到贵），不按厂商重排", () => {
    // 这一串跨三家厂交替出现；按厂商归并会把「便宜的在前」这条信息毁掉，
    // 而它正是 Auto 那两档的依据（ADR-0237）
    const gs = modelMenuGroups({ ...base, hosted: HOSTED });
    expect(ids(gs, "__hosted__")).toEqual(HOSTED);
  });

  it("没订阅（hosted 空）= 整组不出现，菜单退回改动前的样子", () => {
    const gs = modelMenuGroups({ ...base, keyStatus: { DEEPSEEK_API_KEY: "sk-x" } });
    expect(ids(gs, "__hosted__")).toBeNull();
    expect(gs.map((g) => g.key)).toEqual(["deepseek"]);
  });

  it("订阅供的那几款从厂商组里**摘掉**，不并排出现两次", () => {
    // 同一个型号在两处点下去跑的是同一条路（托管优先于自带 key，ADR-0176 决定二），
    // 列两遍只会让人以为有得选
    const gs = modelMenuGroups({
      ...base,
      hosted: HOSTED,
      keyStatus: { DEEPSEEK_API_KEY: "sk-x", GLM_API_KEY: "sk-y" },
    });
    expect(ids(gs, "deepseek")).not.toContain("deepseek-v4-flash");
    expect(ids(gs, "glm")).not.toContain("glm-5.3");
    // 网关不供的那几款照旧留在厂商组里（那些要烧自己的 key）
    expect(ids(gs, "glm")).toContain("glm-4.7-flash");
  });

  it("订阅那一组排在最前", () => {
    const gs = modelMenuGroups({
      ...base, hosted: HOSTED, keyStatus: { DEEPSEEK_API_KEY: "sk-x" },
    });
    expect(gs[0]!.key).toBe("__hosted__");
  });

  it("目录里没有的型号（网关上了新款）原样按 id 列出来，不静默丢", () => {
    const gs = modelMenuGroups({ ...base, hosted: ["glm-5.3", "brand-new-model"] });
    expect(ids(gs, "__hosted__")).toEqual(["glm-5.3", "brand-new-model"]);
  });

  it("但给了 filter 时目录外的那一款只能丢——那道筛子问的是我们此刻答不出的问题", () => {
    const gs = modelMenuGroups({
      ...base,
      hosted: ["glm-5.3-flash", "brand-new-model"],
      filter: (m) => m.supportsVision === true,
    });
    expect(ids(gs, "__hosted__")).toEqual(["glm-5.3-flash"]);
  });
});

describe("modelMenuGroups：Auto", () => {
  it("allowAuto + 有两款以上可挑 → Auto 是订阅组的第一项", () => {
    const gs = modelMenuGroups({ ...base, hosted: HOSTED, allowAuto: true });
    expect(ids(gs, "__hosted__")![0]).toBe(AUTO_MODEL);
    expect(gs.find((g) => g.key === "__hosted__")!.items[0]!.auto).toBe(true);
  });

  it("不到两款时不画 —— pickAutoModel 那时一律回 null，画出来就是点了没反应的钮", () => {
    expect(ids(modelMenuGroups({ ...base, hosted: ["glm-5.3"], allowAuto: true }), "__hosted__"))
      .toEqual(["glm-5.3"]);
    expect(modelMenuGroups({ ...base, hosted: [], allowAuto: true, currentModel: "" })).toEqual([]);
  });

  it("allowAuto 缺省 = 不画：代读员 / 小模型 / 子智能体那几处换的不是「这一 turn 用哪款」", () => {
    const gs = modelMenuGroups({ ...base, hosted: HOSTED });
    expect(ids(gs, "__hosted__")).not.toContain(AUTO_MODEL);
  });

  it("Auto 那一项不带厂商字形、也不算看得见图", () => {
    const auto = modelMenuGroups({ ...base, hosted: HOSTED, allowAuto: true })
      .find((g) => g.key === "__hosted__")!.items[0]!;
    expect(auto.provider).toBeNull();
    expect(auto.vision).toBe(false);
  });
});

describe("modelMenuGroups：厂商那几组（改动前的行为要一字不变）", () => {
  it("没配 key 的厂商不进菜单", () => {
    const gs = modelMenuGroups({ ...base, keyStatus: { GLM_API_KEY: "sk-y" }, currentModel: "glm-5.3" });
    expect(gs.map((g) => g.key)).toEqual(["glm"]);
  });

  it("当前选中的那一款照旧找得到自己 —— 但放行的是**它**，不是它那一家", () => {
    // 按「那一家」放行会顺带把同厂另外几款没 key 也没托管的型号一起放进来
    const gs = modelMenuGroups({ ...base, currentModel: "glm-5.3" });
    expect(ids(gs, "glm")).toEqual(["glm-5.3"]);
  });

  it("能力过滤（只列看得见图的）照旧生效，滤空的组整组不出现", () => {
    const gs = modelMenuGroups({
      ...base,
      keyStatus: { DEEPSEEK_API_KEY: "sk-x" },
      currentModel: "deepseek-v4-pro",
      filter: (m) => m.supportsVision === true,
    });
    expect(ids(gs, "deepseek")).toEqual(["deepseek-v4-flash-vision-exp"]);
  });

  it("Ollama：只列会调工具的那几款；一款都没有就整组不出现", () => {
    const ollama = [
      { id: "ollama/a", tag: "a", contextLength: 8192, tools: true, vision: false, thinking: false },
      { id: "ollama/b", tag: "b", contextLength: 8192, tools: false, vision: false, thinking: false },
    ];
    const gs = modelMenuGroups({ ...base, ollamaModels: ollama, currentModel: "" });
    expect(ids(gs, "ollama")).toEqual(["ollama/a"]);
    expect(modelMenuGroups({ ...base, ollamaModels: [], currentModel: "" }).map((g) => g.key))
      .not.toContain("ollama");
  });
});
