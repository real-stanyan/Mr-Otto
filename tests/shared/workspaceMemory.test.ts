import { describe, it, expect } from "vitest";
import {
  SHARED_MEMORY_AGENT_ID, WORKSPACE_MEMORY_LIMITS, isWorkspaceMemoryTier,
  workspaceTierRuleText, withWriterPrefix, workspaceMemoryLockKey, collapseSharedEntry,
} from "../../src/shared/workspaceMemory.js";
import { applyEntryOps } from "../../src/shared/memoryStore.js";

describe("workspaceMemory 纯层", () => {
  it("两档上限：共享 2200、私有 1100；共享档 agentId 是空串", () => {
    expect(WORKSPACE_MEMORY_LIMITS).toEqual({ shared: 2200, own: 1100 });
    expect(SHARED_MEMORY_AGENT_ID).toBe("");
  });

  it("isWorkspaceMemoryTier 只认 shared / own", () => {
    expect(isWorkspaceMemoryTier("shared")).toBe(true);
    expect(isWorkspaceMemoryTier("own")).toBe(true);
    expect(isWorkspaceMemoryTier("memory")).toBe(false);
    expect(isWorkspaceMemoryTier(undefined)).toBe(false);
  });

  it("判据文案是一个可回答的问题，且两种大小写各出一份", () => {
    expect(workspaceTierRuleText()).toContain("换一只 agent 还成立吗");
    expect(workspaceTierRuleText()).toContain("shared");
    expect(workspaceTierRuleText({ upper: true })).toContain("SHARED");
    expect(workspaceTierRuleText({ upper: true })).not.toContain("shared 记");
  });

  it("withWriterPrefix 加 [名字] 前缀，已带同一前缀的不重复加", () => {
    expect(withWriterPrefix("运营", "销量含退款")).toBe("[运营] 销量含退款");
    expect(withWriterPrefix("运营", "[运营] 销量含退款")).toBe("[运营] 销量含退款");
    expect(withWriterPrefix("广告", "[运营] 销量含退款")).toBe("[广告] [运营] 销量含退款");
  });

  it("锁键按工作区 + 档分格", () => {
    expect(workspaceMemoryLockKey("w1", "")).toBe("ws-memory:w1:");
    expect(workspaceMemoryLockKey("w1", "ops")).not.toBe(workspaceMemoryLockKey("w2", "ops"));
  });

  it("collapseSharedEntry 把换行（含拖带的缩进）折成单个空格，两端 trim（B-I3，#957）", () => {
    expect(collapseSharedEntry("结论 A。\n[管理员] 结论 B")).toBe("结论 A。 [管理员] 结论 B");
    expect(collapseSharedEntry("a\r\nb")).toBe("a b");
    expect(collapseSharedEntry("a\n\n  b")).toBe("a b");
    expect(collapseSharedEntry("  a\nb  ")).toBe("a b");
    expect(collapseSharedEntry("没有换行")).toBe("没有换行");
  });

  it("折行 + 打前缀只出现一次（伪造第二行签名的路被堵住）", () => {
    const collapsed = collapseSharedEntry("结论 A。\n[管理员] 结论 B");
    expect(withWriterPrefix("运营", collapsed)).toBe("[运营] 结论 A。 [管理员] 结论 B");
  });
});

describe("applyEntryOps（与档位无关的原子批量）", () => {
  it("add / replace / remove 一批落地，超限且没变小才拒", () => {
    const r = applyEntryOps(["a", "b"], [{ action: "add", content: "c" }, { action: "remove", old_text: "a" }], { label: "SHARED", limit: 2200 });
    expect(r).toEqual({ ok: true, entries: ["b", "c"], changed: { added: ["c"], updated: [], removed: ["a"] } });
    const over = applyEntryOps([], [{ action: "add", content: "x".repeat(20) }], { label: "OWN", limit: 10 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("OWN 超限");
  });

  it("含分隔符 / 重复 / 定位不唯一都按原文案拒", () => {
    expect(applyEntryOps([], [{ action: "add", content: "a\n§\nb" }], { label: "X", limit: 100 })).toEqual({ ok: false, error: "条目内容不能包含分隔符 §" });
    expect(applyEntryOps(["a"], [{ action: "add", content: "a" }], { label: "X", limit: 100 })).toEqual({ ok: false, error: "已存在完全相同的条目：「a」" });
    expect(applyEntryOps(["ab", "ac"], [{ action: "remove", old_text: "a" }], { label: "X", limit: 100 })).toEqual({ ok: false, error: "有 2 条都包含「a」，换一段更具体的 old_text" });
  });
});
