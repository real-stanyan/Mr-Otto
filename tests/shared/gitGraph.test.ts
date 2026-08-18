import { describe, expect, it } from "vitest";
import {
  assignLanes, classifyGitError, parseGitLog, parseNumstat, parseRefs,
  type RawCommit,
} from "../../src/shared/gitGraph.js";

/** 造 commit 的速记:泳道测试只关心 hash/parents */
const c = (hash: string, parents: string[]): RawCommit => ({
  hash, parents, refs: [], author: "a", timestamp: 0, subject: "s",
});

describe("parseGitLog", () => {
  it("按 \\x01 分记录、\\x00 分字段解析", () => {
    const rec = (h: string, p: string, d: string, an: string, at: string, s: string) =>
      `\x01${h}\x00${p}\x00${d}\x00${an}\x00${at}\x00${s}\n`;
    const out = parseGitLog(
      rec("aaa", "bbb ccc", "HEAD -> main, origin/main", "stan", "1755500000", "merge: 合流") +
      rec("bbb", "", "tag: v1", "bot", "1755400000", "首个 commit")
    );
    expect(out).toEqual([
      {
        hash: "aaa", parents: ["bbb", "ccc"],
        refs: [{ name: "main", type: "head" }, { name: "origin/main", type: "remote" }],
        author: "stan", timestamp: 1755500000, subject: "merge: 合流",
      },
      {
        hash: "bbb", parents: [],
        refs: [{ name: "v1", type: "tag" }],
        author: "bot", timestamp: 1755400000, subject: "首个 commit",
      },
    ]);
  });

  it("空输出 = 空数组", () => {
    expect(parseGitLog("")).toEqual([]);
  });

  it("subject 里的逗号/空格原样保留", () => {
    const out = parseGitLog(`\x01abc\x00\x00\x00x\x001\x00fix: a, b 和 c\n`);
    expect(out[0].subject).toBe("fix: a, b 和 c");
  });
});

describe("parseRefs", () => {
  it("HEAD -> 分支 = head 类型", () => {
    expect(parseRefs("HEAD -> main")).toEqual([{ name: "main", type: "head" }]);
  });
  it("detached HEAD 单独出现 = head", () => {
    expect(parseRefs("HEAD, tag: v2")).toEqual([
      { name: "HEAD", type: "head" }, { name: "v2", type: "tag" },
    ]);
  });
  it("含 / 的是 remote,其余是本地分支", () => {
    expect(parseRefs("feat/x, origin/feat/x")).toEqual([
      { name: "feat/x", type: "branch" }, { name: "origin/feat/x", type: "remote" },
    ]);
  });
  it("空串 = 空数组", () => {
    expect(parseRefs("")).toEqual([]);
  });
});

describe("assignLanes", () => {
  it("线性链:全在 0 道,行间直线", () => {
    const rows = assignLanes([c("a", ["b"]), c("b", ["c"]), c("c", [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0].edges).toEqual([{ fromLane: 0, toLane: 0 }]);
    expect(rows[1].edges).toEqual([{ fromLane: 0, toLane: 0 }]);
    expect(rows[2].edges).toEqual([]); // 根 commit,线到此为止
  });

  it("分叉:两个 tip 共父,第二 tip 开 1 道,汇入父所在 0 道", () => {
    // a 和 b 都指向 c(topo 序:a b c)
    const rows = assignLanes([c("a", ["cc"]), c("b", ["cc"]), c("cc", [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    // b 行与 cc 行之间:0 道直落到 cc,1 道弯进 0 道(同一目标 hash 汇合)
    expect(rows[1].edges).toContainEqual({ fromLane: 0, toLane: 0 });
    expect(rows[1].edges).toContainEqual({ fromLane: 1, toLane: 0 });
  });

  it("合并 commit:第二父开新道,merge 线从 dot 拉出", () => {
    // m 是合并(父 p1 p2),topo 序 m p1 p2
    const rows = assignLanes([c("m", ["p1", "p2"]), c("p1", []), c("p2", [])]);
    expect(rows[0].lane).toBe(0);
    // m 行下方:0 道续给 p1,新道 1 从 dot(0)拉向 1(第二父)
    expect(rows[0].edges).toContainEqual({ fromLane: 0, toLane: 0 });
    expect(rows[0].edges).toContainEqual({ fromLane: 0, toLane: 1 });
    expect(rows[2].lane).toBe(1);
  });

  it("第二父已有道在等:直接汇入既有道,不开新道", () => {
    // topo: m(p1,shared) b(shared) p1 shared —— b 先等 shared 于 1 道,
    // m 的第二父 shared 复用 1 道
    const rows = assignLanes([
      c("m", ["p1", "shared"]), c("b", ["shared"]), c("p1", []), c("shared", []),
    ]);
    // m 落 0;1 道已被 m 的第二父(shared)占用,b 是独立 tip 开 2 道;
    // shared 被 1 道(m 的 merge 线)和 2 道(b 的第一父)同时等,落最左的 1 道
    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(2);
    expect(rows[0].edges).toContainEqual({ fromLane: 0, toLane: 1 }); // merge 线并入既有 1 道
    expect(rows[3].lane).toBe(1);
  });

  it("多根(orphan):互不相连各占道,道用完可回收", () => {
    const rows = assignLanes([c("a", []), c("b", [])]);
    // a 落 0 且不占用(无父,道立刻释放),b 复用 0 道
    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(0);
  });
});

describe("parseNumstat", () => {
  it("数字行 + binary 行(- -)", () => {
    expect(parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n")).toEqual([
      { file: "src/a.ts", insertions: 12, deletions: 3 },
      { file: "logo.png", insertions: null, deletions: null },
    ]);
  });
  it("空输出 = 空数组", () => {
    expect(parseNumstat("")).toEqual([]);
  });
});

describe("classifyGitError", () => {
  it("ENOENT = git-missing", () => {
    expect(classifyGitError({ code: "ENOENT", message: "spawn git ENOENT" }).kind).toBe("git-missing");
  });
  it("not a git repository = no-repo", () => {
    expect(classifyGitError({ stderr: "fatal: not a git repository (or any of the parent directories)" }).kind).toBe("no-repo");
  });
  it("其余 = git-error,detail 带原文", () => {
    const r = classifyGitError({ stderr: "fatal: bad object xyz" });
    expect(r.kind).toBe("git-error");
    expect(r.detail).toContain("bad object");
  });
});
