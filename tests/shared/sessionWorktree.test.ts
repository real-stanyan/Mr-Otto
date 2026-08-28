// 「同一个项目上的第二只水獭拿独立副本」的可执行版（issue #641，ADR-0156）。
//
// 判据这层最贵的错是**该隔离却没隔离**（两只水獭在同一个目录里互相踩，安静地丢东西），
// 但**不该隔离却隔离了**同样有代价：第一只水獭的活跑到一个用户看不见的目录里去了。
// 所以两个方向各有断言，尤其是「第一只不隔离」和「家族不算占用」这两条豁免。

import { describe, it, expect } from "vitest";
import {
  shouldIsolate,
  isolatedBranchName,
  isolatedDirName,
  isolatedPromptText,
} from "../../src/shared/sessionWorktree.js";

const REPO = "/Users/x/proj/.git";

describe("shouldIsolate（issue #641）", () => {
  it("第一只水獭不隔离——用户点的文件夹就是他看得见的那个", () => {
    expect(shouldIsolate({ repo: REPO, familyRoot: "new" }, [])).toBe(false);
  });

  it("同一个仓库已经有别的会话 → 隔离", () => {
    expect(
      shouldIsolate({ repo: REPO, familyRoot: "new" }, [{ repo: REPO, familyRoot: "a" }])
    ).toBe(true);
  });

  it("判据是仓库不是路径：已经在副本里的会话也算占着这个项目", () => {
    // 副本的 workspace 是另一个路径，但 --git-common-dir 指向同一个 .git
    expect(
      shouldIsolate({ repo: REPO, familyRoot: "new" }, [{ repo: REPO, familyRoot: "b" }])
    ).toBe(true);
  });

  it("别的项目不算占用", () => {
    expect(
      shouldIsolate({ repo: REPO, familyRoot: "new" }, [{ repo: "/other/.git", familyRoot: "a" }])
    ).toBe(false);
  });

  it("同家族（子会话 / SideChat）不算占用——共享工作区是故意的", () => {
    expect(
      shouldIsolate({ repo: REPO, familyRoot: "a" }, [{ repo: REPO, familyRoot: "a" }])
    ).toBe(false);
  });

  it("工作区不在 git 仓里 → 不隔离（没有 worktree 这回事，退回排队）", () => {
    expect(
      shouldIsolate({ repo: null, familyRoot: "new" }, [{ repo: null, familyRoot: "a" }])
    ).toBe(false);
  });
});

describe("命名", () => {
  it("分支名带随机后缀，脏字符压成连字符", () => {
    expect(isolatedBranchName("Files 面板 scroll", "a1b2c3")).toBe("otto/files-scroll-a1b2c3");
    // 全是压不掉的字符时也得有个能用的名字，不能产出 "otto/-a1b2c3"
    expect(isolatedBranchName("面板", "a1b2c3")).toBe("otto/session-a1b2c3");
  });

  it("目录名同时含项目哈希与随机后缀（多项目 / 多水獭都不撞）", () => {
    const a = isolatedDirName("a".repeat(64), "111111");
    const b = isolatedDirName("b".repeat(64), "111111");
    const c = isolatedDirName("a".repeat(64), "222222");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("isolatedPromptText", () => {
  it("告诉水獭它在副本上、项目本体在哪、合回去先问一句", () => {
    const t = isolatedPromptText({ projectRoot: "/Users/x/proj", branch: "otto/ui-a1b2c3" });
    expect(t).toContain("独立工作副本");
    expect(t).toContain("/Users/x/proj");
    expect(t).toContain("otto/ui-a1b2c3");
    // 「先问一句合到哪个分支」必须在场：模型的默认脾气是直接往 main 上合
    expect(t).toContain("先问");
    // 「别去动项目本体」必须在场：那边可能有另一只水獭
    expect(t).toContain("别去动");
  });
});
