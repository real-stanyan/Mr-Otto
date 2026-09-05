import { describe, it, expect } from "vitest";
import {
  AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX, AGENT_MODELS_MAX, CREATE_AGENT_TOOL_NAME,
  createAgentApprovalSummary, parseCreateAgentArgs,
} from "../../src/shared/createAgentDraft.js";

describe("parseCreateAgentArgs（#954）", () => {
  it("工具名常量是 create_agent", () => {
    expect(CREATE_AGENT_TOOL_NAME).toBe("create_agent");
  });

  it("只给 name：其余字段落默认（空职责/空提示词/[]型号=工作区默认/[]连接器=整池放行），name 两端空白剪掉", () => {
    expect(parseCreateAgentArgs({ name: " 广告 " })).toEqual({
      name: "广告", description: "", instructions: "", models: [], tools: [],
    });
  });

  it("name 缺席 / 非字符串 / 空 / 含 @ / 超 32 字都抛人话", () => {
    expect(() => parseCreateAgentArgs({})).toThrow("name 必填");
    expect(() => parseCreateAgentArgs({ name: 3 })).toThrow("name 必填");
    expect(() => parseCreateAgentArgs({ name: "  " })).toThrow("名字不能为空");
    expect(() => parseCreateAgentArgs({ name: "a@b" })).toThrow("不能有 @");
    expect(() => parseCreateAgentArgs({ name: "x".repeat(33) })).toThrow("最多 32 个字符");
  });

  it("职责 / 提示词 trim 后存；超上限抛错并说出上限数字", () => {
    const d = parseCreateAgentArgs({ name: "广告", description: " 管投放 ", instructions: " 你负责投放。 " });
    expect(d.description).toBe("管投放");
    expect(d.instructions).toBe("你负责投放。");
    expect(() => parseCreateAgentArgs({ name: "x", description: "d".repeat(AGENT_DESCRIPTION_MAX + 1) }))
      .toThrow(`description 最多 ${AGENT_DESCRIPTION_MAX} 字`);
    expect(() => parseCreateAgentArgs({ name: "x", instructions: "i".repeat(AGENT_INSTRUCTIONS_MAX + 1) }))
      .toThrow(`instructions 最多 ${AGENT_INSTRUCTIONS_MAX} 字`);
    expect(() => parseCreateAgentArgs({ name: "x", description: 7 })).toThrow("description 必须是字符串");
  });

  it("models：字符串数组，trim、去空、保序去重；非数组 / 含非字符串 / 超 8 个抛错", () => {
    expect(parseCreateAgentArgs({ name: "x", models: [" glm-4.5 ", "glm-4.5", "", "deepseek-chat"] }).models)
      .toEqual(["glm-4.5", "deepseek-chat"]);
    expect(() => parseCreateAgentArgs({ name: "x", models: "glm-4.5" })).toThrow("models 必须是字符串数组");
    expect(() => parseCreateAgentArgs({ name: "x", models: [1] })).toThrow("models 必须是字符串数组");
    expect(() => parseCreateAgentArgs({ name: "x", models: Array.from({ length: AGENT_MODELS_MAX + 1 }, (_, i) => `m${i}`) }))
      .toThrow(`models 最多 ${AGENT_MODELS_MAX} 个`);
  });

  it("tools：严格形状 [{serverId, tools:string[]}]，形状不对抛错而不是静默变成整池放行", () => {
    expect(parseCreateAgentArgs({ name: "x", tools: [{ serverId: "shopify", tools: [" orders ", "orders"] }, { serverId: "ads", tools: [] }] }).tools)
      .toEqual([{ serverId: "shopify", tools: ["orders"] }, { serverId: "ads", tools: [] }]);
    expect(() => parseCreateAgentArgs({ name: "x", tools: "shopify" })).toThrow("tools 必须是数组");
    expect(() => parseCreateAgentArgs({ name: "x", tools: [{ tools: [] }] })).toThrow("每一项要有 serverId");
    expect(() => parseCreateAgentArgs({ name: "x", tools: [{ serverId: "", tools: [] }] })).toThrow("每一项要有 serverId");
    expect(() => parseCreateAgentArgs({ name: "x", tools: [{ serverId: "shopify", tools: "orders" }] })).toThrow("tools 要是字符串数组");
    expect(() => parseCreateAgentArgs({ name: "x", tools: [{ serverId: "shopify" }] })).toThrow("tools 要是字符串数组");
  });
});

describe("createAgentApprovalSummary（ADR-0118 第二条：卡片逐字段）", () => {
  it("五行：名字 / 职责 / 型号 / 连接器 / 提示词全文，缺省各有说法", () => {
    expect(createAgentApprovalSummary({ name: "广告", description: "", instructions: "", models: [], tools: [] })).toBe(
      ["名字：广告", "职责：（没写）", "型号：工作区默认", "连接器：全部（不限）", "提示词（0 字）：（没写）"].join("\n")
    );
  });

  it("有内容时型号逗号并列、连接器按台列出（整台 / 点名工具），提示词不截断", () => {
    const long = "你负责投放。".repeat(300);
    const out = createAgentApprovalSummary({
      name: "广告", description: "管投放", instructions: long, models: ["glm-4.5", "deepseek-chat"],
      tools: [{ serverId: "shopify", tools: ["orders", "products"] }, { serverId: "ads", tools: [] }],
    });
    expect(out).toContain("职责：管投放");
    expect(out).toContain("型号：glm-4.5, deepseek-chat");
    expect(out).toContain("连接器：shopify（orders、products）；ads（整台）");
    expect(out).toContain(`提示词（${long.length} 字）：\n${long}`);
  });
});
