// 「哪些 git 命令会丢掉未提交改动」的可执行版（issue #633，ADR-0153）。
//
// 两头都要钉：
// - 漏判 = 用户的活没了（安静，事后才发现）
// - 误判 = 正常操作天天弹卡，而弹多了会训练用户闭眼点批准——那比不拦更糟
//
// 尤其是裸 `git checkout <分支>` 那条：它**不**该进名单（git 自己会拒绝覆盖），
// 这是本模块最容易被"好心"改错的地方，所以单独立一条断言压着。

import { describe, it, expect } from "vitest";
import { destructiveGit, dirtyWarning } from "../../src/shared/gitSafety.js";

describe("destructiveGit：认出真正会丢东西的那几条（issue #633）", () => {
  it("reset --hard 丢工作区；--soft/--mixed 不丢", () => {
    expect(destructiveGit("git reset --hard HEAD~1")?.sub).toBe("reset");
    expect(destructiveGit("git reset --soft HEAD~1")).toBeNull();
    expect(destructiveGit("git reset HEAD~1")).toBeNull();
    expect(destructiveGit("git reset")).toBeNull();
  });

  it("clean 要带 -f 才真删；-n 是预演", () => {
    expect(destructiveGit("git clean -fd")?.sub).toBe("clean");
    expect(destructiveGit("git clean --force")?.sub).toBe("clean");
    expect(destructiveGit("git clean -nd")).toBeNull();
    expect(destructiveGit("git clean -fdn")).toBeNull(); // 粘连里有 n = 预演
    expect(destructiveGit("git clean")).toBeNull();
  });

  it("裸 checkout / switch 分支**不**算——git 自己会拒绝覆盖（最常见的误解）", () => {
    expect(destructiveGit("git checkout main")).toBeNull();
    expect(destructiveGit("git checkout -b feat/x")).toBeNull();
    expect(destructiveGit("git switch main")).toBeNull();
  });

  it("checkout 还原文件 / 强制切 算", () => {
    expect(destructiveGit("git checkout -- src/a.ts")?.sub).toBe("checkout");
    expect(destructiveGit("git checkout .")?.sub).toBe("checkout");
    expect(destructiveGit("git checkout -f main")?.sub).toBe("checkout");
    expect(destructiveGit("git switch --discard-changes main")?.sub).toBe("switch");
  });

  it("restore 默认动工作区；只带 --staged 不动盘上的改动", () => {
    expect(destructiveGit("git restore src/a.ts")?.sub).toBe("restore");
    expect(destructiveGit("git restore --staged src/a.ts")).toBeNull();
    expect(destructiveGit("git restore --staged --worktree src/a.ts")?.sub).toBe("restore");
  });

  it("stash drop/clear 算；stash push 不算（东西还在 stash 里）", () => {
    expect(destructiveGit("git stash drop")?.sub).toBe("stash drop");
    expect(destructiveGit("git stash clear")?.sub).toBe("stash clear");
    expect(destructiveGit("git stash")).toBeNull();
    expect(destructiveGit("git stash push -u -m x")).toBeNull();
  });

  it("认得 git 的全局选项（-C/-c 夹在子命令前面）", () => {
    expect(destructiveGit("git -C /tmp/repo reset --hard")?.sub).toBe("reset");
    expect(destructiveGit("git -c core.editor=true clean -fd")?.sub).toBe("clean");
  });

  it("不是 git、或复杂脚本 → 不判定（宁可漏，不猜）", () => {
    expect(destructiveGit("rm -rf /")).toBeNull();
    expect(destructiveGit("git status && git reset --hard")).toBeNull(); // 有元字符 → raw
    expect(destructiveGit("echo git reset --hard")).toBeNull();
  });
});

describe("dirtyWarning", () => {
  it("列文件、超量截断、点明改动可能不是水獭做的", () => {
    const d = { sub: "reset", what: "丢弃未提交改动" };
    const m = dirtyWarning(d, ["a.ts", "b.ts"], 10);
    expect(m).toContain("a.ts");
    expect(m).toContain("2 个文件");
    expect(m).toContain("你自己在编辑器里改的");

    const many = dirtyWarning(d, Array.from({ length: 25 }, (_, i) => `f${i}.ts`), 10);
    expect(many).toContain("…还有 15 个");
  });
});
