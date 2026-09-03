import { describe, it, expect } from "vitest";
import {
  archivedTaskSessions,
  folderName,
  groupArchivedByWorkspace,
  groupSessionsByWorkspace,
  groupTasksByTopic,
  partitionShared,
  taskSessions,
} from "../../src/renderer/src/sessionGroups.js";
import type { SessionSummary } from "../../src/shared/shellBridge.js";

/** 造会话的速记:分组只关心 workspace / lastTs / spawnedFrom */
const s = (
  sessionId: string,
  workspace: string | null,
  lastTs: number,
  spawnedFrom: string | null = null,
  startedTs: number = lastTs - 1,
): SessionSummary => ({
  sessionId, workspace, lastTs, startedTs, events: 1, title: null, spawnedFrom, archived: false,
  sharedWith: [], topic: null, projectRoot: null,
});

/** 独立副本上的会话（ADR-0157）：workspace 是 worktree 路径，projectRoot 是用户选的项目 */
const iso = (sessionId: string, projectRoot: string, dir: string, lastTs: number): SessionSummary => ({
  ...s(sessionId, dir, lastTs),
  projectRoot,
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
  it("Windows 盘符路径按反斜杠切(dist:win 是真目标)", () => {
    expect(folderName("C:\\Users\\Grant\\OneDrive\\Documents\\Mr Otto")).toBe("Mr Otto");
  });
  it("Windows 混合分隔符 + 尾随反斜杠", () => {
    expect(folderName("C:/Users/Grant\\Github\\Mr_Otto\\")).toBe("Mr_Otto");
  });
  it("UNC 路径也认", () => {
    expect(folderName("\\\\server\\share\\proj")).toBe("proj");
  });
  it("POSIX 路径里的反斜杠是文件名的一部分,不当分隔符", () => {
    expect(folderName("/Users/stan/we\\ird")).toBe("we\\ird");
  });
});

describe("groupSessionsByWorkspace", () => {
  it("同目录归一组,组内按 lastTs 倒序", () => {
    const g = groupSessionsByWorkspace([s("a", "/p/x", 100), s("b", "/p/x", 300), s("c", "/p/x", 200)]);
    expect(g).toHaveLength(1);
    expect(g[0]!.sessions.map((x) => x.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("组序 = 组内最早会话 startedTs 倒序(新工程在上),不随活动变", () => {
    // old 工程先用(startedTs 10/40),new 工程后用(startedTs 500)
    const g = groupSessionsByWorkspace([
      s("a", "/p/old", 100, null, 10),
      s("b", "/p/new", 900, null, 500),
      s("c", "/p/old", 50, null, 40),
    ]);
    expect(g.map((x) => x.workspace)).toEqual(["/p/new", "/p/old"]);
    expect(g[0]!.lastTs).toBe(900);
    expect(g[1]!.lastTs).toBe(100); // 组的 lastTs 仍取组内最大,展示用
  });

  it("组内会话完成(lastTs 变大)不改组序——工作目录位置定死,只在组内上移", () => {
    // old 工程更早进场;old 里的会话 c 刚完成任务,lastTs=9999 全场最新
    const g = groupSessionsByWorkspace([
      s("a", "/p/old", 100, null, 10),
      s("b", "/p/new", 900, null, 500),
      s("c", "/p/old", 9999, null, 40),
    ]);
    // 组序不变:new(500) 仍在 old(10) 上面,old 不因 c 完成而蹿顶
    expect(g.map((x) => x.workspace)).toEqual(["/p/new", "/p/old"]);
    // 组内:c 上移到最前
    expect(g[1]!.sessions.map((x) => x.sessionId)).toEqual(["c", "a"]);
  });

  it("workspace 为 null 的史前会话直接丢弃,不伪造未知组", () => {
    expect(groupSessionsByWorkspace([s("a", null, 100)])).toEqual([]);
  });

  it("子会话(spawnedFrom 非空)不进任何组——只能从父会话时间线的卡进去(ADR-0047)", () => {
    const g = groupSessionsByWorkspace([
      s("parent", "/p/x", 100),
      s("child", "/p/x", 200, "parent"),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.sessions.map((x) => x.sessionId)).toEqual(["parent"]);
  });

  it("归档会话(archived)不进任何组——收在侧栏「已归档」区(ADR-0087)", () => {
    const g = groupSessionsByWorkspace([
      s("live", "/p/x", 100),
      { ...s("shelved", "/p/x", 200), archived: true },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.sessions.map((x) => x.sessionId)).toEqual(["live"]);
  });

  it("label 是文件夹名,workspace 仍是全路径", () => {
    const g = groupSessionsByWorkspace([s("a", "/Users/stan/Github/Otter", 1)]);
    expect(g[0]!.label).toBe("Otter");
    expect(g[0]!.workspace).toBe("/Users/stan/Github/Otter");
  });

  it("独立副本上的会话折回项目组：组键/组名是项目根，不是 worktree 目录名（#692，同 ADR-0172）", () => {
    const g = groupSessionsByWorkspace([
      s("main", "/Users/stan/Github/Mr_Otto", 100),
      iso("w1", "/Users/stan/Github/Mr_Otto", "/ud/worktrees/d3dbc74d37b3-a9b959", 300),
      iso("w2", "/Users/stan/Github/Mr_Otto", "/ud/worktrees/d3dbc74d37b3-c0ffee", 200),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.workspace).toBe("/Users/stan/Github/Mr_Otto");
    expect(g[0]!.label).toBe("Mr_Otto");
    expect(g[0]!.sessions.map((x) => x.sessionId)).toEqual(["w1", "w2", "main"]);
  });

  it("只有副本会话、没有主目录会话时，组照样以项目根命名", () => {
    const g = groupSessionsByWorkspace([iso("w1", "/p/proj", "/ud/worktrees/abc-def", 1)]);
    expect(g.map((x) => x.workspace)).toEqual(["/p/proj"]);
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

describe("groupArchivedByWorkspace", () => {
  /** 归档版速记:archived 默认为 true——这一屏只认归档会话 */
  const a = (
    sessionId: string,
    workspace: string | null,
    lastTs: number,
    spawnedFrom: string | null = null,
    startedTs: number = lastTs - 1,
  ): SessionSummary => ({ ...s(sessionId, workspace, lastTs, spawnedFrom, startedTs), archived: true });

  it("按工程分组,组序/组内序与主列表同规则", () => {
    const { groups } = groupArchivedByWorkspace([
      a("x1", "/p/old", 100, null, 10),
      a("y1", "/p/new", 900, null, 500),
      a("x2", "/p/old", 800, null, 40),
    ]);
    expect(groups.map((g) => g.workspace)).toEqual(["/p/new", "/p/old"]);
    expect(groups[1]!.sessions.map((x) => x.sessionId)).toEqual(["x2", "x1"]);
  });

  it("归档的副本会话同样折回项目组（#692）", () => {
    const { groups } = groupArchivedByWorkspace([
      a("x1", "/p/proj", 100),
      { ...a("w1", "/ud/worktrees/abc-def", 200), projectRoot: "/p/proj" },
    ]);
    expect(groups.map((g) => g.workspace)).toEqual(["/p/proj"]);
    expect(groups[0]!.sessions.map((x) => x.sessionId)).toEqual(["w1", "x1"]);
  });

  it("没归档的会话不进这一屏", () => {
    const { groups, ungrouped } = groupArchivedByWorkspace([s("live", "/p/x", 100)]);
    expect(groups).toEqual([]);
    expect(ungrouped).toEqual([]);
  });

  it("子会话不进这一屏——它们只从父会话时间线进去", () => {
    const { groups } = groupArchivedByWorkspace([a("kid", "/p/x", 100, "parent")]);
    expect(groups).toEqual([]);
  });

  it("workspace 为 null 的史前归档会话走 ungrouped,不伪造未知组也不藏起来", () => {
    const { groups, ungrouped } = groupArchivedByWorkspace([
      a("ghost", null, 300),
      a("ghost2", null, 900),
      a("real", "/p/x", 100),
    ]);
    expect(groups.map((g) => g.workspace)).toEqual(["/p/x"]);
    expect(ungrouped.map((x) => x.sessionId)).toEqual(["ghost2", "ghost"]);
  });
});

describe("taskSessions —— 侧栏「任务」那一栏", () => {
  const DEF = "/home/u/Documents/Mr Otto/Default";

  it("只要内置 Default 的会话,原序不动", () => {
    const list = taskSessions([s("a", DEF, 300), s("b", "/p/x", 200), s("c", DEF, 100)], DEF);
    expect(list.map((x) => x.sessionId)).toEqual(["a", "c"]);
  });

  it("子会话不进任务栏——memory-reviewer 跑在 Default 里,但没人开过它(ADR-0047)", () => {
    const list = taskSessions([s("kid", DEF, 300, "parent"), s("mine", DEF, 200)], DEF);
    expect(list.map((x) => x.sessionId)).toEqual(["mine"]);
  });

  it("归档的不进活列表;没 builtin 时谁都不进", () => {
    const arch = { ...s("old", DEF, 300), archived: true };
    expect(taskSessions([arch, s("live", DEF, 200)], DEF).map((x) => x.sessionId)).toEqual(["live"]);
    expect(taskSessions([s("live", DEF, 200)], null)).toEqual([]);
  });
});

describe("archivedTaskSessions —— 任务栏的「已归档」", () => {
  const DEF = "/home/u/Documents/Mr Otto/Default";
  const arch = (id: string, workspace: string | null, spawnedFrom: string | null = null): SessionSummary => ({
    ...s(id, workspace, 100, spawnedFrom), archived: true,
  });

  it("只要 Default 的归档会话,子会话同样滤掉", () => {
    const list = archivedTaskSessions(
      [arch("a", DEF), arch("kid", DEF, "parent"), arch("b", "/p/x"), s("live", DEF, 100)],
      DEF
    );
    expect(list.map((x) => x.sessionId)).toEqual(["a"]);
  });
});

describe("partitionShared（issue #809）", () => {
  it("按 sharedWith 非空分两摞，各自保持输入序", () => {
    const shared1 = { ...s("a", "/w", 50), sharedWith: ["小红"] };
    const local1 = s("b", "/w", 40);
    const shared2 = { ...s("c", "/w", 30), sharedWith: ["小红", "小明"] };
    const out = partitionShared([shared1, local1, shared2]);
    expect(out.shared.map((x) => x.sessionId)).toEqual(["a", "c"]);
    expect(out.local.map((x) => x.sessionId)).toEqual(["b"]);
  });

  it("没有分享过的列表：shared 空，local 全量原序", () => {
    const list = [s("a", "/w", 2), s("b", "/w", 1)];
    const out = partitionShared(list);
    expect(out.shared).toEqual([]);
    expect(out.local).toEqual(list);
  });
});

describe("groupTasksByTopic —— 任务栏按主题分组", () => {
  const DEF = "/home/u/Documents/Mr Otto/Default";
  const t = (id: string, topic: string | null, lastTs: number) => ({ ...s(id, DEF, lastTs), topic });
  const labelOf = (slug: string) => ({ work: "工作", hobbies: "爱好" })[slug] ?? slug;
  const KNOWN = new Set(["work", "hobbies", "life", "learning"]);
  it("按 topic 装桶：组序 = 组内最近 lastTs 倒序，未分类永远沉底，组内 lastTs 倒序", () => {
    const groups = groupTasksByTopic(
      [t("a", "work", 100), t("b", null, 900), t("c", "hobbies", 500), t("d", "work", 300)],
      labelOf,
      KNOWN,
    );
    expect(groups.map((g) => [g.topic, g.label, g.sessions.map((x) => x.sessionId)])).toEqual([
      ["hobbies", "爱好", ["c"]],
      ["work", "工作", ["d", "a"]],
      [null, "未分类", ["b"]],
    ]);
  });
  it("全部未分类：只有一组、不带组头语义（label 仍是「未分类」，由 UI 决定要不要画头）", () => {
    expect(groupTasksByTopic([t("a", null, 1)], labelOf, KNOWN)).toHaveLength(1);
  });
  it("空输入 → []", () => {
    expect(groupTasksByTopic([], labelOf, KNOWN)).toEqual([]);
  });
  it("桶被删了的会话回未分类：topic 不在 known 集合里当 null，不抛", () => {
    const groups = groupTasksByTopic([t("a", "cars", 100), t("b", "work", 50)], labelOf, new Set(["work", "hobbies", "life", "learning"]));
    expect(groups.map((g) => [g.topic, g.sessions.map((x) => x.sessionId)])).toEqual([["work", ["b"]], [null, ["a"]]]);
  });
});
