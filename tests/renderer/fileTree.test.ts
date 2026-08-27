import { describe, expect, it } from "vitest";

import { changedFilesOf, fileTreeNodes, mergeChangedFiles } from "../../src/renderer/src/lib/fileTree.js";

const WS = "/w";

describe("fileTreeNodes(动过的文件 → 一棵能按行画的树,issue #582)", () => {
  it("同一层的文件不长出多余的目录行", () => {
    expect(fileTreeNodes([{ path: "/w/a.ts" }, { path: "/w/b.ts" }], WS)).toEqual([
      { path: "a.ts", name: "a.ts", depth: 0, kind: "file", full: "/w/a.ts" },
      { path: "b.ts", name: "b.ts", depth: 0, kind: "file", full: "/w/b.ts" },
    ]);
  });

  it("独生子女的目录链压成一行——四层单传不该摞出四行留白", () => {
    const nodes = fileTreeNodes([{ path: "/w/src/renderer/lib/a.ts" }], WS);
    expect(nodes).toEqual([
      { path: "src/renderer/lib", name: "src/renderer/lib", depth: 0, kind: "folder" },
      {
        path: "src/renderer/lib/a.ts",
        name: "a.ts",
        depth: 1,
        kind: "file",
        full: "/w/src/renderer/lib/a.ts",
      },
    ]);
  });

  it("分叉处才真的缩进:公共前缀压一行,两支各自一行", () => {
    const nodes = fileTreeNodes([{ path: "/w/src/a/x.ts" }, { path: "/w/src/b/y.ts" }], WS);
    expect(nodes.map((n) => [n.name, n.depth, n.kind])).toEqual([
      ["src", 0, "folder"],
      ["a", 1, "folder"],
      ["x.ts", 2, "file"],
      ["b", 1, "folder"],
      ["y.ts", 2, "file"],
    ]);
  });

  it("目录排在同层文件前面——先看结构再看叶子", () => {
    const nodes = fileTreeNodes([{ path: "/w/z.ts" }, { path: "/w/sub/a.ts" }], WS);
    expect(nodes.map((n) => n.name)).toEqual(["sub", "a.ts", "z.ts"]);
  });

  it("工作区外的文件不进树,单独一行、显示完整路径", () => {
    const nodes = fileTreeNodes([{ path: "/w/a.ts" }, { path: "/tmp/x.log" }], WS);
    expect(nodes).toEqual([
      { path: "a.ts", name: "a.ts", depth: 0, kind: "file", full: "/w/a.ts" },
      { path: "/tmp/x.log", name: "/tmp/x.log", depth: 0, kind: "file", full: "/tmp/x.log" },
    ]);
  });

  it("没有工作区(空串)时全按区外算,不抛", () => {
    expect(fileTreeNodes([{ path: "/a/b.ts" }], "")).toEqual([
      { path: "/a/b.ts", name: "/a/b.ts", depth: 0, kind: "file", full: "/a/b.ts" },
    ]);
  });

  it("一个文件都没有 = 空树", () => {
    expect(fileTreeNodes([], WS)).toEqual([]);
  });

  it("行序稳定(按路径排):同一组事件重放两次画出来的树一模一样", () => {
    const a = fileTreeNodes([{ path: "/w/b.ts" }, { path: "/w/a.ts" }], WS);
    const b = fileTreeNodes([{ path: "/w/a.ts" }, { path: "/w/b.ts" }], WS);
    expect(a).toEqual(b);
  });
});

describe("fileTreeNodes —— 行数（ADR-0141）", () => {
  it("有账的带上,没账的连键都不带——0 和「不知道」不是一回事", () => {
    const nodes = fileTreeNodes(
      [{ path: "/w/a.ts", additions: 24, deletions: 6 }, { path: "/w/b.ts" }],
      WS
    );
    expect(nodes[0]).toMatchObject({ name: "a.ts", additions: 24, deletions: 6 });
    expect(nodes[1]).not.toHaveProperty("additions");
    expect(nodes[1]).not.toHaveProperty("deletions");
  });

  it("目录行不带行数——它是结构,不是改动", () => {
    const nodes = fileTreeNodes([{ path: "/w/src/a.ts", additions: 3 }, { path: "/w/b.ts" }], WS);
    const folder = nodes.find((n) => n.kind === "folder");
    expect(folder).not.toHaveProperty("additions");
  });
});

describe("mergeChangedFiles(同一组里同一个文件写两次)", () => {
  it("合成一行,行数相加", () => {
    expect(
      mergeChangedFiles([
        { path: "/w/a.ts", additions: 2, deletions: 1 },
        { path: "/w/a.ts", additions: 3, deletions: 4 },
      ])
    ).toEqual([{ path: "/w/a.ts", additions: 5, deletions: 5 }]);
  });

  it("一笔有账一笔没账:只加有账的那笔,不把它当 0", () => {
    expect(
      mergeChangedFiles([{ path: "/w/a.ts" }, { path: "/w/a.ts", additions: 3 }])
    ).toEqual([{ path: "/w/a.ts", additions: 3 }]);
  });

  it("全都没账 = 真的没账,合出来的那条不带行数键", () => {
    const out = mergeChangedFiles([{ path: "/w/a.ts" }, { path: "/w/a.ts" }]);
    expect(out).toEqual([{ path: "/w/a.ts" }]);
  });

  it("不同文件各留一行,保持出现顺序", () => {
    expect(mergeChangedFiles([{ path: "/w/b.ts" }, { path: "/w/a.ts" }]).map((f) => f.path)).toEqual(
      ["/w/b.ts", "/w/a.ts"]
    );
  });
});

describe("changedFilesOf(工具组 → 树的输入)", () => {
  const stats: Record<string, { additions: number; deletions: number }> = {
    c1: { additions: 24, deletions: 6 },
  };
  const statOf = (id: string) => stats[id];
  const pathOf = (c: { args?: unknown }) => (c.args as { path?: string })?.path ?? null;

  it("只数写入:读取不是「改变」", () => {
    const out = changedFilesOf(
      [
        { id: "c1", name: "write_file", args: { path: "/w/a.ts" } },
        { id: "c2", name: "read_file", args: { path: "/w/b.ts" } },
      ],
      pathOf,
      statOf
    );
    expect(out).toEqual([{ path: "/w/a.ts", additions: 24, deletions: 6 }]);
  });

  it("日志里有 diffStat 就报数字——这一条断的正是「写了却不显示 +x −x」那个症状", () => {
    const out = changedFilesOf([{ id: "c1", name: "write_file", args: { path: "/w/a.ts" } }], pathOf, statOf);
    expect(out[0]).toMatchObject({ additions: 24, deletions: 6 });
  });

  it("旧日志没有 diffStat:那一条连键都不带,不填零", () => {
    const out = changedFilesOf([{ id: "old", name: "write_file", args: { path: "/w/a.ts" } }], pathOf, statOf);
    expect(out).toEqual([{ path: "/w/a.ts" }]);
  });

  it("路径认不出来的整条跳过,不抛", () => {
    const out = changedFilesOf([{ id: "c9", name: "write_file", args: null }], pathOf, statOf);
    expect(out).toEqual([]);
  });

  it("同一个文件写两次:合成一行,行数相加", () => {
    const two = { a: { additions: 1, deletions: 0 }, b: { additions: 2, deletions: 3 } } as Record<
      string,
      { additions: number; deletions: number }
    >;
    const out = changedFilesOf(
      [
        { id: "a", name: "write_file", args: { path: "/w/a.ts" } },
        { id: "b", name: "write_file", args: { path: "/w/a.ts" } },
      ],
      pathOf,
      (id) => two[id]
    );
    expect(out).toEqual([{ path: "/w/a.ts", additions: 3, deletions: 3 }]);
  });
});
