// 认路径这件事的守卫。两头都要钉:该认的认(否则功能哑火),不该认的别认
// (误报的代价是满屏假链接,点了报"文件不存在",比不认还糟)。

import { describe, expect, it } from "vitest";
import { parseFileRef, scanFileRefs, toWorkspaceRel } from "../../src/shared/fileRefs.js";

describe("scanFileRefs", () => {
  it("认出 路径:行号", () => {
    const [r] = scanFileRefs("改成 src/loop/engine.ts:386 那个形式");
    expect(r?.path).toBe("src/loop/engine.ts");
    expect(r?.line).toBe(386);
  });

  it("认出 行:列", () => {
    const [r] = scanFileRefs("报错在 src/a.ts:12:5");
    expect(r).toMatchObject({ path: "src/a.ts", line: 12, column: 5 });
  });

  it("没写行号也算引用(整文件)", () => {
    const [r] = scanFileRefs("见 tests/shared/files.test.ts 里那条");
    expect(r).toMatchObject({ path: "tests/shared/files.test.ts", line: null });
  });

  it("绝对路径", () => {
    const [r] = scanFileRefs("/Users/x/repo/src/a.ts:9 这里");
    expect(r).toMatchObject({ path: "/Users/x/repo/src/a.ts", line: 9 });
  });

  it("一段话里多条", () => {
    expect(scanFileRefs("src/a.ts:1 和 src/b.tsx:2").map((r) => r.path)).toEqual([
      "src/a.ts",
      "src/b.tsx",
    ]);
  });

  it("位置能把原文切回来", () => {
    const text = "看 src/a.ts:3 这行";
    const [r] = scanFileRefs(text);
    expect(text.slice(r!.start, r!.end)).toBe("src/a.ts:3");
  });

  it("URL 不是路径", () => {
    expect(scanFileRefs("https://claude.ai/index.html:80")).toEqual([]);
    expect(scanFileRefs("见 https://a.dev/src/a.ts")).toEqual([]);
  });

  it("域名、版本号、包名不是路径", () => {
    expect(scanFileRefs("claude.ai 上")).toEqual([]);
    expect(scanFileRefs("升到 1.2.15 了")).toEqual([]);
    expect(scanFileRefs("装 @scope/pkg.js")).toEqual([]);
  });

  it("含 .. 的路径不认(面板也开不了)", () => {
    expect(scanFileRefs("../outside/a.ts:3")).toEqual([]);
  });

  it("行号 0 当成没给行号", () => {
    expect(scanFileRefs("src/a.ts:0")[0]).toMatchObject({ line: null });
  });
});

describe("parseFileRef", () => {
  it("整串就是一条引用才算", () => {
    expect(parseFileRef("src/a.ts:3")).toMatchObject({ path: "src/a.ts", line: 3 });
    expect(parseFileRef("  src/a.ts  ")).toMatchObject({ path: "src/a.ts", line: null });
    expect(parseFileRef("见 src/a.ts:3 这行")).toBeNull();
  });

  it("认 GitHub 的 #L 写法", () => {
    expect(parseFileRef("src/a.ts#L42")).toMatchObject({ path: "src/a.ts", line: 42 });
  });

  it("外链不是路径", () => {
    expect(parseFileRef("https://example.com/a.ts")).toBeNull();
    expect(parseFileRef("mailto:a@b.com")).toBeNull();
  });
});

describe("toWorkspaceRel", () => {
  const root = "/Users/x/repo";

  it("相对路径原样过", () => {
    expect(toWorkspaceRel(root, "src/a.ts")).toBe("src/a.ts");
    expect(toWorkspaceRel(root, "./src/a.ts")).toBe("src/a.ts");
  });

  it("工作区内的绝对路径削成相对", () => {
    expect(toWorkspaceRel(root, "/Users/x/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("工作区外的绝对路径打不开", () => {
    expect(toWorkspaceRel(root, "/etc/passwd")).toBeNull();
    // 前缀像但不是同一个目录:/Users/x/repo-2 不在 /Users/x/repo 里
    expect(toWorkspaceRel(root, "/Users/x/repo-2/src/a.ts")).toBeNull();
  });

  it("没工作区就没有相对路径", () => {
    expect(toWorkspaceRel("", "src/a.ts")).toBeNull();
  });

  it("越界的相对路径不认", () => {
    expect(toWorkspaceRel(root, "../a.ts")).toBeNull();
  });
});
