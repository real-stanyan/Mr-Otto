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
        if (args[0] === "symbolic-ref") throw Object.assign(new Error("fail"), { stderr: "" });
        return { stdout: LOG_REC };
      },
    }));
    const r = await svc.log("/repo");
    expect(r).toEqual({
      ok: true, head: "aaa", spineBranch: "main",
      commits: [{ hash: "aaa", parents: [], refs: [{ name: "main", type: "branch" }], author: "stan", timestamp: 1755500000, subject: "feat: x" }],
    });
  });

  it("origin/HEAD 指哪根就用哪根当主脊,前缀剥掉", async () => {
    const svc = createGitGraphService(fake({
      onExec: async (args) => {
        if (args[0] === "rev-parse") return { stdout: "aaa\n" };
        if (args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
        return { stdout: LOG_REC };
      },
    }));
    const r = await svc.log("/repo");
    expect(r).toMatchObject({ ok: true, spineBranch: "main" });
  });

  it("symbolic-ref 失败(没设过 origin/HEAD)不算错误,退回名字兜底", async () => {
    const calls: string[][] = [];
    const svc = createGitGraphService(fake({
      onExec: async (args) => {
        calls.push(args);
        if (args[0] === "rev-parse") return { stdout: "aaa\n" };
        if (args[0] === "symbolic-ref") throw Object.assign(new Error("fail"), { stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref" });
        return { stdout: LOG_REC };
      },
    }));
    const r = await svc.log("/repo");
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ spineBranch: "main" }); // log 里的 main 分支兜底
    expect(calls.some((a) => a[0] === "symbolic-ref")).toBe(true);
  });

  /** 抓 log 命令里的 -n 值:limit 透传/钳位都看它 */
  const logLimitOf = async (limit?: number): Promise<string> => {
    let n = "";
    const svc = createGitGraphService(fake({
      onExec: async (args) => {
        if (args[0] === "log") n = args[args.indexOf("-n") + 1]!;
        if (args[0] === "rev-parse") return { stdout: "aaa\n" };
        if (args[0] === "symbolic-ref") throw Object.assign(new Error("fail"), { stderr: "" });
        return { stdout: LOG_REC };
      },
    }));
    await svc.log("/repo", limit);
    return n;
  };

  it("limit 缺省 300,给了就透传", async () => {
    expect(await logLimitOf()).toBe("300");
    expect(await logLimitOf(900)).toBe("900");
  });

  it("limit 钳在天花板内,脏数字回落 300(不把它们拼进命令行)", async () => {
    expect(await logLimitOf(99999)).toBe("5000");
    expect(await logLimitOf(0)).toBe("300");
    expect(await logLimitOf(-5)).toBe("300");
    expect(await logLimitOf(Number.NaN)).toBe("300");
    expect(await logLimitOf(300.7)).toBe("300"); // 取整,不给 git 小数
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
    expect(r).toEqual({ ok: true, head: null, commits: [], spineBranch: null });
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

describe("branches", () => {
  it("解析列表并挑出当前分支", async () => {
    const svc = createGitGraphService(fake({
      onExec: async () => ({ stdout: " \x00feat/x\n*\x00main\n \x00release\n" }),
    }));
    expect(await svc.branches("/repo")).toEqual({
      ok: true,
      current: "main",
      branches: [
        { name: "feat/x", current: false },
        { name: "main", current: true },
        { name: "release", current: false },
      ],
    });
  });

  it("detached HEAD:没有 current,列表照给", async () => {
    const svc = createGitGraphService(fake({ onExec: async () => ({ stdout: " \x00main\n" }) }));
    expect(await svc.branches("/repo")).toEqual({
      ok: true, current: null, branches: [{ name: "main", current: false }],
    });
  });

  it("非 git 目录:按 kind 降级", async () => {
    const svc = createGitGraphService(fake({
      onExec: async () => { throw Object.assign(new Error("x"), { stderr: "fatal: not a git repository" }); },
    }));
    expect(await svc.branches("/repo")).toMatchObject({ ok: false, kind: "no-repo" });
  });
});

describe("checkout", () => {
  it("成功:回报落地的分支名", async () => {
    let seen: string[] = [];
    const svc = createGitGraphService(fake({
      onExec: async (args) => { seen = args; return { stdout: "" }; },
    }));
    expect(await svc.checkout("/repo", "feat/x")).toEqual({ ok: true, branch: "feat/x" });
    // `--` 终止选项解析:分支名永远不会被 git 当成选项读
    expect(seen).toEqual(["checkout", "feat/x", "--"]);
  });

  it("工作区脏:单独的 dirty kind,不混进 git-error", async () => {
    const svc = createGitGraphService(fake({
      onExec: async () => {
        throw Object.assign(new Error("x"), {
          stderr: "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts",
        });
      },
    }));
    expect(await svc.checkout("/repo", "main")).toMatchObject({ ok: false, kind: "dirty" });
  });

  it("`-` 开头的分支名直接拒,不进 exec", async () => {
    let called = false;
    const svc = createGitGraphService(fake({
      onExec: async () => { called = true; return { stdout: "" }; },
    }));
    expect(await svc.checkout("/repo", "--force")).toMatchObject({ ok: false, kind: "git-error" });
    expect(called).toBe(false);
  });

  it("目录不存在:no-repo", async () => {
    const svc = createGitGraphService(fake({ dirExists: false }));
    expect(await svc.checkout("/gone", "main")).toMatchObject({ ok: false, kind: "no-repo" });
  });
});
