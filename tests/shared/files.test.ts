// shared/files.ts 是 Files 面板的纯逻辑层:排序/过滤/rg 输出解析/二进制判定。
// 这层没有 IO,所以这里能把"面板到底按什么规矩排、什么算命中"钉死,
// 不用去碰真文件系统。

import { describe, expect, it } from "vitest";
import {
  classifyRgError, isBinaryish, joinRel, matchesFilter, parseRgJson, sortEntries,
  type FileEntry,
} from "../../src/shared/files.js";

function entry(name: string, kind: "dir" | "file"): FileEntry {
  return { name, kind, size: 0, mtime: 0 };
}

describe("sortEntries", () => {
  it("目录排在文件前面", () => {
    const out = sortEntries([entry("a.ts", "file"), entry("zz", "dir")]);
    expect(out.map((e) => e.name)).toEqual(["zz", "a.ts"]);
  });

  it("同类按名字排,数字按数值不按字典序", () => {
    const out = sortEntries([entry("f10.ts", "file"), entry("f2.ts", "file")]);
    expect(out.map((e) => e.name)).toEqual(["f2.ts", "f10.ts"]);
  });

  it("点文件不下沉——树是全显的,把它们排到最后等于藏起来", () => {
    const out = sortEntries([entry("src", "dir"), entry(".github", "dir")]);
    expect(out.map((e) => e.name)).toEqual([".github", "src"]);
  });

  it("不改原数组", () => {
    const input = [entry("b", "file"), entry("a", "file")];
    sortEntries(input);
    expect(input.map((e) => e.name)).toEqual(["b", "a"]);
  });
});

describe("matchesFilter", () => {
  it("子序列命中:fic 命中 src/lib/fileIcon.ts", () => {
    expect(matchesFilter("src/lib/fileIcon.ts", "fic")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(matchesFilter("src/App.tsx", "app")).toBe(true);
  });

  it("顺序不对不算命中", () => {
    expect(matchesFilter("src/App.tsx", "xpp")).toBe(false);
  });

  it("空查询命中一切——空过滤框不该把树清空", () => {
    expect(matchesFilter("whatever", "")).toBe(true);
  });
});

describe("parseRgJson", () => {
  const stdout = [
    JSON.stringify({ type: "begin", data: { path: { text: "/w/src/a.ts" } } }),
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "/w/src/a.ts" },
        lines: { text: "const foo = 1\n" },
        line_number: 12,
      },
    }),
    JSON.stringify({ type: "end", data: {} }),
  ].join("\n");

  it("只取 match 行,begin/end 忽略", () => {
    expect(parseRgJson(stdout)).toEqual([
      { rel: "/w/src/a.ts", line: 12, text: "const foo = 1" },
    ]);
  });

  it("坏行跳过而不是整批炸——rg 中途被杀会留半行 JSON", () => {
    expect(parseRgJson('{"type":"match"' + "\n" + stdout)).toHaveLength(1);
  });

  it("空输出 = 空数组", () => {
    expect(parseRgJson("")).toEqual([]);
  });
});

describe("classifyRgError", () => {
  it("ENOENT = 没装 rg", () => {
    expect(classifyRgError({ code: "ENOENT" })).toBe("rg-missing");
  });

  it("退出码 1 = 没匹配,不是错误", () => {
    expect(classifyRgError({ code: 1 })).toBe(null);
  });

  it("其它 = 搜索出错", () => {
    expect(classifyRgError({ code: 2, stderr: "boom" })).toBe("search-error");
  });
});

describe("isBinaryish", () => {
  it("含 NUL 字节 = 二进制", () => {
    expect(isBinaryish(new Uint8Array([0x48, 0x00, 0x49]))).toBe(true);
  });

  it("纯文本不是", () => {
    expect(isBinaryish(new TextEncoder().encode("hello\n世界"))).toBe(false);
  });

  it("只看前 8KB:超出部分的 NUL 不算(截断预览本来就只读前面那截)", () => {
    // 全填 'A' 再在 8KB 之外埋一个 NUL —— 新建的 Uint8Array 本身就是全 0,
    // 不填的话这个用例测的是"全 NUL 算不算二进制",跟它想测的正好相反
    const buf = new Uint8Array(9000).fill(0x41);
    buf[8500] = 0;
    expect(isBinaryish(buf)).toBe(false);
  });
});

describe("joinRel", () => {
  it("根目录下拼出来不带前导斜杠", () => {
    expect(joinRel("", "src")).toBe("src");
  });

  it("子目录用 / 连", () => {
    expect(joinRel("src/lib", "a.ts")).toBe("src/lib/a.ts");
  });
});
