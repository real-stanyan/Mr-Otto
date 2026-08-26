// branch_checked_out 的第二个发射点（issue #568）：agent 在 bash 里切分支，
// 顶栏 checkout handler（ADR-0093 的唯一发射点）看不见——中间件在 bash 调用
// 前后读 .git/HEAD 比对，变了就补事件。这里测纯逻辑（HEAD 解析/仓库定位）
// 和中间件行为（何时发、何时不发），fs 全部注入假实现。
import { describe, it, expect } from "vitest";
import {
  currentBranch,
  createBranchWatchMiddleware,
  type HeadReader,
} from "../../src/main/branchWatch.js";
import type { ToolCallContext, ToolOutcome } from "../../src/loop/middleware.js";

function readerOf(files: Record<string, string>): HeadReader {
  return { readFile: (p) => files[p] ?? null };
}

const WS = "/repo";

function ctxFor(name: string): ToolCallContext {
  // 中间件只看 call.name；world/tool 不参与（fs 是注入的 reader，不走 world）
  return { call: { id: "t1", name, args: {} }, tool: undefined, world: {} as never, sessionId: "s1" };
}

const OK: ToolOutcome = { status: "ok", output: "" };

describe("currentBranch", () => {
  it("普通仓库：读 <root>/.git/HEAD 的 ref 行", () => {
    const r = readerOf({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    expect(currentBranch(WS, r)).toEqual({ repoDir: "/repo", branch: "main" });
  });

  it("分支名带斜杠整段保留", () => {
    const r = readerOf({ "/repo/.git/HEAD": "ref: refs/heads/feat/btw-side-chat\n" });
    expect(currentBranch(WS, r)?.branch).toBe("feat/btw-side-chat");
  });

  it("detached HEAD（裸 sha）：branch 为 null，但仓库仍认得出", () => {
    const r = readerOf({ "/repo/.git/HEAD": "0123abc0123abc0123abc0123abc0123abc01234\n" });
    expect(currentBranch(WS, r)).toEqual({ repoDir: "/repo", branch: null });
  });

  it("workspace 在仓库子目录：向上爬到 .git", () => {
    const r = readerOf({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    expect(currentBranch("/repo/src/deep", r)).toEqual({ repoDir: "/repo", branch: "main" });
  });

  it("worktree：.git 是文件，HEAD 在 gitdir 指向的目录里", () => {
    const r = readerOf({
      "/wt/.git": "gitdir: /main/.git/worktrees/wt\n",
      "/main/.git/worktrees/wt/HEAD": "ref: refs/heads/feat/x\n",
    });
    expect(currentBranch("/wt", r)).toEqual({ repoDir: "/wt", branch: "feat/x" });
  });

  it("一路没有 .git：null", () => {
    expect(currentBranch("/nowhere", readerOf({}))).toBeNull();
  });
});

describe("createBranchWatchMiddleware", () => {
  it("bash 前后分支不同：发一条，带 from", async () => {
    let head = "ref: refs/heads/main\n";
    const reader: HeadReader = { readFile: (p) => (p === "/repo/.git/HEAD" ? head : null) };
    const switched: { repoDir: string; branch: string; from?: string }[] = [];
    const mw = createBranchWatchMiddleware({ workspace: WS, reader, onSwitch: (s) => switched.push(s) });
    const outcome = await mw(ctxFor("bash"), async () => {
      head = "ref: refs/heads/feat/y\n";
      return OK;
    });
    expect(outcome).toBe(OK);
    expect(switched).toEqual([{ repoDir: "/repo", branch: "feat/y", from: "main" }]);
  });

  it("分支没变：不发", async () => {
    const reader = readerOf({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const switched: unknown[] = [];
    const mw = createBranchWatchMiddleware({ workspace: WS, reader, onSwitch: (s) => switched.push(s) });
    await mw(ctxFor("bash"), async () => OK);
    expect(switched).toEqual([]);
  });

  it("非 bash 工具：不读不发", async () => {
    let reads = 0;
    const reader: HeadReader = {
      readFile: () => {
        reads++;
        return "ref: refs/heads/main\n";
      },
    };
    const switched: unknown[] = [];
    const mw = createBranchWatchMiddleware({ workspace: WS, reader, onSwitch: (s) => switched.push(s) });
    await mw(ctxFor("write_file"), async () => OK);
    expect(reads).toBe(0);
    expect(switched).toEqual([]);
  });

  it("workspace 不在任何仓库：安静放行", async () => {
    const switched: unknown[] = [];
    const mw = createBranchWatchMiddleware({
      workspace: WS,
      reader: readerOf({}),
      onSwitch: (s) => switched.push(s),
    });
    const outcome = await mw(ctxFor("bash"), async () => OK);
    expect(outcome).toBe(OK);
    expect(switched).toEqual([]);
  });

  it("切完是 detached HEAD：发不出名字，不发", async () => {
    let head = "ref: refs/heads/main\n";
    const reader: HeadReader = { readFile: (p) => (p === "/repo/.git/HEAD" ? head : null) };
    const switched: unknown[] = [];
    const mw = createBranchWatchMiddleware({ workspace: WS, reader, onSwitch: (s) => switched.push(s) });
    await mw(ctxFor("bash"), async () => {
      head = "0123abc0123abc0123abc0123abc0123abc01234\n";
      return OK;
    });
    expect(switched).toEqual([]);
  });

  it("detached 切回有名分支：发，但 from 缺席（不编名字，同 ADR-0093）", async () => {
    let head = "0123abc0123abc0123abc0123abc0123abc01234\n";
    const reader: HeadReader = { readFile: (p) => (p === "/repo/.git/HEAD" ? head : null) };
    const switched: { from?: string }[] = [];
    const mw = createBranchWatchMiddleware({ workspace: WS, reader, onSwitch: (s) => switched.push(s) });
    await mw(ctxFor("bash"), async () => {
      head = "ref: refs/heads/main\n";
      return OK;
    });
    expect(switched).toEqual([{ repoDir: "/repo", branch: "main" }]);
    expect(switched[0]!.from).toBeUndefined();
  });

  it("命令失败（status error）也照比：checkout 成功后别的命令挂了，切换仍是事实", async () => {
    let head = "ref: refs/heads/main\n";
    const reader: HeadReader = { readFile: (p) => (p === "/repo/.git/HEAD" ? head : null) };
    const switched: { branch: string }[] = [];
    const mw = createBranchWatchMiddleware({ workspace: WS, reader, onSwitch: (s) => switched.push(s) });
    await mw(ctxFor("bash"), async () => {
      head = "ref: refs/heads/feat/z\n";
      return { status: "error", output: "npm test failed" };
    });
    expect(switched).toEqual([{ repoDir: "/repo", branch: "feat/z", from: "main" }]);
  });
});
