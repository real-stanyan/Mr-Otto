// 审批链上那一层「破坏性 git + 工作区脏 = 必须问人」的可执行版（issue #633，ADR-0153）。
//
// 这一层的价值全在**越过短路**：bypass 模式、长期授权都压不过它。所以断言盯的是
// 「命中时走的是 ui，不是 inner」和「不命中时 inner 一个字节都没绕过」。
// fail-open（读不到工作区状态就不加摩擦）也要钉——它是有意选的，不是疏漏。

import { describe, it, expect, vi } from "vitest";
import { createDirtyTreeAwareApprover } from "../../src/main/dirtyTreeApprover.js";
import type { Approver } from "../../src/loop/approvalGate.js";
import type { ToolCallRequest } from "../../src/session/events.js";
import type { Tool } from "../../src/tools/tool.js";

const TOOL = { name: "bash", requiresApproval: true } as unknown as Tool;
const call = (cmd: string): ToolCallRequest =>
  ({ id: "c1", name: "bash", args: { cmd } }) as unknown as ToolCallRequest;

function approver(label: string): Approver & { calls: number } {
  const a = {
    calls: 0,
    decide: async () => {
      a.calls++;
      return { decision: "approved" as const, reason: label };
    },
  };
  return a;
}

describe("dirtyTreeApprover（issue #633）", () => {
  it("破坏性 git + 工作区脏 → 直接问 ui，绕开 inner（bypass/授权压不过）", async () => {
    const inner = approver("inner");
    const ui = approver("ui");
    const a = createDirtyTreeAwareApprover(
      { dirtyFiles: async () => ["src/a.ts"], cwd: "/w" },
      inner,
      ui
    );
    const out = await a.decide(call("git reset --hard"), TOOL);
    expect(ui.calls).toBe(1);
    expect(inner.calls).toBe(0);
    // 会丢什么，必须出现在 reason 里——它同时是 UI 卡片和 tool_result 的内容
    expect(out.reason).toContain("src/a.ts");
    expect(out.reason).toContain("ui");
  });

  it("工作区干净 → 走 inner，与从前逐字节一致", async () => {
    const inner = approver("inner");
    const ui = approver("ui");
    const a = createDirtyTreeAwareApprover({ dirtyFiles: async () => [], cwd: "/w" }, inner, ui);
    const out = await a.decide(call("git reset --hard"), TOOL);
    expect(inner.calls).toBe(1);
    expect(ui.calls).toBe(0);
    expect(out.reason).toBe("inner");
  });

  it("不是破坏性命令 → 连工作区状态都不去读（不给正常操作加开销）", async () => {
    const inner = approver("inner");
    const dirtyFiles = vi.fn(async () => ["a.ts"]);
    const a = createDirtyTreeAwareApprover({ dirtyFiles, cwd: "/w" }, inner, approver("ui"));
    await a.decide(call("git status"), TOOL);
    expect(dirtyFiles).not.toHaveBeenCalled();
    expect(inner.calls).toBe(1);
  });

  it("读不到工作区状态 → fail-open 走 inner（这一层是额外的一道，不是唯一那道）", async () => {
    const inner = approver("inner");
    const ui = approver("ui");
    const a = createDirtyTreeAwareApprover(
      {
        dirtyFiles: async () => {
          throw new Error("不是 git 仓库");
        },
        cwd: "/w",
      },
      inner,
      ui
    );
    await a.decide(call("git clean -fd"), TOOL);
    expect(inner.calls).toBe(1);
    expect(ui.calls).toBe(0);
  });

  it("非 bash 工具原样透传", async () => {
    const inner = approver("inner");
    const a = createDirtyTreeAwareApprover({ dirtyFiles: async () => ["a"], cwd: "/w" }, inner, approver("ui"));
    await a.decide({ id: "c", name: "write_file", args: { path: "x" } } as unknown as ToolCallRequest, TOOL);
    expect(inner.calls).toBe(1);
  });
});
