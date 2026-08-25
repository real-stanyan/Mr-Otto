import { describe, expect, it } from "vitest";
import { projectMemoryDir, resolveProjectRoot, type GitFsReader } from "../../src/main/projectRoot.js";

/** 假文件系统。值 = null 代表「这是个目录」（readFileSync 读目录会抛，真实现返回 null） */
function fakeFs(files: Record<string, string | null>): GitFsReader {
  return {
    readFile: (p) => (p in files ? (files[p] ?? null) : null),
    exists: (p) => p in files,
  };
}

describe("resolveProjectRoot", () => {
  it("普通仓库：.git 是目录，那一层就是项目根", () => {
    const fs = fakeFs({ "/repo/.git": null, "/repo/src/main/.keep": "" });
    expect(resolveProjectRoot("/repo/src/main", fs)).toBe("/repo");
  });

  it("worktree：.git 是文件且 gitdir 含 /worktrees/，折叠回主仓根", () => {
    const fs = fakeFs({
      "/repo/.claude/worktrees/wt-a/.git": "gitdir: /repo/.git/worktrees/wt-a\n",
    });
    expect(resolveProjectRoot("/repo/.claude/worktrees/wt-a", fs)).toBe("/repo");
  });

  it("worktree 的子目录也折叠回主仓根", () => {
    const fs = fakeFs({
      "/repo/.claude/worktrees/wt-a/.git": "gitdir: /repo/.git/worktrees/wt-a",
    });
    expect(resolveProjectRoot("/repo/.claude/worktrees/wt-a/src", fs)).toBe("/repo");
  });

  it("gitdir 是相对路径时，按 .git 文件所在目录解析", () => {
    const fs = fakeFs({ "/repo/wt/a/.git": "gitdir: ../../.git/worktrees/a" });
    expect(resolveProjectRoot("/repo/wt/a", fs)).toBe("/repo");
  });

  it("submodule：gitdir 含 /modules/，不折叠，就地当独立项目", () => {
    const fs = fakeFs({ "/repo/vendor/lib/.git": "gitdir: /repo/.git/modules/lib" });
    expect(resolveProjectRoot("/repo/vendor/lib", fs)).toBe("/repo/vendor/lib");
  });

  it("gitdir 认不出形状（既非 worktrees 也非 modules）：就地当项目根，不猜", () => {
    const fs = fakeFs({ "/repo/.git": "gitdir: /somewhere/else" });
    expect(resolveProjectRoot("/repo", fs)).toBe("/repo");
  });

  it("爬到文件系统顶都没有 .git：null = 没有项目档", () => {
    const fs = fakeFs({ "/tmp/scratch/a.txt": "" });
    expect(resolveProjectRoot("/tmp/scratch", fs)).toBeNull();
  });

  it("超过最大层数就停，不无限爬", () => {
    const deep = "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o";
    const fs = fakeFs({ "/.git": null });
    expect(resolveProjectRoot(deep, fs)).toBeNull();
  });
});

describe("projectMemoryDir", () => {
  it("同一路径稳定、不同路径不同，且是 16 位十六进制", () => {
    const a = projectMemoryDir("/repo");
    expect(a).toBe(projectMemoryDir("/repo"));
    expect(a).not.toBe(projectMemoryDir("/repo2"));
    expect(a).toMatch(/^memories\/projects\/[0-9a-f]{16}$/);
  });
});
