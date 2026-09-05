// workspaceAgents 纯校验单测：agent 表单的名字合法性 + 模型清单解析（#932 切片 1b）+
// 接力上限的表单校验（#950 Task 9）。

import { describe, it, expect } from "vitest";
import {
  AGENT_NAME_MAX, agentNameConflict, collapseWhitespace, normalizeAgentName,
  parseModelList, validateAgentName, validateRelayMaxDepth,
} from "../../src/shared/workspaceAgents.js";

describe("validateAgentName", () => {
  it("合法：中文 / 英文（无内部空白），1–32 字符", () => {
    expect(validateAgentName("运营")).toBeNull();
    expect(validateAgentName("AdsAnalyst")).toBeNull();
    expect(validateAgentName("x".repeat(AGENT_NAME_MAX))).toBeNull();
  });
  it("空 / 全空白 / 超长 / 含 @ / 含换行 —— 各给一句理由", () => {
    expect(validateAgentName("")).toMatch(/名字/);
    expect(validateAgentName("   ")).toMatch(/名字/);
    expect(validateAgentName("x".repeat(AGENT_NAME_MAX + 1))).toMatch(/32/);
    expect(validateAgentName("运@营")).toMatch(/@/);
    expect(validateAgentName("运\n营")).toMatch(/换行/);
  });
  it("零宽字符（B-I2）拒绝，回「不可见字符」", () => {
    expect(validateAgentName("管理员​")).toMatch(/不可见/); // 零宽空格
    expect(validateAgentName("管理员‎")).toMatch(/不可见/); // LRM 方向控制
  });
  it("内部空白（B-I2，@ 补全打不过空格）拒绝，回「空白」——此前被接受的 \"Ads Analyst\" 现在也拒绝", () => {
    expect(validateAgentName("Ads Analyst")).toMatch(/空白/);
    expect(validateAgentName("运 营")).toMatch(/空白/);
  });
});

describe("normalizeAgentName（NFKC + trim，落库前跑）", () => {
  it("全角转半角：Ａｄｓ → Ads", () => {
    expect(normalizeAgentName("Ａｄｓ")).toBe("Ads");
  });
  it("两端空白剪掉", () => {
    expect(normalizeAgentName("  广告  ")).toBe("广告");
  });
});

describe("agentNameConflict（B-I2：前缀劫持防护）", () => {
  it("同名冲突", () => {
    expect(agentNameConflict("运营", ["管理员", "运营"])).toMatch(/冲突/);
  });
  it("前缀冲突双向：新名字是已有名字的前缀 / 已有名字是新名字的前缀", () => {
    expect(agentNameConflict("管理员", ["管理员帮我"])).toMatch(/管理员帮我.*冲突|冲突.*管理员帮我/);
    expect(agentNameConflict("管理员帮我", ["管理员"])).toMatch(/管理员.*冲突|冲突.*管理员/);
  });
  it("不冲突时回 null", () => {
    expect(agentNameConflict("广告", ["管理员", "运营"])).toBeNull();
  });
  it("空名字提前放行，不对已有名单里的每一个都报假冲突（\"\".startsWith 恒真的坑）", () => {
    expect(agentNameConflict("", ["管理员", "运营"])).toBeNull();
  });
});

describe("collapseWhitespace（B-C2：短字段折空白，绕开 pre-wrap 空格伪造整行）", () => {
  it("66 个空格折成 1 个", () => {
    expect(collapseWhitespace("管投放" + " ".repeat(66) + "职责：假的职责")).toBe("管投放 职责：假的职责");
  });
  it("多种连续空白（含 tab）折成单个空格", () => {
    expect(collapseWhitespace("a\t\t  b")).toBe("a b");
  });
  it("无连续空白时原样返回", () => {
    expect(collapseWhitespace("广告")).toBe("广告");
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
