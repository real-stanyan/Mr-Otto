import { describe, expect, it } from "vitest";
import {
  classifyCode, countChanges, mergeNumstat, parseGitStatus, parseStatusBranch, statusSignature,
  type ChangedFile,
} from "../../src/shared/gitStatus.js";

/** -z 输出的速记:每条记录后跟一个 NUL */
const z = (...records: string[]) => records.map((r) => r + "\0").join("");

describe("parseStatusBranch", () => {
  it("带上游 + 领先落后", () => {
    expect(parseStatusBranch("## main...origin/main [ahead 2, behind 3]")).toEqual({
      branch: "main", ahead: 2, behind: 3,
    });
  });

  it("没上游就只有分支名", () => {
    expect(parseStatusBranch("## feat/pill")).toEqual({ branch: "feat/pill", ahead: 0, behind: 0 });
  });

  it("detached HEAD = 没有分支", () => {
    expect(parseStatusBranch("## HEAD (no branch)")).toEqual({ branch: null, ahead: 0, behind: 0 });
  });

  it("空仓库能认出还没有 commit 的那个分支", () => {
    expect(parseStatusBranch("## No commits yet on main")).toEqual({
      branch: "main", ahead: 0, behind: 0,
    });
  });
});

describe("classifyCode", () => {
  it("?? = 未跟踪", () => expect(classifyCode("?", "?")).toBe("untracked"));
  it("UU / AA / DD = 冲突,不误报成新增或删除", () => {
    expect(classifyCode("U", "U")).toBe("conflicted");
    expect(classifyCode("A", "A")).toBe("conflicted");
    expect(classifyCode("D", "D")).toBe("conflicted");
  });
  it("磁盘上删了就报删,盖过索引里记的", () => {
    expect(classifyCode("A", "D")).toBe("deleted");
    expect(classifyCode(" ", "D")).toBe("deleted");
    expect(classifyCode("D", " ")).toBe("deleted");
  });
  it("索引位优先:AM 仍然是新文件", () => {
    expect(classifyCode("A", "M")).toBe("added");
    expect(classifyCode("M", " ")).toBe("modified");
    expect(classifyCode(" ", "M")).toBe("modified");
    expect(classifyCode("R", "M")).toBe("renamed");
  });
});

describe("parseGitStatus", () => {
  it("分支头 + 各档文件", () => {
    const out = parseGitStatus(
      z("## main...origin/main [ahead 1]", "M  src/a.ts", " D src/b.ts", "?? src/c.ts", "UU src/d.ts")
    );
    expect(out.branch).toBe("main");
    expect(out.ahead).toBe(1);
    expect(out.behind).toBe(0);
    expect(out.files).toEqual([
      { path: "src/a.ts", kind: "modified", staged: true },
      { path: "src/b.ts", kind: "deleted", staged: false },
      { path: "src/c.ts", kind: "untracked", staged: false },
      { path: "src/d.ts", kind: "conflicted", staged: true },
    ]);
  });

  it("rename 会吃掉下一条记录当原路径,不把它当成畸形条目", () => {
    const out = parseGitStatus(z("## main", "R  new.ts", "old.ts", "M  after.ts"));
    expect(out.files).toEqual([
      { path: "new.ts", kind: "renamed", staged: true, from: "old.ts" },
      { path: "after.ts", kind: "modified", staged: true },
    ]);
  });

  it("路径里的空格和中文原样保留(-z 不转义)", () => {
    const out = parseGitStatus(z("## main", "?? docs/我的 笔记.md"));
    expect(out.files[0]!.path).toBe("docs/我的 笔记.md");
  });

  it("空输出 = 干净工作区", () => {
    expect(parseGitStatus("")).toEqual({ branch: null, ahead: 0, behind: 0, files: [] });
  });

  it("畸形短记录跳过,不猜", () => {
    expect(parseGitStatus(z("## main", "M", "M  ok.ts")).files).toEqual([
      { path: "ok.ts", kind: "modified", staged: true },
    ]);
  });
});

describe("mergeNumstat", () => {
  const files: ChangedFile[] = [
    { path: "a.ts", kind: "modified", staged: false },
    { path: "b.png", kind: "modified", staged: false },
    { path: "c.ts", kind: "untracked", staged: false },
    { path: "new.ts", kind: "renamed", staged: true, from: "old.ts" },
  ];

  it("贴上行增删;二进制(null)和贴不上的保持没有数字", () => {
    const merged = mergeNumstat(files, [
      { file: "a.ts", insertions: 12, deletions: 3 },
      { file: "b.png", insertions: null, deletions: null },
      { file: "old.ts", insertions: 1, deletions: 1 },
    ]);
    expect(merged[0]).toMatchObject({ insertions: 12, deletions: 3 });
    expect(merged[1]!.insertions).toBeUndefined();
    expect(merged[2]!.insertions).toBeUndefined();
    // rename 的数字挂在原路径上,也要认
    expect(merged[3]).toMatchObject({ insertions: 1, deletions: 1 });
  });
});

describe("countChanges", () => {
  it("按档计数 + 行增删求和", () => {
    const c = countChanges([
      { path: "a", kind: "added", staged: true, insertions: 5, deletions: 0 },
      { path: "b", kind: "modified", staged: false, insertions: 2, deletions: 7 },
      { path: "c", kind: "untracked", staged: false },
    ]);
    expect(c).toMatchObject({ added: 1, modified: 1, untracked: 1, total: 3, insertions: 7, deletions: 7 });
  });
});

describe("statusSignature", () => {
  const base = { branch: "main", ahead: 0, behind: 0 };

  it("文件顺序不影响指纹(git 的输出顺序不是事实的一部分)", () => {
    const a = statusSignature({ ...base, files: [
      { path: "a", kind: "modified", staged: false },
      { path: "b", kind: "added", staged: false },
    ] });
    const b = statusSignature({ ...base, files: [
      { path: "b", kind: "added", staged: false },
      { path: "a", kind: "modified", staged: false },
    ] });
    expect(a).toBe(b);
  });

  it("只改了行数不算新事件:指纹不变", () => {
    const files: ChangedFile[] = [{ path: "a", kind: "modified", staged: false }];
    const more: ChangedFile[] = [{ path: "a", kind: "modified", staged: false, insertions: 99, deletions: 1 }];
    expect(statusSignature({ ...base, files })).toBe(statusSignature({ ...base, files: more }));
  });

  it("换分支 / 多一个文件 / 改了档位都算新事件", () => {
    const files: ChangedFile[] = [{ path: "a", kind: "modified", staged: false }];
    const sig = statusSignature({ ...base, files });
    expect(statusSignature({ ...base, branch: "dev", files })).not.toBe(sig);
    expect(statusSignature({ ...base, files: [...files, { path: "b", kind: "added", staged: false }] })).not.toBe(sig);
    expect(statusSignature({ ...base, files: [{ path: "a", kind: "deleted", staged: false }] })).not.toBe(sig);
  });
});
