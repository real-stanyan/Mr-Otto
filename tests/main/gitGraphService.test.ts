import { describe, expect, it } from "vitest";
import { createGitGraphService, type GitGraphDeps } from "../../src/main/gitGraphService.js";

/** 假依赖:按命令前缀路由 stdout;dirExists 缺省 true */
const fake = (init: {
  onExec?: (args: string[]) => Promise<{ stdout: string }>;
  dirExists?: boolean;
}): GitGraphDeps => ({
  execGit: init.onExec ?? (async () => ({ stdout: "" })),
  dirExists: () => init.dirExists ?? true,
});

const LOG_REC = `\x01aaa\x00\x00main\x00stan\x001755500000\x00feat: x\n`;

describe("log", () => {
  it("组合 rev-parse HEAD + log 输出", async () => {
    const svc = createGitGraphService(fake({
      onExec: async (args) => {
        if (args[0] === "rev-parse") return { stdout: "aaa\n" };
        return { stdout: LOG_REC };
      },
    }));
    const r = await svc.log("/repo");
    expect(r).toEqual({
      ok: true, head: "aaa",
      commits: [{ hash: "aaa", parents: [], refs: [{ name: "main", type: "branch" }], author: "stan", timestamp: 1755500000, subject: "feat: x" }],
    });
  });

  it("目录不存在:no-repo,不进 exec", async () => {
    const svc = createGitGraphService(fake({ dirExists: false }));
    const r = await svc.log("/gone");
    expect(r).toEqual({ ok: false, kind: "no-repo", detail: "目录不存在: /gone" });
  });

  it("空仓库(log 报 does not have any commits):ok + 空列表", async () => {
    const svc = createGitGraphService(fake({
      onExec: async (args) => {
        if (args[0] === "rev-parse") throw Object.assign(new Error("fail"), { stderr: "fatal: ambiguous argument 'HEAD'" });
        throw Object.assign(new Error("fail"), { stderr: "fatal: your current branch 'main' does not have any commits yet" });
      },
    }));
    const r = await svc.log("/empty");
    expect(r).toEqual({ ok: true, head: null, commits: [] });
  });

  it("非 git 仓库:no-repo", async () => {
    const svc = createGitGraphService(fake({
      onExec: async () => { throw Object.assign(new Error("fail"), { stderr: "fatal: not a git repository" }); },
    }));
    const r = await svc.log("/not-repo");
    expect(r).toMatchObject({ ok: false, kind: "no-repo" });
  });

  it("没装 git(ENOENT):git-missing", async () => {
    const svc = createGitGraphService(fake({
      onExec: async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); },
    }));
    const r = await svc.log("/repo");
    expect(r).toMatchObject({ ok: false, kind: "git-missing" });
  });
});

describe("commit", () => {
  it("组合 show --no-patch 元数据 + numstat", async () => {
    const svc = createGitGraphService(fake({
      onExec: async (args) => {
        if (args.includes("--no-patch")) return { stdout: `abc123\x00stan\x00s@x.com\x001755500000\x00feat: x\n\n正文\n` };
        return { stdout: "3\t1\tsrc/a.ts\n" };
      },
    }));
    const r = await svc.commit("/repo", "abc123");
    expect(r).toEqual({
      ok: true,
      detail: {
        hash: "abc123", author: "stan", email: "s@x.com", timestamp: 1755500000,
        body: "feat: x\n\n正文",
        files: [{ file: "src/a.ts", insertions: 3, deletions: 1 }],
      },
    });
  });

  it("非法 hash 直接拒,不进 exec", async () => {
    let called = false;
    const svc = createGitGraphService(fake({
      onExec: async () => { called = true; return { stdout: "" }; },
    }));
    const r = await svc.commit("/repo", "aaa; rm -rf /");
    expect(r).toMatchObject({ ok: false, kind: "git-error" });
    expect(called).toBe(false);
  });

  it("目录不存在:no-repo", async () => {
    const svc = createGitGraphService(fake({ dirExists: false }));
    expect(await svc.commit("/gone", "abc123")).toEqual({ ok: false, kind: "no-repo", detail: "目录不存在: /gone" });
  });
});
