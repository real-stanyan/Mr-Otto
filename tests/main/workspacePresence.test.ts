import { describe, it, expect, vi } from "vitest";
import { createWorkspacePresence, DEBOUNCE_MS, POLL_MS, type WorkspacePresenceDeps } from "../../src/main/workspacePresence.js";

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness(init: { branches?: Record<string, string | null>; gitDir?: string | null } = {}) {
  const branches = init.branches ?? { "/r": "main" };
  const timeouts: { fn: () => void; ms: number }[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const watchers: { dir: string; onFile: (f: string | null) => void; stop: ReturnType<typeof vi.fn> }[] = [];
  const deps: WorkspacePresenceDeps = {
    workspace: vi.fn(async (dir: string) =>
      dir in branches ? { repoKey: "k", branch: branches[dir] ?? null } : null),
    gitDir: vi.fn(async () => (init.gitDir === undefined ? "/r/.git" : init.gitDir)),
    watchDir: vi.fn((dir: string, onFile: (f: string | null) => void) => {
      const stop = vi.fn();
      watchers.push({ dir, onFile, stop });
      return stop;
    }),
    setTimeout: vi.fn((fn: () => void, ms: number) => { const h = { fn, ms }; timeouts.push(h); return h; }),
    clearTimeout: vi.fn((h: unknown) => { const i = timeouts.indexOf(h as never); if (i >= 0) timeouts.splice(i, 1); }),
    setInterval: vi.fn((fn: () => void, ms: number) => { const h = { fn, ms }; intervals.push(h); return h; }),
    clearInterval: vi.fn((h: unknown) => { const i = intervals.indexOf(h as never); if (i >= 0) intervals.splice(i, 1); }),
  };
  const onChange = vi.fn();
  const w = createWorkspacePresence(onChange, deps);
  const fireTimeouts = () => { const due = timeouts.splice(0); for (const t of due) t.fn(); };
  return { w, deps, onChange, branches, timeouts, intervals, watchers, fireTimeouts };
}

describe("workspacePresence", () => {
  it("setRepoDir:立刻算一次并广播,然后盯 git 目录 + 起慢轮询", async () => {
    const h = harness();
    h.w.setRepoDir("/r");
    await flush();
    expect(h.onChange).toHaveBeenLastCalledWith({ repoKey: "k", branch: "main" });
    expect(h.watchers).toHaveLength(1);
    expect(h.watchers[0]!.dir).toBe("/r/.git");
    expect(h.intervals.map((i) => i.ms)).toEqual([POLL_MS]);
  });

  it("HEAD 变了 → 去抖后重算;别的文件变了不理", async () => {
    const h = harness();
    h.w.setRepoDir("/r");
    await flush();
    h.branches["/r"] = "feat";
    h.watchers[0]!.onFile("index");
    expect(h.timeouts).toHaveLength(0);
    h.watchers[0]!.onFile("HEAD.lock");
    h.watchers[0]!.onFile("HEAD");
    h.watchers[0]!.onFile("HEAD");
    expect(h.timeouts).toHaveLength(1); // 三次事件合成一个去抖
    expect(h.timeouts[0]!.ms).toBe(DEBOUNCE_MS);
    h.fireTimeouts();
    await flush();
    expect(h.onChange).toHaveBeenLastCalledWith({ repoKey: "k", branch: "feat" });
  });

  it("换目录:停掉旧 watcher/轮询,旧目录迟到的结果作废", async () => {
    const h = harness({ branches: { "/r": "main", "/s": "other" } });
    h.w.setRepoDir("/r");
    await flush();
    const oldStop = h.watchers[0]!.stop;
    h.w.setRepoDir("/s");
    await flush();
    expect(oldStop).toHaveBeenCalled();
    expect(h.intervals).toHaveLength(1);
    expect(h.onChange).toHaveBeenLastCalledWith({ repoKey: "k", branch: "other" });
  });

  it("setRepoDir(null):广播 null,不盯任何东西;同目录重复报是空操作", async () => {
    const h = harness();
    h.w.setRepoDir("/r");
    await flush();
    const calls = h.onChange.mock.calls.length;
    h.w.setRepoDir("/r");
    await flush();
    expect(h.onChange).toHaveBeenCalledTimes(calls);
    h.w.setRepoDir(null);
    expect(h.onChange).toHaveBeenLastCalledWith(null);
    expect(h.watchers[0]!.stop).toHaveBeenCalled();
  });

  it("不是仓库:广播 null,gitDir 为 null 就不 watch", async () => {
    const h = harness({ branches: {}, gitDir: null });
    h.w.setRepoDir("/nope");
    await flush();
    expect(h.onChange).toHaveBeenLastCalledWith(null);
    expect(h.watchers).toHaveLength(0);
  });

  it("watchDir 抛(目录盯不住)→ 不炸,轮询仍在", async () => {
    const h = harness();
    (h.deps.watchDir as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("EPERM"); });
    h.w.setRepoDir("/r");
    await flush();
    expect(h.intervals).toHaveLength(1);
  });
});
