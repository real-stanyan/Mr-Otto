import { describe, expect, it } from "vitest";
import {
  evaluateCommand,
  patternMatches,
  strictest,
  validateRules,
  type ExecRule,
} from "../../src/shared/execPolicy.js";

// 命令安全静态判定（issue #347）：前缀规则 + 加载期校验 + 禁止前缀清单 + 兜底启发式。

describe("patternMatches", () => {
  it("前缀语义：pattern 命中 argv 开头，argv 更长照样命中", () => {
    expect(patternMatches(["git", "status"], ["git", "status"])).toBe(true);
    expect(patternMatches(["git", "status"], ["git", "status", "--porcelain"])).toBe(true);
    expect(patternMatches(["git", "status"], ["git"])).toBe(false);
    expect(patternMatches(["git", "status"], ["git", "push"])).toBe(false);
  });

  it("元素可为「或」列表", () => {
    const p = [["ls", "dir"], "-la"];
    expect(patternMatches(p, ["ls", "-la"])).toBe(true);
    expect(patternMatches(p, ["dir", "-la", "/tmp"])).toBe(true);
    expect(patternMatches(p, ["cat", "-la"])).toBe(false);
  });
});

describe("多规则命中取最严", () => {
  it("forbidden > prompt > allow", () => {
    expect(strictest("allow", "prompt")).toBe("prompt");
    expect(strictest("prompt", "forbidden")).toBe("forbidden");
    const rules: ExecRule[] = [
      { pattern: ["git"], decision: "prompt" },
      { pattern: ["git", "push", "--force"], decision: "forbidden" },
      { pattern: ["git", "push"], decision: "allow" },
    ];
    expect(evaluateCommand("git push --force origin", rules)?.decision).toBe("forbidden");
    expect(evaluateCommand("git log", rules)?.decision).toBe("prompt");
  });
});

describe("validateRules（加载期校验，issue #347 ②④）", () => {
  it("形状不对：拒绝", () => {
    expect(validateRules([{ pattern: [], decision: "allow" }]).length).toBe(1);
    expect(validateRules([{ pattern: ["ls", ""], decision: "allow" }]).length).toBe(1);
    expect(
      validateRules([{ pattern: ["ls"], decision: "yes" as never }]).length
    ).toBe(1);
  });

  it("自带用例校验：match 未命中 / notMatch 命中 = 规则写错，当场爆", () => {
    const wrongMatch: ExecRule[] = [
      { pattern: ["git", "status"], decision: "allow", match: ["git log"] },
    ];
    expect(validateRules(wrongMatch)[0]!.message).toMatch(/没有命中/);

    const wideRule: ExecRule[] = [
      { pattern: ["git"], decision: "prompt", notMatch: ["git status"] },
    ];
    expect(validateRules(wideRule)[0]!.message).toMatch(/命中了 pattern/);

    const good: ExecRule[] = [
      {
        pattern: ["git", "status"],
        decision: "allow",
        match: ["git status", "git status --porcelain"],
        notMatch: ["git push"],
      },
    ];
    expect(validateRules(good)).toEqual([]);
  });

  it("禁止前缀清单（包装/解释器）：bash -lc 及其两个方向都不能当 allow 前缀", () => {
    for (const pattern of [
      ["bash"],
      ["bash", "-lc"],
      ["bash", "-lc", "git status"],
      ["sh", "-c"],
      ["python", "-c"],
      ["node", "-e"],
      ["sudo"],
      ["sudo", "apt", "install"],
      ["env"],
      ["xargs", "rm"],
      ["ssh", "host"],
    ]) {
      const errs = validateRules([{ pattern, decision: "allow" }]);
      expect(errs.length, pattern.join(" ")).toBeGreaterThan(0);
    }
  });

  it("禁止前缀清单（裸命令）：裸 git/rm 不能 allow，带子命令可以", () => {
    expect(validateRules([{ pattern: ["git"], decision: "allow" }]).length).toBe(1);
    expect(validateRules([{ pattern: ["rm"], decision: "allow" }]).length).toBe(1);
    expect(validateRules([{ pattern: [["git", "rm"]], decision: "allow" }]).length).toBe(1); // 或列表混入也拒
    expect(validateRules([{ pattern: ["git", "status"], decision: "allow" }])).toEqual([]);
    expect(validateRules([{ pattern: ["ls"], decision: "allow" }])).toEqual([]);
  });

  it("清单只约束 allow：同样的 pattern 写 forbidden/prompt 是清单的本意", () => {
    expect(validateRules([{ pattern: ["sudo"], decision: "forbidden" }])).toEqual([]);
    expect(validateRules([{ pattern: ["rm"], decision: "prompt" }])).toEqual([]);
  });
});

describe("evaluateCommand（含兜底启发式，issue #347 ⑤）", () => {
  it("规则没说 = undefined（交给审批记忆/弹卡）", () => {
    expect(evaluateCommand("ls -la", [])).toBeUndefined();
  });

  it("复杂脚本（token 化失败）不做静态判定", () => {
    const rules: ExecRule[] = [{ pattern: ["git", "push"], decision: "forbidden" }];
    expect(evaluateCommand("git push && rm -rf /", rules)).toBeUndefined();
  });

  it("包装命令递归：sudo/bash -lc 里的 forbidden 照样抓到", () => {
    const rules: ExecRule[] = [{ pattern: ["git", "push", "--force"], decision: "forbidden" }];
    expect(evaluateCommand("sudo git push --force", rules)?.decision).toBe("forbidden");
    expect(evaluateCommand("bash -lc 'git push --force'", rules)?.decision).toBe("forbidden");
    expect(evaluateCommand("env FOO=1 git push --force", rules)?.decision).toBe("forbidden");
  });

  it("包装命令里的 allow 降级为 prompt（只有整条精确规则能穿透包装）", () => {
    const rules: ExecRule[] = [{ pattern: ["git", "status"], decision: "allow" }];
    // 前缀命中（内层还有多余参数），又裹在 sudo 里 → 降级
    expect(evaluateCommand("sudo git status --porcelain", rules)?.decision).toBe("prompt");
    // 不裹包装：allow 原样生效
    expect(evaluateCommand("git status --porcelain", rules)?.decision).toBe("allow");
  });

  it("rm 带 force：allow 降级 prompt；整条精确规则不降级", () => {
    const prefixAllow: ExecRule[] = [{ pattern: ["rm", "-rf"], decision: "allow" }];
    expect(evaluateCommand("rm -rf node_modules", prefixAllow)?.decision).toBe("prompt");

    const exactAllow: ExecRule[] = [{ pattern: ["rm", "-rf", "node_modules"], decision: "allow" }];
    expect(evaluateCommand("rm -rf node_modules", exactAllow)?.decision).toBe("allow");
  });

  it("cwd 作用域：带 cwd 的规则只在该工作区生效", () => {
    const rules: ExecRule[] = [{ pattern: ["npm", "test"], decision: "allow", cwd: "/proj/a" }];
    expect(evaluateCommand("npm test", rules, "/proj/a")?.decision).toBe("allow");
    expect(evaluateCommand("npm test", rules, "/proj/b")).toBeUndefined();
    expect(evaluateCommand("npm test", rules)).toBeUndefined();
  });
});
