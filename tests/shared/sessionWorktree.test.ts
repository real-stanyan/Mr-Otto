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
  renamedBranch,
} from "../../src/shared/sessionWorktree.js";

const REPO = "/Users/x/proj/.git";

describe("shouldIsolate（issue #641，判据在 #644 收窄成一条）", () => {
  it("工作区在 git 仓里 → 隔离。第一只也隔离（#644 取消了那条例外）", () => {
    expect(shouldIsolate({ repo: REPO })).toBe(true);
  });

  it("工作区不在 git 仓里 → 不隔离（没有 worktree 这回事，退回原目录）", () => {
    expect(shouldIsolate({ repo: null })).toBe(false);
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
    // 分支名**不**写死在提示里：改名之后日志里那份就陈旧了，而投影必须可从日志推导
    expect(t).not.toContain("otto/ui-a1b2c3");
    expect(t).toContain("git branch --show-current");
    // 「先问一句合到哪个分支」必须在场：模型的默认脾气是直接往 main 上合
    expect(t).toContain("先问");
    // 「别去动项目本体」必须在场：那边可能有另一只水獭
    expect(t).toContain("别去动");
    // #644 之后每只水獭都在副本里，用户打开自己的项目目录会以为什么都没发生——
    // 「动文件之前先说明白」是这套隔离唯一的缓解，掉了就是静默的困惑
    expect(t).toContain("第一次动文件之前");
    expect(t).toContain("项目目录暂时不会变");
  });
});

describe("renamedBranch（issue #647）", () => {
  it("换掉可读的那一半，随机后缀留着", () => {
    expect(renamedBranch("otto/session-a1b2c3", "Files 面板 scroll")).toBe("otto/files-scroll-a1b2c3");
  });

  it("标题里没有可用字符 → null（不改名）", () => {
    expect(renamedBranch("otto/session-a1b2c3", "面板")).toBeNull();
  });

  it("改出来跟原名一样 → null（不做空操作）", () => {
    expect(renamedBranch("otto/files-a1b2c3", "files")).toBeNull();
  });

  it("不是我们建的那种名字 → 不碰（用户自己的分支不该被改名）", () => {
    expect(renamedBranch("feature/whatever", "标题 title")).toBeNull();
  });
});
