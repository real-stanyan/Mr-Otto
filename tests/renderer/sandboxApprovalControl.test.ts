// 「沙箱内免审」那颗开关的三态与文案（#1029，ADR-0243）。
// 这里钉的不是像素是**话有没有说错**：谁能翻、显示的是不是真的、以及标签
// 不许退化成本地那颗的名字。

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

  it("标签不许是「免审批」——那是本地那颗的名字，两颗管的东西不一样", () => {
    expect(SANDBOX_APPROVAL_LABEL).not.toBe("免审批");
    expect(SANDBOX_APPROVAL_LABEL).toBe("沙箱内免审");
  });
});

describe("sandboxApprovalBanner", () => {
  it("只在真的免审时占那一行——关着是今天的行为，不值得一条常驻警示", () => {
    expect(sandboxApprovalBanner(sandboxApprovalControl({ ...WS, sandboxApproval: "auto" }, "owner")))
      .toContain("正在免审");
    expect(sandboxApprovalBanner(sandboxApprovalControl(WS, "owner"))).toBeNull();
  });

  it("读不到也要出声：那一格恰恰可能正开着免审，闷着就是把危险状态藏进一枚灰药丸的 title 里", () => {
    const line = sandboxApprovalBanner(sandboxApprovalControl({ ...WS, sandboxApproval: null }, "member"));
    expect(line).not.toBeNull();
    expect(line).toContain("说不准");
  });

  it("成员那一侧照样看得见——危险状态不按人分可见性（花的是 owner 的额度、动的是共用的卷）", () => {
    expect(sandboxApprovalBanner(sandboxApprovalControl({ ...WS, sandboxApproval: "auto" }, "member")))
      .toContain("正在免审");
  });
});
