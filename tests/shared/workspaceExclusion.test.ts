// 工作区互斥的可执行版（issue #620，ADR-0152）。
//
// 钉的是「什么时候**不**拦」——拦错了比不拦更容易被发现（用户立刻发不出消息），
// 而漏拦是安静的：两只水獭在同一个文件夹里互相踩，症状要等到改动消失才浮出来。
// 所以三条豁免（同家族 / 闲着 / 不同目录）每条都要有断言压着。

import { describe, it, expect } from "vitest";
import {
  turnConflict,
  familyRootOf,
  conflictMessage,
  EXCLUSION_WHY,
  EXCLUSION_WAY_OUT,
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
    expect(c).toEqual({ heldBy: "a", heldByTitle: null, workspace: "/w" });
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
  it("冲突里带上占用会话的标题，供提示语点名（issue #653）", () => {
    const c = turnConflict(
      { sessionId: "b", workspace: "/w", familyRoot: "b" },
      [{ ...S("a", "/w", true), title: "给客户写提案" }]
    );
    expect(c?.heldByTitle).toBe("给客户写提案");
  });

  it("还没命名的会话 → 标题为 null，不编造", () => {
    const c = turnConflict({ sessionId: "b", workspace: "/w", familyRoot: "b" }, [S("a", "/w", true)]);
    expect(c?.heldByTitle).toBeNull();
  });
});

describe("conflictMessage（issue #653：这句话现在只有非 git 用户会看到）", () => {
  const m = conflictMessage({ heldBy: "s-123", workspace: "/Users/x/文案" });

  it("说清谁占着、撞的哪个目录", () => {
    expect(m).toContain("s-123");
    expect(m).toContain("/Users/x/文案");
  });

  it("拿得到标题就点名 —— 会话 id 对用户是一串没意义的十六进制", () => {
    const named = conflictMessage({
      heldBy: "s-123",
      heldByTitle: "给客户写提案",
      workspace: "/Users/x/文案",
    });
    expect(named).toContain("给客户写提案");
    expect(named).toContain("s-123"); // id 不丢：诊断时还要用
  });

  it("说清这是设计不是故障 —— 否则用户只会觉得第二只水獭坏了", () => {
    expect(m).toContain(EXCLUSION_WHY);
  });

  it("给出真正的出路：换一个文件夹", () => {
    expect(m).toContain(EXCLUSION_WAY_OUT);
    expect(m).toContain("换一个文件夹");
  });

  it("不提 git / worktree —— ADR-0157 之后 git 文件夹各自拿副本、根本走不到这条提示，", () => {
    // 会走到这里的只剩非 git 文件夹（白领的一堆文案）。对着他们说 worktree 是天书。
    expect(m).not.toMatch(/worktree|git/i);
  });
});
