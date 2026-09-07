import { describe, expect, it } from "vitest";
import {
  entryMeta,
  formatWorkSize,
  formatWorkTime,
  workFileNotice,
  workFolderNotice,
} from "../../src/renderer/src/lib/workFilesView.js";

const NOW = new Date("2026-09-07T12:00:00Z").getTime();

describe("workFolderNotice（#1056）", () => {
  // 这三句是这次改名成立与否的核心：一个叫「文件」的页面，「什么都没有」这件事
  // 有三种完全不同的原因，说错一句就等于骗人
  it("absent ≠ 空目录：容器还没建起来时不许说「你的文件夹是空的」", () => {
    const absent = workFolderNotice({ kind: "absent" });
    expect(absent).toMatch(/还没建起来/);
    const empty = workFolderNotice({ kind: "dir", entries: [], truncated: false });
    expect(empty).toMatch(/还是空的/);
    expect(absent).not.toBe(empty);
  });

  it("missing 单列一句（翻着翻着被删了）", () => {
    expect(workFolderNotice({ kind: "missing" })).toMatch(/没有东西/);
  });

  it("有东西可画就不出这句话", () => {
    expect(
      workFolderNotice({ kind: "dir", entries: [{ name: "a", kind: "file", size: 1, mtimeMs: 1 }], truncated: false })
    ).toBeNull();
    expect(workFolderNotice({ kind: "file", text: "x", truncated: false, size: 1 })).toBeNull();
    expect(workFolderNotice({ kind: "binary", size: 1 })).toBeNull();
  });
});

describe("workFileNotice", () => {
  it("二进制与截断各自说清楚；正常文件不加脚注", () => {
    expect(workFileNotice({ kind: "binary", size: 4096 })).toMatch(/二进制/);
    expect(workFileNotice({ kind: "file", text: "x", truncated: true, size: 200000 })).toMatch(/只显示了开头/);
    expect(workFileNotice({ kind: "file", text: "x", truncated: false, size: 1 })).toBeNull();
  });

  it("空文件也要说一句——空白框和「组件坏了」长得一样", () => {
    expect(workFileNotice({ kind: "file", text: "", truncated: false, size: 0 })).toBe("这是一个空文件。");
  });
});

describe("大小与时间", () => {
  it("字节数写成人话", () => {
    expect(formatWorkSize(0)).toBe("0 B");
    expect(formatWorkSize(999)).toBe("999 B");
    expect(formatWorkSize(1536)).toBe("1.5 KB");
    expect(formatWorkSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("今年只写月日，跨年补年份", () => {
    expect(formatWorkTime(new Date("2026-03-04T00:00:00").getTime(), NOW)).toBe("3/4");
    expect(formatWorkTime(new Date("2025-12-31T00:00:00").getTime(), NOW)).toBe("2025/12/31");
    expect(formatWorkTime(0, NOW)).toBe("");
  });

  it("目录行不写大小（那一格对目录没有意义）", () => {
    const t = new Date("2026-03-04T00:00:00").getTime();
    expect(entryMeta({ name: "src", kind: "dir", size: 0, mtimeMs: t }, NOW)).toBe("3/4");
    expect(entryMeta({ name: "a.md", kind: "file", size: 1536, mtimeMs: t }, NOW)).toBe("1.5 KB · 3/4");
  });
});
