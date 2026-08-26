import { describe, expect, it } from "vitest";

import { fileTreeNodes } from "../../src/renderer/src/lib/fileTree.js";

const WS = "/w";

describe("fileTreeNodes(动过的文件 → 一棵能按行画的树,issue #582)", () => {
  it("同一层的文件不长出多余的目录行", () => {
    expect(fileTreeNodes(["/w/a.ts", "/w/b.ts"], WS)).toEqual([
      { path: "a.ts", name: "a.ts", depth: 0, kind: "file", full: "/w/a.ts" },
      { path: "b.ts", name: "b.ts", depth: 0, kind: "file", full: "/w/b.ts" },
    ]);
  });

  it("独生子女的目录链压成一行——四层单传不该摞出四行留白", () => {
    const nodes = fileTreeNodes(["/w/src/renderer/lib/a.ts"], WS);
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
    const nodes = fileTreeNodes(["/w/src/a/x.ts", "/w/src/b/y.ts"], WS);
    expect(nodes.map((n) => [n.name, n.depth, n.kind])).toEqual([
      ["src", 0, "folder"],
      ["a", 1, "folder"],
      ["x.ts", 2, "file"],
      ["b", 1, "folder"],
      ["y.ts", 2, "file"],
    ]);
  });

  it("目录排在同层文件前面——先看结构再看叶子", () => {
    const nodes = fileTreeNodes(["/w/z.ts", "/w/sub/a.ts"], WS);
    expect(nodes.map((n) => n.name)).toEqual(["sub", "a.ts", "z.ts"]);
  });

  it("工作区外的文件不进树,单独一行、显示完整路径", () => {
    const nodes = fileTreeNodes(["/w/a.ts", "/tmp/x.log"], WS);
    expect(nodes).toEqual([
      { path: "a.ts", name: "a.ts", depth: 0, kind: "file", full: "/w/a.ts" },
      { path: "/tmp/x.log", name: "/tmp/x.log", depth: 0, kind: "file", full: "/tmp/x.log" },
    ]);
  });

  it("没有工作区(空串)时全按区外算,不抛", () => {
    expect(fileTreeNodes(["/a/b.ts"], "")).toEqual([
      { path: "/a/b.ts", name: "/a/b.ts", depth: 0, kind: "file", full: "/a/b.ts" },
    ]);
  });

  it("一个文件都没有 = 空树", () => {
    expect(fileTreeNodes([], WS)).toEqual([]);
  });

  it("行序稳定(按路径排):同一组事件重放两次画出来的树一模一样", () => {
    const a = fileTreeNodes(["/w/b.ts", "/w/a.ts"], WS);
    const b = fileTreeNodes(["/w/a.ts", "/w/b.ts"], WS);
    expect(a).toEqual(b);
  });
});
