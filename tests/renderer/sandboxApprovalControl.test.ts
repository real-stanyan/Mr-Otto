// 「免审批」那颗开关（工作区那颗）的三态与文案（#1029，ADR-0243）。
// 这里钉的不是像素是**话有没有说错**：谁能翻、显示的是不是真的。
// 标签与警示行两条旧钉法 2026-09-08 被维护者对着真机翻掉（见下两条用例的注释）。

import { describe, expect, it } from "vitest";
import {
  SANDBOX_APPROVAL_LABEL, sandboxApprovalBanner, sandboxApprovalControl,
} from "../../src/renderer/src/lib/sandboxApprovalControl.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const WS: WorkspaceSnapshot = {
  id: "w", name: "群", ownerUid: "owner", members: [], connectors: [], sessions: [], agents: [],
  sandboxApproval: "ask",
};

describe("sandboxApprovalControl", () => {
  it("owner 翻得动；文案说清作用域是整个工作区、覆盖面只有沙箱那两把刀", () => {
    const c = sandboxApprovalControl({ ...WS, sandboxApproval: "auto" }, "owner");
    expect(c.kind).toBe("toggle");
    expect(c.kind === "toggle" && c.on).toBe(true);
    expect(c.title).toContain("整个工作区");
    expect(c.title).toContain("连接器");
    // 两个方向的生效时机不对称，且不对称的方向是「刹车立刻、放行要等」
    expect(c.title).toContain("关掉立刻生效");
  });

  it("非 owner 看得到状态但没有开关——不画一枚点了必然拿到「无权修改」的钮（#722 那个撒谎的勾）", () => {
    const c = sandboxApprovalControl({ ...WS, sandboxApproval: "auto" }, "someone-else");
    expect(c.kind).toBe("readonly");
    expect(c.kind === "readonly" && c.on).toBe(true);
    expect(c.kind === "readonly" && c.note).toContain("所有者");
  });

  it("读不到（null）不画成「关着」：那一列查挂了而 runtime 照旧按真值放行，界面说的和做的就反了", () => {
    const c = sandboxApprovalControl({ ...WS, sandboxApproval: null }, "owner");
    expect(c.kind).toBe("unknown");
    expect(c.title).toContain("读不到");
  });

  it("读不到时 owner 仍然按得下刹车、按不动放行——只往严的一边（同 ADR-0243 决策 6 那条纪律）", () => {
    const mine = sandboxApprovalControl({ ...WS, sandboxApproval: null }, "owner");
    const theirs = sandboxApprovalControl({ ...WS, sandboxApproval: null }, "member");
    expect(mine.kind === "unknown" && mine.canForceAsk).toBe(true);
    expect(theirs.kind === "unknown" && theirs.canForceAsk).toBe(false);
  });

  it("标签就是「免审批」——与本地那颗同名是维护者 2026-09-08 拍板的（ADR-0243 原先钉死不同名，那条断言随之作废）", () => {
    expect(SANDBOX_APPROVAL_LABEL).toBe("免审批");
  });
});

describe("sandboxApprovalBanner", () => {
  it("免审开着不占那一行——常驻警示被维护者撤掉（2026-09-08），开着就是开着，警示色药丸自己说", () => {
    expect(sandboxApprovalBanner(sandboxApprovalControl({ ...WS, sandboxApproval: "auto" }, "owner")))
      .toBeNull();
    expect(sandboxApprovalBanner(sandboxApprovalControl(WS, "owner"))).toBeNull();
  });

  it("读不到仍要出声：那一格恰恰可能正开着免审，闷着就是把危险状态藏进一枚灰药丸的 title 里（这条没被撤）", () => {
    const line = sandboxApprovalBanner(sandboxApprovalControl({ ...WS, sandboxApproval: null }, "member"));
    expect(line).not.toBeNull();
    expect(line).toContain("说不准");
  });

  it("成员那一侧同样不出警示行——开着时不按人分的那条可见性，随警示行一起撤了", () => {
    expect(sandboxApprovalBanner(sandboxApprovalControl({ ...WS, sandboxApproval: "auto" }, "member")))
      .toBeNull();
  });
});
