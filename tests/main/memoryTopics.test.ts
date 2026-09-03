import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTopics } from "../../src/main/memoryTopics.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "otto-topics-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readTopics —— 种子 ∪ 磁盘", () => {
  it("目录不存在：只有四个种子，内容空", () => {
    expect(readTopics(join(root, "nope"))).toEqual([
      { slug: "work", label: "工作", content: "" },
      { slug: "hobbies", label: "爱好", content: "" },
      { slug: "life", label: "生活", content: "" },
      { slug: "learning", label: "学习", content: "" },
    ]);
  });
  it("磁盘桶接在种子后；.label 覆盖显示名；非法文件名忽略", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "cars.md"), "改装 WRX");
    writeFileSync(join(root, "cars.label"), "改装车\n");
    writeFileSync(join(root, "work.md"), "在 X 公司");
    writeFileSync(join(root, "Bad.md"), "x");
    const t = readTopics(root);
    expect(t.map((x) => x.slug)).toEqual(["work", "hobbies", "life", "learning", "cars"]);
    expect(t.find((x) => x.slug === "cars")).toEqual({ slug: "cars", label: "改装车", content: "改装 WRX" });
    expect(t.find((x) => x.slug === "work")?.content).toBe("在 X 公司");
  });
});
