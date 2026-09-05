// workspaceAgents 纯校验单测：agent 表单的名字合法性 + 模型清单解析（#932 切片 1b）+
// 接力上限的表单校验（#950 Task 9）。

import { describe, it, expect } from "vitest";
import {
  AGENT_NAME_MAX, parseModelList, validateAgentName, validateRelayMaxDepth,
} from "../../src/shared/workspaceAgents.js";

describe("validateAgentName", () => {
  it("合法：中文 / 英文 / 带空格，1–32 字符", () => {
    expect(validateAgentName("运营")).toBeNull();
    expect(validateAgentName("Ads Analyst")).toBeNull();
    expect(validateAgentName("x".repeat(AGENT_NAME_MAX))).toBeNull();
  });
  it("空 / 全空白 / 超长 / 含 @ / 含换行 —— 各给一句理由", () => {
    expect(validateAgentName("")).toMatch(/名字/);
    expect(validateAgentName("   ")).toMatch(/名字/);
    expect(validateAgentName("x".repeat(AGENT_NAME_MAX + 1))).toMatch(/32/);
    expect(validateAgentName("运@营")).toMatch(/@/);
    expect(validateAgentName("运\n营")).toMatch(/换行/);
  });
});

describe("parseModelList", () => {
  it("英文/中文逗号、多余空白、重复、空项", () => {
    expect(parseModelList(" deepseek-v4 ,glm-5，deepseek-v4,, ")).toEqual(["deepseek-v4", "glm-5"]);
    expect(parseModelList("")).toEqual([]);
  });
});

describe("validateRelayMaxDepth", () => {
  it("1–20 之间的整数字符串 → ok:true 带解析出的数字", () => {
    expect(validateRelayMaxDepth("6")).toEqual({ ok: true, value: 6 });
    expect(validateRelayMaxDepth("1")).toEqual({ ok: true, value: 1 });
    expect(validateRelayMaxDepth("20")).toEqual({ ok: true, value: 20 });
  });
  it("空 / 非数字 / 越界 / 非整数 —— 各回一句人话（1 到 20 之间的整数）", () => {
    for (const raw of ["", "abc", "0", "21", "2.5"]) {
      const r = validateRelayMaxDepth(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/1.*20.*整数/);
    }
  });
});
