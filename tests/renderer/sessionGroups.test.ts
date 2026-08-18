import { describe, it, expect } from "vitest";
import { folderName, groupSessionsByWorkspace } from "../../src/renderer/src/sessionGroups.js";
import type { SessionSummary } from "../../src/shared/shellBridge.js";

/** 造会话的速记:分组只关心 workspace 和 lastTs */
const s = (sessionId: string, workspace: string | null, lastTs: number): SessionSummary => ({
  sessionId, workspace, lastTs, startedTs: lastTs - 1, events: 1, title: null,
});

describe("folderName", () => {
  it("取路径末段", () => {
    expect(folderName("/Users/stan/Github/Otter")).toBe("Otter");
  });
  it("尾随 / 不算一段", () => {
    expect(folderName("/Users/stan/Github/Otter/")).toBe("Otter");
  });
  it("根目录退回原串,不返回空名", () => {
    expect(folderName("/")).toBe("/");
  });
});

describe("groupSessionsByWorkspace", () => {
  it("同目录归一组,组内按 lastTs 倒序", () => {
    const g = groupSessionsByWorkspace([s("a", "/p/x", 100), s("b", "/p/x", 300), s("c", "/p/x", 200)]);
    expect(g).toHaveLength(1);
    expect(g[0]!.sessions.map((x) => x.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("组序 = 组内最近会话时间倒序", () => {
    const g = groupSessionsByWorkspace([s("a", "/p/old", 100), s("b", "/p/new", 900), s("c", "/p/old", 50)]);
    expect(g.map((x) => x.workspace)).toEqual(["/p/new", "/p/old"]);
    expect(g[0]!.lastTs).toBe(900);
    expect(g[1]!.lastTs).toBe(100); // 组的时间戳取组内最大,不是第一个遇到的
  });

  it("workspace 为 null 的史前会话直接丢弃,不伪造未知组", () => {
    expect(groupSessionsByWorkspace([s("a", null, 100)])).toEqual([]);
  });

  it("label 是文件夹名,workspace 仍是全路径", () => {
    const g = groupSessionsByWorkspace([s("a", "/Users/stan/Github/Otter", 1)]);
    expect(g[0]!.label).toBe("Otter");
    expect(g[0]!.workspace).toBe("/Users/stan/Github/Otter");
  });

  it("空输入 = 空数组", () => {
    expect(groupSessionsByWorkspace([])).toEqual([]);
  });

  it("不改动传入数组的顺序(纯函数)", () => {
    const input = [s("a", "/p/x", 100), s("b", "/p/x", 300)];
    groupSessionsByWorkspace(input);
    expect(input.map((x) => x.sessionId)).toEqual(["a", "b"]);
  });
});
