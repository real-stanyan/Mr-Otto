// 工作区互斥的可执行版（issue #620，ADR-0151）。
//
// 钉的是「什么时候**不**拦」——拦错了比不拦更容易被发现（用户立刻发不出消息），
// 而漏拦是安静的：两只水獭在同一个文件夹里互相踩，症状要等到改动消失才浮出来。
// 所以三条豁免（同家族 / 闲着 / 不同目录）每条都要有断言压着。

import { describe, it, expect } from "vitest";
import {
  turnConflict,
  familyRootOf,
  conflictMessage,
  type LiveSession,
} from "../../src/shared/workspaceExclusion.js";

const S = (
  sessionId: string,
  workspace: string,
  running: boolean,
  familyRoot = sessionId
): LiveSession => ({ sessionId, workspace, familyRoot, running });

describe("turnConflict：同一文件夹同一时刻只跑一条 turn（issue #620）", () => {
  it("别的家族正在同一个文件夹里跑 → 冲突", () => {
    const c = turnConflict({ sessionId: "b", workspace: "/w", familyRoot: "b" }, [
      S("a", "/w", true),
      S("b", "/w", false),
    ]);
    expect(c).toEqual({ heldBy: "a", workspace: "/w" });
  });

  it("对方闲着 → 不拦（闲着不会执行任何命令）", () => {
    const c = turnConflict({ sessionId: "b", workspace: "/w", familyRoot: "b" }, [
      S("a", "/w", false),
      S("b", "/w", false),
    ]);
    expect(c).toBeNull();
  });

  it("不同文件夹 → 不拦（各自围栏；不同 worktree 也落这一档）", () => {
    const c = turnConflict({ sessionId: "b", workspace: "/w2", familyRoot: "b" }, [
      S("a", "/w1", true),
      S("b", "/w2", false),
    ]);
    expect(c).toBeNull();
  });

  it("同家族（子会话 / SideChat）→ 不拦，哪怕父 turn 正在跑", () => {
    // SideChat 就是拿父会话的 workspace 开的；子会话在父 turn 跑着的时候跑
    const c = turnConflict({ sessionId: "child", workspace: "/w", familyRoot: "a" }, [
      S("a", "/w", true, "a"),
      S("child", "/w", false, "a"),
    ]);
    expect(c).toBeNull();
  });

  it("自己不跟自己撞（重入的那一刻自己可能已经在表里）", () => {
    const c = turnConflict({ sessionId: "a", workspace: "/w", familyRoot: "a" }, [S("a", "/w", true)]);
    expect(c).toBeNull();
  });

  it("多条候选里只报第一条占着的", () => {
    const c = turnConflict({ sessionId: "c", workspace: "/w", familyRoot: "c" }, [
      S("idle", "/w", false),
      S("busy", "/w", true),
      S("elsewhere", "/other", true),
    ]);
    expect(c?.heldBy).toBe("busy");
  });
});

describe("familyRootOf：顺着 spawnedFrom 爬到顶", () => {
  const chain: Record<string, string | null> = { grandchild: "child", child: "root", root: null };

  it("多层子会话爬到同一个根", () => {
    expect(familyRootOf("grandchild", (id) => chain[id])).toBe("root");
    expect(familyRootOf("child", (id) => chain[id])).toBe("root");
    expect(familyRootOf("root", (id) => chain[id])).toBe("root");
  });

  it("父会话已 purge（查不到）→ 以当前这层为根，与独立会话同款", () => {
    expect(familyRootOf("orphan", () => undefined)).toBe("orphan");
  });

  it("链上有环也停得下来（日志是外部输入，不能假设它干净）", () => {
    const cyclic: Record<string, string> = { a: "b", b: "a" };
    expect(familyRootOf("a", (id) => cyclic[id])).toBe("b");
  });
});

describe("conflictMessage", () => {
  it("说清谁占着、撞的哪个目录、怎么继续", () => {
    const m = conflictMessage({ heldBy: "s-123", workspace: "/Users/x/repo" });
    expect(m).toContain("s-123");
    expect(m).toContain("/Users/x/repo");
    // 修法必须在场：只说"不行"的错误信息等于把人卡死
    expect(m).toContain("worktree");
  });
});
