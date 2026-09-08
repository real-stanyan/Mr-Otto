// 三把 Git 刀的纯逻辑（#1105）。这一份钉的是**闸**——每一条都对应一个真会
// 弄坏东西的动作：清掉别人的文件、推到主干、把私有仓库建成公开的。

import { describe, it, expect } from "vitest";
import {
  cloneTargetState, parseCloneArgs, parseCreateRepoArgs, parsePushArgs,
  pushesDefaultBranch, sameRepoUrl,
} from "../../src/shared/gitTools.js";

const REPO = "https://github.com/acme/widgets.git";

describe("cloneTargetState", () => {
  it("空目录 → empty", () => {
    expect(cloneTargetState({ entries: 0, origin: "" }, REPO)).toBe("empty");
  });

  it("已经是同一个仓库 → same-repo（回「已经在了」并跳过）", () => {
    expect(cloneTargetState({ entries: 12, origin: REPO }, REPO)).toBe("same-repo");
    // 结尾 .git / 斜杠 / host 大小写都不算差别
    expect(cloneTargetState({ entries: 12, origin: "https://GitHub.com/acme/widgets/" }, REPO)).toBe("same-repo");
  });

  it("有东西且不是同一个仓库 → occupied（拒绝，**不删文件**）", () => {
    expect(cloneTargetState({ entries: 3, origin: "" }, REPO)).toBe("occupied");
    expect(cloneTargetState({ entries: 3, origin: "https://github.com/acme/other.git" }, REPO)).toBe("occupied");
  });

  it("只有三态 —— 没有任何一条会导向删除", () => {
    const states = new Set([
      cloneTargetState({ entries: 0, origin: "" }, REPO),
      cloneTargetState({ entries: 1, origin: REPO }, REPO),
      cloneTargetState({ entries: 1, origin: "x" }, REPO),
    ]);
    expect([...states].sort()).toEqual(["empty", "occupied", "same-repo"]);
  });
});

describe("sameRepoUrl", () => {
  it("路径大小写**算**差别 —— 合并两个不同仓比拆开同一个仓更糟", () => {
    expect(sameRepoUrl("https://github.com/acme/Widgets", "https://github.com/acme/widgets")).toBe(false);
  });
  it("解析不出来的一律不算同一个", () => {
    expect(sameRepoUrl("git@github.com:a/b.git", REPO)).toBe(false);
    expect(sameRepoUrl("", "")).toBe(false);
  });
});

describe("parseCloneArgs", () => {
  it("正常参数", () => {
    expect(parseCloneArgs({ repo_url: ` ${REPO} `, dest: "code/widgets" }))
      .toEqual({ repoUrl: REPO, dest: "code/widgets" });
  });

  it("`..` 与绝对路径一律拒 —— **不解释成上跳一级**（ADR-0251）", () => {
    expect(() => parseCloneArgs({ repo_url: REPO, dest: "../etc" })).toThrow(/不合法/);
    expect(() => parseCloneArgs({ repo_url: REPO, dest: "/etc" })).toThrow(/不合法/);
  });

  it("dest 是根目录 → 当场拒绝，不让人跑一趟必然 occupied", () => {
    expect(() => parseCloneArgs({ repo_url: REPO, dest: "" })).toThrow(/子目录/);
    expect(() => parseCloneArgs({ repo_url: REPO, dest: "." })).toThrow(/子目录/);
  });

  it("缺参数 / 不是对象 → 明说缺哪个", () => {
    expect(() => parseCloneArgs({ dest: "x" })).toThrow(/repo_url/);
    expect(() => parseCloneArgs("nope")).toThrow(/对象/);
  });
});

describe("parsePushArgs", () => {
  it("正常参数", () => {
    expect(parsePushArgs({ dest: "code/widgets", branch: "otto/fix", message: " 修好了 " }))
      .toEqual({ dest: "code/widgets", branch: "otto/fix", message: "修好了" });
  });

  it("分支名里 git 不接受的字符一律拒 —— `-` 开头会被当成选项", () => {
    for (const bad of ["with space", "a..b", "-force", "a~1", "a^", "a:b", ""]) {
      expect(() => parsePushArgs({ dest: "d", branch: bad, message: "m" })).toThrow();
    }
  });

  it("message 不能空 —— 提交要说清楚改了什么", () => {
    expect(() => parsePushArgs({ dest: "d", branch: "b", message: "   " })).toThrow(/message/);
  });

  it("dest 仍然过路径闸", () => {
    expect(() => parsePushArgs({ dest: "../x", branch: "b", message: "m" })).toThrow(/不合法/);
  });
});

describe("parseCreateRepoArgs", () => {
  it("private **默认 true** —— 两种建错方向的代价不对称", () => {
    expect(parseCreateRepoArgs({ name: "widgets" })).toEqual({ name: "widgets", private: true });
    expect(parseCreateRepoArgs({ name: "widgets", private: false })).toEqual({ name: "widgets", private: false });
  });

  it("名字按 GitHub 的规矩", () => {
    expect(() => parseCreateRepoArgs({ name: "a b" })).toThrow(/字符/);
    expect(() => parseCreateRepoArgs({ name: "" })).toThrow(/不能为空/);
    expect(() => parseCreateRepoArgs({ name: "x".repeat(101) })).toThrow(/太长/);
  });

  it("private 不是布尔 → 拒绝，不猜", () => {
    expect(() => parseCreateRepoArgs({ name: "x", private: "yes" })).toThrow(/true 或 false/);
  });
});

describe("pushesDefaultBranch", () => {
  it("等于默认分支 → true", () => {
    expect(pushesDefaultBranch("main", "main")).toBe(true);
    expect(pushesDefaultBranch("otto/fix", "main")).toBe(false);
  });

  it("**查不到默认分支也算 true** —— 那一刻正是网络出问题的时候，而这道闸拦的是不可逆写入", () => {
    expect(pushesDefaultBranch("otto/fix", null)).toBe(true);
  });
});
