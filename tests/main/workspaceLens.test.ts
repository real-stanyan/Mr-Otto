import { describe, expect, it } from "vitest";
import { createWorkspaceLens, localWorkspaceLens, withDefaultFold } from "../../src/main/workspaceLens.js";
import type { GitFsReader } from "../../src/main/projectRoot.js";

/** 假文件系统 + 读次数计数（记忆化生效与否只能这么看）。
    值 = null 代表「这是个目录」（readFileSync 读目录会抛，真实现返回 null） */
function countingFs(files: Record<string, string | null>) {
  let reads = 0;
  const reader: GitFsReader = {
    readFile: (p) => {
      reads++;
      return p in files ? (files[p] ?? null) : null;
    },
    exists: (p) => p in files,
  };
  return { reader, reads: () => reads };
}

const WORKTREE = {
  "/repo/wt/a/.git": "gitdir: /repo/.git/worktrees/a\n",
  "/repo/.git/worktrees/a/HEAD": "ref: refs/heads/otto/friends-a29018\n",
};

describe("localWorkspaceLens", () => {
  it("什么都不折叠：就地当项目、不是副本（= 引入镜头之前的岛行为）", () => {
    expect(localWorkspaceLens("/repo/wt/a")).toEqual({ projectRoot: "/repo/wt/a", branch: null });
  });
});

describe("createWorkspaceLens", () => {
  it("worktree 折回主仓，分支跟着出来", () => {
    const fs = countingFs(WORKTREE);
    const lens = createWorkspaceLens({ reader: fs.reader });
    expect(lens("/repo/wt/a")).toEqual({
      projectRoot: "/repo",
      branch: "otto/friends-a29018",
    });
  });

  it("一路没有 .git 的文件夹：就地当项目 —— 岛总要有个组可以归", () => {
    // 记忆那层对这种情况回 null（「没有项目档」），岛不能照抄：null 不能当分组键
    const fs = countingFs({});
    const lens = createWorkspaceLens({ reader: fs.reader });
    expect(lens("/tmp/scratch")).toEqual({ projectRoot: "/tmp/scratch", branch: null });
  });

  it("TTL 内重复问同一个 workspace 不再读盘（pushFleet 跟着每条事件跑）", () => {
    const fs = countingFs(WORKTREE);
    let t = 0;
    const lens = createWorkspaceLens({ reader: fs.reader, now: () => t, ttlMs: 30_000 });

    lens("/repo/wt/a");
    const after1 = fs.reads();
    expect(after1).toBeGreaterThan(0);

    t = 29_999;
    lens("/repo/wt/a");
    expect(fs.reads()).toBe(after1);
  });

  it("TTL 过了重新读：分支会被改名（自动标题出来时），缓存不能永远不失效", () => {
    const files: Record<string, string | null> = { ...WORKTREE };
    const fs = countingFs(files);
    let t = 0;
    const lens = createWorkspaceLens({ reader: fs.reader, now: () => t, ttlMs: 30_000 });

    expect(lens("/repo/wt/a").branch).toBe("otto/friends-a29018");
    files["/repo/.git/worktrees/a/HEAD"] = "ref: refs/heads/otto/test-friends-a29018\n";
    t = 30_001;
    expect(lens("/repo/wt/a").branch).toBe("otto/test-friends-a29018");
  });

  it("按 workspace 分别缓存：另一个副本不吃前一个的答案", () => {
    const fs = countingFs({
      ...WORKTREE,
      "/repo/wt/b/.git": "gitdir: /repo/.git/worktrees/b",
      "/repo/.git/worktrees/b/HEAD": "ref: refs/heads/otto/tidy-7f10ab",
    });
    const lens = createWorkspaceLens({ reader: fs.reader });
    expect(lens("/repo/wt/a").branch).toBe("otto/friends-a29018");
    expect(lens("/repo/wt/b").branch).toBe("otto/tidy-7f10ab");
    // 同项目 → 同一个分组键，这正是"折回项目"要的结果
    expect(lens("/repo/wt/a").projectRoot).toBe(lens("/repo/wt/b").projectRoot);
  });
});

const DEF = "/docs/Mr Otto/Default";

describe("withDefaultFold（#851）", () => {
  it("Default 子目录折回 Default 根：岛上所有任务一组", () => {
    const lens = withDefaultFold(localWorkspaceLens, DEF);
    expect(lens(`${DEF}/s-20260903111128-a1b2c3d4`)).toEqual({ projectRoot: DEF, branch: null });
    expect(lens(DEF)).toEqual({ projectRoot: DEF, branch: null });
  });
  it("别的路径透传给内层镜头", () => {
    const inner = (ws: string) => ({ projectRoot: `root-of:${ws}`, branch: "b" });
    expect(withDefaultFold(inner, DEF)("/p/x")).toEqual({ projectRoot: "root-of:/p/x", branch: "b" });
  });
});
