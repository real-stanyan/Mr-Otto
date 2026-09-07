import { describe, expect, it } from "vitest";
import {
  joinWorkPath,
  normalizeWorkPath,
  WORK_PATH_MAX_SEGMENTS,
} from "../../../src/shared/remote/workPath.js";

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);

describe("normalizeWorkPath（#1056）", () => {
  it("空、`.`、多余斜杠都归成同一条干净路径", () => {
    expect(normalizeWorkPath("")).toBe("");
    expect(normalizeWorkPath(".")).toBe("");
    expect(normalizeWorkPath("a//b/./c")).toBe("a/b/c");
    expect(normalizeWorkPath("a/b/")).toBe("a/b");
  });

  it("`..` 一律拒，**不解释成上跳一级**", () => {
    // 解释它意味着两条不同的输入映射到同一个地方，而那个映射里的任何差错
    // 都是一次容器内越界读。界面的面包屑本来就有完整段列表，从不需要它
    expect(normalizeWorkPath("..")).toBeNull();
    expect(normalizeWorkPath("a/../b")).toBeNull();
    expect(normalizeWorkPath("a/b/..")).toBeNull();
  });

  it("绝对路径拒，不静默当成相对的", () => {
    // 静默换一套坐标系正好会盖住调用方的 bug
    expect(normalizeWorkPath("/etc/passwd")).toBeNull();
    expect(normalizeWorkPath("/")).toBeNull();
  });

  it("NUL 拒（文件名里不可能有，出现即是构造过的）", () => {
    expect(normalizeWorkPath(`a${NUL}b`)).toBeNull();
  });

  it("段数超上限拒", () => {
    const ok = Array.from({ length: WORK_PATH_MAX_SEGMENTS }, (_, i) => `d${i}`).join("/");
    expect(normalizeWorkPath(ok)).toBe(ok);
    expect(normalizeWorkPath(`${ok}/one-more`)).toBeNull();
  });

  it("`..` 之外的怪名字照过——它们是合法文件名", () => {
    expect(normalizeWorkPath("...")).toBe("...");
    expect(normalizeWorkPath(`a b/c${TAB}d`)).toBe(`a b/c${TAB}d`);
    expect(normalizeWorkPath("菜单.md")).toBe("菜单.md");
  });
});

describe("拼接", () => {
  it("join 在根上也说得通", () => {
    expect(joinWorkPath("", "a")).toBe("a");
    expect(joinWorkPath("a", "b")).toBe("a/b");
  });
});
