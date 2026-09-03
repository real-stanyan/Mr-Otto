import { describe, expect, it } from "vitest";
import {
  isPathScopeId, normalizeRemoteUrl, projectMemoryDir, projectScopeId, readOriginUrl,
  resolveProjectRoot, resolveProjectScope, resolveWorkspaceOrigin, type GitFsReader,
} from "../../src/main/projectRoot.js";

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

  // 返回值会被 projectMemoryDir 哈希成目录名：不归一化的话 "/repo" 和 "/repo/"
  // 是两个哈希 = 同一个仓库分裂出两份项目记忆
  it("尾斜杠/冗余段归一化：同一个仓库的几种写法解析成同一个根", () => {
    const fs = fakeFs({ "/repo/.git": null });
    expect(resolveProjectRoot("/repo/", fs)).toBe("/repo");
    expect(resolveProjectRoot("/repo//", fs)).toBe("/repo");
    expect(resolveProjectRoot("/repo/src/..", fs)).toBe("/repo");
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

describe("resolveWorkspaceOrigin", () => {
  it("worktree：一次爬升同时得出项目根和当前分支（读 HEAD，不起 git 子进程）", () => {
    const fs = fakeFs({
      "/repo/wt/a/.git": "gitdir: /repo/.git/worktrees/a\n",
      "/repo/.git/worktrees/a/HEAD": "ref: refs/heads/otto/friends-a29018\n",
    });
    expect(resolveWorkspaceOrigin("/repo/wt/a", fs)).toEqual({
      root: "/repo",
      branch: "otto/friends-a29018",
    });
  });

  it("普通仓库不是副本：branch 为 null（没有「副本分支」这回事）", () => {
    const fs = fakeFs({ "/repo/.git": null });
    expect(resolveWorkspaceOrigin("/repo/src", fs)).toEqual({ root: "/repo", branch: null });
  });

  it("游离 HEAD（裸 sha）：branch 为 null —— 没有名字可显示，编一个不如不显示", () => {
    const fs = fakeFs({
      "/repo/wt/a/.git": "gitdir: /repo/.git/worktrees/a",
      "/repo/.git/worktrees/a/HEAD": "9f8b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3\n",
    });
    expect(resolveWorkspaceOrigin("/repo/wt/a", fs).branch).toBeNull();
  });

  it("HEAD 读不到（权限错/文件没了）：root 照常，branch 退成 null", () => {
    const fs = fakeFs({ "/repo/wt/a/.git": "gitdir: /repo/.git/worktrees/a" });
    expect(resolveWorkspaceOrigin("/repo/wt/a", fs)).toEqual({ root: "/repo", branch: null });
  });

  it("submodule 不折叠，也没有副本分支", () => {
    const fs = fakeFs({ "/parent/sub/.git": "gitdir: /parent/.git/modules/sub" });
    expect(resolveWorkspaceOrigin("/parent/sub", fs)).toEqual({ root: "/parent/sub", branch: null });
  });

  it("一路没有 .git：两个字段都是 null", () => {
    expect(resolveWorkspaceOrigin("/nowhere", fakeFs({}))).toEqual({ root: null, branch: null });
  });

  // resolveProjectRoot 现在是 resolveWorkspaceOrigin 的投影 —— 两者若给出不同答案,
  // 「worktree 折回主仓」这件事会在项目记忆和灵动岛上分裂成两个结论
  it("resolveProjectRoot 与它同源", () => {
    const fs = fakeFs({
      "/repo/wt/a/.git": "gitdir: /repo/.git/worktrees/a",
      "/repo/.git/worktrees/a/HEAD": "ref: refs/heads/x",
    });
    expect(resolveProjectRoot("/repo/wt/a", fs)).toBe(resolveWorkspaceOrigin("/repo/wt/a", fs).root);
  });
});

// ── 作用域键（#886）─────────────────────────────────────────────────────────
// 记忆的键从「本机路径」换成「remote URL」，项目档才跨得了机器。
// 归一化的每一条都对应一种「同一个仓库在两台机器上写出两把键」的真实写法。

describe("normalizeRemoteUrl", () => {
  const same = "github.com/real-stanyan/Mr-Otto";
  it("四种写法归一到同一把键（同一个仓库不该有两把键）", () => {
    expect(normalizeRemoteUrl("https://github.com/real-stanyan/Mr-Otto.git")).toBe(same);
    expect(normalizeRemoteUrl("https://github.com/real-stanyan/Mr-Otto")).toBe(same);
    expect(normalizeRemoteUrl("git@github.com:real-stanyan/Mr-Otto.git")).toBe(same);
    expect(normalizeRemoteUrl("ssh://git@github.com:22/real-stanyan/Mr-Otto.git")).toBe(same);
  });

  it("凭据不进键：URL 里的 token 每台机器都不一样，留着就等于没归一化", () => {
    expect(normalizeRemoteUrl("https://x-access-token:ghp_secret@github.com/real-stanyan/Mr-Otto.git")).toBe(same);
  });

  it("host 小写、路径原样：DNS 不区分大小写，仓库路径可能区分", () => {
    expect(normalizeRemoteUrl("https://GitHub.COM/real-stanyan/Mr-Otto")).toBe(same);
    expect(normalizeRemoteUrl("https://github.com/real-stanyan/mr-otto")).not.toBe(same);
  });

  it("本地路径 / file:// 没有跨机身份 → null（调用方退回路径作用域）", () => {
    expect(normalizeRemoteUrl("/srv/git/repo.git")).toBeNull();
    expect(normalizeRemoteUrl("../sibling")).toBeNull();
    expect(normalizeRemoteUrl("file:///srv/git/repo.git")).toBeNull();
    expect(normalizeRemoteUrl("")).toBeNull();
    expect(normalizeRemoteUrl("https://github.com/")).toBeNull(); // 只有 host 没有仓
  });
});

describe("readOriginUrl", () => {
  const config = (body: string) => ({ "/repo/.git/config": body });
  it("只认 origin，取最后一次赋值（git 单值 key 的语义）", () => {
    const fs = fakeFs(config(
      '[remote "upstream"]\n\turl = https://github.com/up/x.git\n' +
      '[remote "origin"]\n\turl = https://github.com/a/old.git\n\turl = https://github.com/a/b.git\n'
    ));
    expect(readOriginUrl("/repo", fs)).toBe("https://github.com/a/b.git");
  });

  it("没有 origin / 读不到 config（submodule 的 .git 是文件）→ null", () => {
    expect(readOriginUrl("/repo", fakeFs(config('[core]\n\tbare = false\n')))).toBeNull();
    expect(readOriginUrl("/repo", fakeFs({}))).toBeNull();
  });
});

describe("projectScopeId / resolveProjectScope", () => {
  it("有 remote：键是 remote，root 仍是本机路径——两者故意不同", () => {
    const fs = fakeFs({
      "/repo/.git": null,
      "/repo/.git/config": '[remote "origin"]\n\turl = git@github.com:a/b.git\n',
      "/repo/src/.keep": "",
    });
    expect(resolveProjectScope("/repo/src", fs)).toEqual({ id: "github.com/a/b", root: "/repo" });
  });

  it("worktree 折回主仓之后再取 remote —— 副本和主仓共用同一份项目记忆", () => {
    const fs = fakeFs({
      "/repo/wt/a/.git": "gitdir: /repo/.git/worktrees/a",
      "/repo/.git/worktrees/a/HEAD": "ref: refs/heads/x",
      "/repo/.git/config": '[remote "origin"]\n\turl = git@github.com:a/b.git\n',
    });
    expect(resolveProjectScope("/repo/wt/a", fs)?.id).toBe("github.com/a/b");
  });

  it("没有 remote 的仓：键退回路径本身，等于保持改动前的行为", () => {
    const fs = fakeFs({ "/repo/.git": null });
    expect(projectScopeId("/repo", fs)).toBe("/repo");
    expect(resolveProjectScope("/repo", fs)).toEqual({ id: "/repo", root: "/repo" });
  });

  it("不在任何仓里 → null", () => {
    expect(resolveProjectScope("/tmp/scratch", fakeFs({}))).toBeNull();
  });
});

describe("isPathScopeId", () => {
  // 迁移和「旧日志里那个值」两处都靠这一句区分新旧键
  it("绝对路径是旧键，host/path 是新键", () => {
    expect(isPathScopeId("/Users/x/repo")).toBe(true);
    expect(isPathScopeId("C:\\src\\repo")).toBe(true);
    expect(isPathScopeId("github.com/a/b")).toBe(false);
  });
});
