import { describe, expect, it } from "vitest";
import { CLOUD_WORKSPACE_PREFIX, classifyIslandRow } from "../../src/shared/islandTabs.js";

const BUILTIN = "/Users/x/Documents/Mr Otto/Default";

describe("classifyIslandRow —— 岛上这一行归哪一档（#1229）", () => {
  it("普通工程：项目档，组头取项目根的末段", () => {
    expect(
      classifyIslandRow({ workspace: "/Users/x/Github/Mr_Otto/sub", projectRoot: "/Users/x/Github/Mr_Otto", builtinDefault: BUILTIN })
    ).toEqual({ kind: "project", groupLabel: "Mr_Otto" });
  });

  it("worktree 折回主仓之后，组头是主仓名不是副本目录名", () => {
    // 组名取 projectRoot 而不是 workspace：ADR-0157 之后每只水獭一份独立副本，
    // 按 workspace 分组的话组头会变成 `<12位哈希>-<6位随机>`，同一个项目还裂成 N 组
    expect(
      classifyIslandRow({
        workspace: "/Users/x/Library/.../worktrees/ab12cd34ef56-9x8y7z",
        projectRoot: "/Users/x/Github/Mr_Otto",
        builtinDefault: BUILTIN,
      })
    ).toEqual({ kind: "project", groupLabel: "Mr_Otto" });
  });

  it("任务会话（子目录形状，ADR-0206）：任务档，且**不分组**", () => {
    expect(
      classifyIslandRow({ workspace: `${BUILTIN}/s-20260910120000-ab12cd34`, projectRoot: null, builtinDefault: BUILTIN })
    ).toEqual({ kind: "task", groupLabel: null });
  });

  it("任务会话（旧形状：workspace 直接就是 Default 根）也算任务档", () => {
    expect(classifyIslandRow({ workspace: BUILTIN, projectRoot: BUILTIN, builtinDefault: BUILTIN }))
      .toEqual({ kind: "task", groupLabel: null });
  });

  it("云会话：团队档，组头写团队名", () => {
    expect(
      classifyIslandRow({
        workspace: `${CLOUD_WORKSPACE_PREFIX}9f1c2d3e`,
        projectRoot: `${CLOUD_WORKSPACE_PREFIX}9f1c2d3e`,
        builtinDefault: BUILTIN,
        teamName: "Otto 核心组",
      })
    ).toEqual({ kind: "team", groupLabel: "Otto 核心组" });
  });

  it("云会话先判 —— 否则它会变成一个组名是 UUID 的「项目」", () => {
    // workspaceLens 顺着那串合成路径找不到 .git，会回落成「就地当根」，
    // 于是 projectRoot 就等于那串字符串本身
    const r = classifyIslandRow({
      workspace: `${CLOUD_WORKSPACE_PREFIX}9f1c2d3e`,
      projectRoot: `${CLOUD_WORKSPACE_PREFIX}9f1c2d3e`,
      builtinDefault: BUILTIN,
    });
    expect(r.kind).toBe("team");
    expect(r.groupLabel).not.toContain("9f1c2d3e");
  });

  it("团队名查不到：写「团队」，不回落成那串 UUID", () => {
    for (const teamName of [undefined, null, "", "   "]) {
      expect(
        classifyIslandRow({
          workspace: `${CLOUD_WORKSPACE_PREFIX}9f1c2d3e`,
          projectRoot: null,
          builtinDefault: BUILTIN,
          teamName,
        })
      ).toEqual({ kind: "team", groupLabel: "团队" });
    }
  });

  it("拿不到内置 Default 的路径时不存在任务档 —— 那些行退回项目档，不凭空造一档", () => {
    expect(
      classifyIslandRow({ workspace: `${BUILTIN}/s-20260910120000-ab12cd34`, projectRoot: null, builtinDefault: null }).kind
    ).toBe("project");
  });

  it("史前会话（workspace 为 null）：项目档、无组头，交给 Swift 侧归「其他」", () => {
    expect(classifyIslandRow({ workspace: null, projectRoot: null, builtinDefault: BUILTIN }))
      .toEqual({ kind: "project", groupLabel: null });
  });
});
