import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryFiles, type MemoryFiles } from "../../src/main/memoryFiles.js";
import { projectMemoryDir } from "../../src/main/projectRoot.js";

let root: string;
let files: MemoryFiles;
let writes: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otto-memfiles-"));
  writes = [];
  files = createMemoryFiles(root, { onWrite: (rel) => writes.push(rel) });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("memoryFiles —— memories/ 的唯一读写口（#852）", () => {
  it("write 建目录并回调 onWrite；read 读回；readSync 同", async () => {
    await files.write("memories/USER.md", "hi");
    expect(await files.read("memories/USER.md")).toBe("hi");
    expect(files.readSync("memories/USER.md")).toBe("hi");
    expect(writes).toEqual(["memories/USER.md"]);
  });
  it("没有的文件读成空串，不抛", async () => {
    expect(await files.read("memories/MEMORY.md")).toBe("");
    expect(files.readSync("memories/MEMORY.md")).toBe("");
  });
  it("remove 不存在不报错，存在则删并回调", async () => {
    await files.remove("memories/topics/x.md");
    await files.write("memories/topics/x.md", "1");
    await files.remove("memories/topics/x.md");
    expect(await files.read("memories/topics/x.md")).toBe("");
    expect(writes).toEqual(["memories/topics/x.md", "memories/topics/x.md"]);
  });
  it("walk 递归列出 memories/ 下所有文件，带内容与 mtime；空目录 → []", async () => {
    expect(await files.walk()).toEqual([]);
    await files.write("memories/USER.md", "u");
    await files.write("memories/topics/work.md", "w");
    const w = await files.walk();
    expect(w.map((d) => d.rel).sort()).toEqual(["memories/USER.md", "memories/topics/work.md"]);
    expect(w.every((d) => typeof d.mtimeMs === "number" && d.mtimeMs > 0)).toBe(true);
  });
  it("围栏：不以 memories/ 开头或越界一律抛", async () => {
    await expect(files.write("config.json", "x")).rejects.toThrow(/越界/);
    await expect(files.write("memories/../auth.json", "x")).rejects.toThrow(/越界/);
  });
  it("deleteTopic 删 .md 与 .label 并各回调一次；setTopicLabel 空白 = 删 .label", async () => {
    await files.write("memories/topics/work.md", "w");
    await files.setTopicLabel("work", "工作");
    expect(await files.read("memories/topics/work.label")).toBe("工作");
    await files.setTopicLabel("work", "  ");
    expect(await files.read("memories/topics/work.label")).toBe("");
    await files.deleteTopic("work");
    expect(await files.read("memories/topics/work.md")).toBe("");
    expect(writes.filter((r) => r === "memories/topics/work.label").length).toBe(3);
  });
  it("listProjects 只列有 root.txt 的目录；deleteProject 整目录删并按文件回调", async () => {
    const dir = projectMemoryDir("/p/x");
    await files.write(`${dir}/root.txt`, "/p/x");
    await files.write(`${dir}/MEMORY.md`, "m");
    await files.write("memories/projects/orphan/MEMORY.md", "o");
    expect(await files.listProjects()).toEqual([{ root: "/p/x", text: "m" }]);
    writes.length = 0;
    await files.deleteProject("/p/x");
    expect(await files.listProjects()).toEqual([]);
    expect(writes.map((r) => r.split("/").pop()).sort()).toEqual(["MEMORY.md", "root.txt"]);
  });
});
