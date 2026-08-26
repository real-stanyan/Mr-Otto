import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExecPolicy, appendAllowRule, removeExecRule } from "../../src/main/execPolicyStore.js";
import { createPolicyAwareApprover } from "../../src/main/uiApprover.js";
import type { Approver } from "../../src/loop/approvalGate.js";
import type { Tool } from "../../src/tools/tool.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "execpolicy-")), "execPolicy.json");

describe("loadExecPolicy（坏规则拒绝加载，issue #347 ②）", () => {
  it("没有文件 = 空规则、无错误", () => {
    expect(loadExecPolicy(tmp())).toEqual({ rules: [] });
  });

  it("坏 JSON / 缺 rules：整个文件按空规则处理并报错（fail-safe）", () => {
    const p1 = tmp();
    writeFileSync(p1, "{broken");
    expect(loadExecPolicy(p1).error).toMatch(/不是合法 JSON/);
    expect(loadExecPolicy(p1).rules).toEqual([]);

    const p2 = tmp();
    writeFileSync(p2, JSON.stringify({ notRules: [] }));
    expect(loadExecPolicy(p2).error).toMatch(/缺少 rules/);
  });

  it("规则没过校验（用例失败/禁止前缀）：一条坏 = 整份不生效", () => {
    const p = tmp();
    writeFileSync(
      p,
      JSON.stringify({
        rules: [
          { pattern: ["git", "status"], decision: "allow" }, // 好的
          { pattern: ["sudo"], decision: "allow" }, // 禁止前缀
        ],
      })
    );
    const loaded = loadExecPolicy(p);
    expect(loaded.error).toMatch(/禁止前缀/);
    expect(loaded.rules).toEqual([]); // 不存在"半份规则生效"
  });
});

describe("appendAllowRule（审批 UI 产出，issue #347 ③）", () => {
  it("追加 + 立即可读（热更新 = 读取方现读文件）；cwd 掺入", () => {
    const p = tmp();
    expect(appendAllowRule(p, ["npm", "test"], "/proj/a")).toBe(true);
    const loaded = loadExecPolicy(p);
    expect(loaded.rules).toEqual([{ pattern: ["npm", "test"], decision: "allow", cwd: "/proj/a" }]);
    // 幂等
    expect(appendAllowRule(p, ["npm", "test"], "/proj/a")).toBe(true);
    expect(loadExecPolicy(p).rules).toHaveLength(1);
  });

  it("候选撞禁止前缀：拒绝追加（调用方退回精确 key）", () => {
    const p = tmp();
    expect(appendAllowRule(p, ["git"], "/proj/a")).toBe(false);
    expect(appendAllowRule(p, ["sudo", "ls"], "/proj/a")).toBe(false);
    expect(loadExecPolicy(p).rules).toEqual([]);
  });

  it("文件是坏的：拒绝往没生效的文件里堆规则", () => {
    const p = tmp();
    writeFileSync(p, "{broken");
    expect(appendAllowRule(p, ["ls"], undefined)).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("{broken"); // 原文不动
  });
});

describe("removeExecRule（设置页的删除入口，issue #370）", () => {
  it("按 pattern+decision+cwd 精确匹配删一条，其余保留，热生效", () => {
    const p = tmp();
    appendAllowRule(p, ["npm", "test"], "/proj/a");
    appendAllowRule(p, ["npm", "run", "lint"], "/proj/a");
    expect(
      removeExecRule(p, { pattern: ["npm", "test"], decision: "allow", cwd: "/proj/a" })
    ).toBe(true);
    expect(loadExecPolicy(p).rules).toEqual([
      { pattern: ["npm", "run", "lint"], decision: "allow", cwd: "/proj/a" },
    ]);
  });

  it("匹配不到（pattern 或 cwd 不同）= false，文件不动", () => {
    const p = tmp();
    appendAllowRule(p, ["npm", "test"], "/proj/a");
    expect(
      removeExecRule(p, { pattern: ["npm", "test"], decision: "allow", cwd: "/proj/b" })
    ).toBe(false);
    expect(loadExecPolicy(p).rules).toHaveLength(1);
  });

  it("文件是坏的：拒绝操作（先修文件，别在没生效的规则集上做手术）", () => {
    const p = tmp();
    writeFileSync(p, "{broken");
    expect(removeExecRule(p, { pattern: ["ls"], decision: "allow" })).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("{broken");
  });
});

describe("createPolicyAwareApprover（跨会话生效 + 日志可见，issue #347 验收）", () => {
  const bashTool = { def: { name: "bash" } } as Tool;
  const innerNever: Approver = {
    decide: () => Promise.reject(new Error("不该走到内层")),
  };
  const innerAsk: Approver = {
    decide: () => Promise.resolve({ decision: "approved", reason: "内层批的" }),
  };

  it("forbidden：硬拒且 reason 带判定依据（落进 approval_decision 即日志可见）", async () => {
    const rules = [{ pattern: ["git", "push", "--force"], decision: "forbidden" as const }];
    const approver = createPolicyAwareApprover(() => ({ rules }), undefined, innerNever);
    const out = await approver.decide(
      { id: "c1", name: "bash", args: { cmd: "git push --force" } },
      bashTool
    );
    expect(out.decision).toBe("denied");
    expect(out.reason).toMatch(/execpolicy/);
  });

  it("allow：免弹卡放行；prompt/没意见/复杂脚本/非 bash：交给内层", async () => {
    const rules = [
      { pattern: ["git", "status"], decision: "allow" as const },
      { pattern: ["npm"], decision: "prompt" as const },
    ];
    const approver = createPolicyAwareApprover(() => ({ rules }), undefined, innerAsk);

    const allowed = await approver.decide(
      { id: "c1", name: "bash", args: { cmd: "git status" } },
      bashTool
    );
    expect(allowed).toMatchObject({ decision: "approved", reason: expect.stringContaining("execpolicy") });

    for (const args of [
      { cmd: "npm install" }, // prompt
      { cmd: "ls | wc -l" }, // 复杂脚本
      { cmd: "cat a.txt" }, // 规则没说
    ]) {
      const out = await approver.decide({ id: "c", name: "bash", args }, bashTool);
      expect(out.reason).toBe("内层批的");
    }
    const nonBash = await approver.decide(
      { id: "c", name: "write_file", args: { path: "/a", content: "x" } },
      bashTool
    );
    expect(nonBash.reason).toBe("内层批的");
  });

  it("热更新：getPolicy 是活引用，追加规则后下一次 decide 立即生效", async () => {
    const p = tmp();
    const approver = createPolicyAwareApprover(() => loadExecPolicy(p), "/proj/a", innerAsk);
    const call = { id: "c1", name: "bash", args: { cmd: "npm test" } };

    expect((await approver.decide(call, bashTool)).reason).toBe("内层批的");
    appendAllowRule(p, ["npm", "test"], "/proj/a");
    expect((await approver.decide(call, bashTool)).reason).toMatch(/execpolicy/);
  });
});
