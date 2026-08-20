import { describe, expect, it } from "vitest";
import {
  assignLanes, classifyGitError, isValidBranchName, parseBranchList,
  parseGitLog, parseNumstat, parseRefs, pickSpineBranch,
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
    expect(out[0]!.subject).toBe("fix: a, b 和 c");
  });

  it("格式错误(字段不足)则跳过该记录", () => {
    const out = parseGitLog(
      `\x01abc\x00incomplete\n` + // 只有 2 个字段,跳过
      `\x01valid\x00\x00\x00x\x001\x00subj\n` // 完整 6 字段
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.hash).toBe("valid");
  });
});

describe("parseRefs（--decorate=full 的全名形式）", () => {
  it("HEAD -> refs/heads/X = head 类型，名字剥到短名", () => {
    expect(parseRefs("HEAD -> refs/heads/main")).toEqual([{ name: "main", type: "head" }]);
  });
  it("detached HEAD 单独出现 = head", () => {
    expect(parseRefs("HEAD, tag: refs/tags/v2")).toEqual([
      { name: "HEAD", type: "head" }, { name: "v2", type: "tag" },
    ]);
  });
  it("按 refs/ 前缀分类,不再猜 remote 名——非 origin/upstream 的 remote 不会被当成本地分支", () => {
    expect(parseRefs("refs/heads/feat/x, refs/remotes/fork/feat/x, refs/remotes/origin/feat/x")).toEqual([
      { name: "feat/x", type: "branch" },
      { name: "fork/feat/x", type: "remote" },
      { name: "origin/feat/x", type: "remote" },
    ]);
  });
  it("名字里带 refs 字样的分支不被误剥", () => {
    expect(parseRefs("refs/heads/refs/heads/weird")).toEqual([
      { name: "refs/heads/weird", type: "branch" },
    ]);
  });
  it("没有 refs/ 前缀时退回短名启发式（log.decorate=short 被外部配置强按下的情形）", () => {
    expect(parseRefs("main, origin/main")).toEqual([
      { name: "main", type: "branch" }, { name: "origin/main", type: "remote" },
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
    expect(rows[0]!.edges).toEqual([{ fromLane: 0, toLane: 0 }]);
    expect(rows[1]!.edges).toEqual([{ fromLane: 0, toLane: 0 }]);
    expect(rows[2]!.edges).toEqual([]); // 根 commit,线到此为止
  });

  it("分叉:两个 tip 共父,第二 tip 开 1 道,汇入父所在 0 道", () => {
    // a 和 b 都指向 c(topo 序:a b c)
    const rows = assignLanes([c("a", ["cc"]), c("b", ["cc"]), c("cc", [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    // b 行与 cc 行之间:0 道直落到 cc,1 道弯进 0 道(同一目标 hash 汇合)
    expect(rows[1]!.edges).toContainEqual({ fromLane: 0, toLane: 0 });
    expect(rows[1]!.edges).toContainEqual({ fromLane: 1, toLane: 0 });
  });

  it("合并 commit:第二父开新道,merge 线从 dot 拉出", () => {
    // m 是合并(父 p1 p2),topo 序 m p1 p2
    const rows = assignLanes([c("m", ["p1", "p2"]), c("p1", []), c("p2", [])]);
    expect(rows[0]!.lane).toBe(0);
    // m 行下方:0 道续给 p1,新道 1 从 dot(0)拉向 1(第二父)
    expect(rows[0]!.edges).toContainEqual({ fromLane: 0, toLane: 0 });
    expect(rows[0]!.edges).toContainEqual({ fromLane: 0, toLane: 1 });
    expect(rows[2]!.lane).toBe(1);
  });

  it("第二父已有道在等:直接汇入既有道,不开新道", () => {
    // topo: m(p1,shared) b(shared) p1 shared —— b 先等 shared 于 1 道,
    // m 的第二父 shared 复用 1 道
    const rows = assignLanes([
      c("m", ["p1", "shared"]), c("b", ["shared"]), c("p1", []), c("shared", []),
    ]);
    // m 落 0;1 道已被 m 的第二父(shared)占用,b 是独立 tip 开 2 道;
    // shared 被 1 道(m 的 merge 线)和 2 道(b 的第一父)同时等,落最左的 1 道
    expect(rows[0]!.lane).toBe(0);
    expect(rows[1]!.lane).toBe(2);
    expect(rows[0]!.edges).toContainEqual({ fromLane: 0, toLane: 1 }); // merge 线并入既有 1 道
    expect(rows[3]!.lane).toBe(1);
  });

  it("交叉合并(criss-cross):两个 merge 互相跨到对方的父,线不串道", () => {
    // m1、m2 各自的两个父是同一对 (a, b)，方向相反 —— 泳道表要能同时
    // 让两条线等着同一批 hash，且各归各的 dot
    const rows = assignLanes([
      c("m1", ["a", "b"]),
      c("m2", ["b", "a"]),
      c("a", ["r"]),
      c("b", ["r"]),
      c("r", []),
    ]);
    // 每个 commit 恰好一行，没有重复落座
    expect(rows.map((r) => r.hash)).toEqual(["m1", "m2", "a", "b", "r"]);
    // a、b 各占一道且互不相同 —— 串道的表现就是这两个撞在一起
    const laneOf = Object.fromEntries(rows.map((r) => [r.hash, r.lane]));
    expect(laneOf["a"]).not.toBe(laneOf["b"]);
    // 两个 merge 都在自己那一行画出了并线段
    expect(rows[0]!.edges.some((e) => e.fromLane === laneOf["m1"])).toBe(true);
    expect(rows[1]!.edges.some((e) => e.fromLane === laneOf["m2"])).toBe(true);
    // 根之后没有悬着的线
    expect(rows[4]!.edges).toEqual([]);
  });

  it("多根(orphan):互不相连各占道,道用完可回收", () => {
    const rows = assignLanes([c("a", []), c("b", [])]);
    // a 落 0 且不占用(无父,道立刻释放),b 复用 0 道
    expect(rows[0]!.lane).toBe(0);
    expect(rows[1]!.lane).toBe(0);
  });
});

/** 带 ref 的 commit:主脊测试要靠 refs 认出主干 tip */
const cr = (hash: string, parents: string[], refs: RawCommit["refs"]): RawCommit => ({
  hash, parents, refs, author: "a", timestamp: 0, subject: "s",
});

describe("assignLanes 主脊预留", () => {
  it("主干 tip 钉 0 道,先出现的 feature 让到 1 道", () => {
    // topo 序:feature 的 commit 更新(在前),主干 tip 在后
    const rows = assignLanes([
      cr("f1", ["base"], [{ name: "feat/x", type: "head" }]),
      cr("m1", ["base"], [{ name: "main", type: "branch" }]),
      cr("base", [], []),
    ], "main");
    expect(rows[0]!.lane).toBe(1); // feature 不许占 0 道
    expect(rows[1]!.lane).toBe(0); // 主干 tip 强制落 0
    expect(rows[2]!.lane).toBe(0); // 共同祖先续在主脊上
  });

  it("主干的一父链一直续 0 道,不被回收给别人", () => {
    const rows = assignLanes([
      cr("m1", ["m2"], [{ name: "main", type: "branch" }]),
      cr("m2", ["m3"], []),
      cr("t1", [], [{ name: "feat/y", type: "branch" }]), // 孤立 tip:只能开 1 道
      cr("m3", [], []),
    ], "main");
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
  });

  it("主干 tip 已被别的线等着,也拽回 0 道(线弯进主脊)", () => {
    // f1 的父就是主干 tip m1:m1 会被 f1 那条线等在 1 道上
    const rows = assignLanes([
      cr("f1", ["m1"], [{ name: "feat/x", type: "head" }]),
      cr("m1", [], [{ name: "main", type: "branch" }]),
    ], "main");
    expect(rows[0]!.lane).toBe(1);
    expect(rows[1]!.lane).toBe(0);
    expect(rows[0]!.edges).toContainEqual({ fromLane: 1, toLane: 0 });
  });

  it("窗口里没有该分支:不预留,0 道照常给第一个 tip(免得白留一列)", () => {
    const rows = assignLanes([c("a", []), c("b", [])], "main");
    expect(rows.map((r) => r.lane)).toEqual([0, 0]);
  });

  it("不传 spineBranch = 老行为不变", () => {
    const withArg = assignLanes([cr("f1", ["x"], []), cr("m1", ["x"], []), c("x", [])]);
    expect(withArg.map((r) => r.lane)).toEqual([0, 1, 0]);
  });

  it("remote ref 同名不算数(origin/main 不是本地主干 tip)", () => {
    const rows = assignLanes([
      cr("r1", [], [{ name: "origin/main", type: "remote" }]),
      cr("m1", [], [{ name: "main", type: "branch" }]),
    ], "main");
    expect(rows[0]!.lane).toBe(1);
    expect(rows[1]!.lane).toBe(0);
  });
});

describe("pickSpineBranch", () => {
  const withRefs = (refs: RawCommit["refs"]) => [cr("h", [], refs)];

  it("origin/HEAD 指的分支优先(前提:窗口里见得到)", () => {
    expect(pickSpineBranch(withRefs([
      { name: "develop", type: "branch" }, { name: "main", type: "branch" },
    ]), "develop")).toBe("develop");
  });

  it("origin/HEAD 指的分支不在窗口里:退 main", () => {
    expect(pickSpineBranch(withRefs([{ name: "main", type: "branch" }]), "develop")).toBe("main");
  });

  it("没有 main 就退 master", () => {
    expect(pickSpineBranch(withRefs([{ name: "master", type: "branch" }]), null)).toBe("master");
  });

  it("都没有就退当前 HEAD 分支", () => {
    expect(pickSpineBranch(withRefs([{ name: "feat/x", type: "head" }]), null)).toBe("feat/x");
  });

  it("detached HEAD(ref 名就叫 HEAD)不当主脊", () => {
    expect(pickSpineBranch(withRefs([{ name: "HEAD", type: "head" }]), null)).toBeNull();
  });

  it("一个分支都认不出:null(不硬猜)", () => {
    expect(pickSpineBranch(withRefs([{ name: "v1", type: "tag" }]), null)).toBeNull();
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

  it("rename:带花括号的紧凑写法解成新路径,旧路径单独留着", () => {
    expect(parseNumstat("0\t0\tsrc/{a.txt => b.txt}\n")).toEqual([
      { file: "src/b.txt", renamedFrom: "src/a.txt", insertions: 0, deletions: 0 },
    ]);
  });

  it("rename:花括号一侧为空(挪进子目录)不留出双斜杠", () => {
    expect(parseNumstat("1\t2\tsrc/{ => sub}/a.txt\n")).toEqual([
      { file: "src/sub/a.txt", renamedFrom: "src/a.txt", insertions: 1, deletions: 2 },
    ]);
  });

  it("rename:没有公共前后缀时 git 写成裸的 old => new", () => {
    expect(parseNumstat("3\t4\ta.txt => b.txt\n")).toEqual([
      { file: "b.txt", renamedFrom: "a.txt", insertions: 3, deletions: 4 },
    ]);
  });

  it("文件名里含 => 字样但不是 rename 行:原样当路径,不瞎拆", () => {
    expect(parseNumstat("1\t0\tdocs/a=>b.md\n")).toEqual([
      { file: "docs/a=>b.md", insertions: 1, deletions: 0 },
    ]);
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

describe("parseBranchList", () => {
  it("* 标记当前分支,空格标记其余", () => {
    expect(parseBranchList("*\x00main\n \x00feat/x\n")).toEqual([
      { name: "main", current: true },
      { name: "feat/x", current: false },
    ]);
  });

  it("空输出 = 空列表(新仓库还没有分支)", () => {
    expect(parseBranchList("")).toEqual([]);
  });

  it("字段缺失的行跳过,不猜名字", () => {
    expect(parseBranchList("*\x00main\n坏行没有分隔符\n \x00\n")).toEqual([{ name: "main", current: true }]);
  });
});

describe("isValidBranchName", () => {
  it("常见合法名通过", () => {
    for (const n of ["main", "feat/branch-picker", "release/1.2.3", "fix_x"]) {
      expect(isValidBranchName(n), n).toBe(true);
    }
  });

  it("`-` 开头拒收——会被 git 当选项读", () => {
    expect(isValidBranchName("--force")).toBe(false);
    expect(isValidBranchName("-b")).toBe(false);
  });

  it("空名/超长/含空白或 git 禁用字符拒收", () => {
    expect(isValidBranchName("")).toBe(false);
    expect(isValidBranchName("a".repeat(256))).toBe(false);
    expect(isValidBranchName("has space")).toBe(false);
    expect(isValidBranchName("a..b")).toBe(false);
    expect(isValidBranchName("a@{b")).toBe(false);
    expect(isValidBranchName("a~1")).toBe(false);
    expect(isValidBranchName("main; rm -rf /")).toBe(false);
  });
});
