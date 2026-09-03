import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalWorld } from "../../src/world/localWorld.js";
import { withAbortSignal, withExecOutput } from "../../src/world/executionWorld.js";
import { tempDir } from "../helpers/tempDir.js";

describe("LocalWorld.config", () => {
  it("不给 configRoot = 没有 config 能力", () => {
    expect(createLocalWorld({}).config).toBeUndefined();
  });

  it("read：不存在返回 null；write 自动建目录，读回原文", async () => {
    const root = tempDir("otto-cfg-");
    const world = createLocalWorld({ configRoot: root });
    expect(await world.config!.read("memories/MEMORY.md")).toBeNull();
    await world.config!.write("memories/MEMORY.md", "a\n§\nb");
    expect(readFileSync(join(root, "memories/MEMORY.md"), "utf8")).toBe("a\n§\nb");
    expect(await world.config!.read("memories/MEMORY.md")).toBe("a\n§\nb");
  });

  it("越出 configRoot 抛错", async () => {
    const root = tempDir("otto-cfg-");
    const world = createLocalWorld({ configRoot: root });
    await expect(world.config!.read("../x")).rejects.toThrow(/越出/);
  });

  it("装饰器透传 config", () => {
    const root = tempDir("otto-cfg-");
    const world = createLocalWorld({ configRoot: root });
    expect(withAbortSignal(world, new AbortController().signal).config).toBe(world.config);
    expect(withExecOutput(world, () => {}).config).toBe(world.config);
  });

  it("list：目录不存在回 []；存在时回文件名", async () => {
    const root = tempDir("otto-cfg-");
    const world = createLocalWorld({ configRoot: root });
    expect(await world.config!.list("memories/topics")).toEqual([]);
    await world.config!.write("memories/topics/work.md", "a");
    await world.config!.write("memories/topics/work.label", "上班");
    expect((await world.config!.list("memories/topics")).sort()).toEqual(["work.label", "work.md"]);
  });
  it("list 也过围栏：../ 越界抛", async () => {
    const root = tempDir("otto-cfg-");
    const world = createLocalWorld({ configRoot: root });
    await expect(world.config!.list("../etc")).rejects.toThrow();
  });

  it("config.write 完成后调 onConfigWrite(rel)（#852 云同步挂钩）", async () => {
    const root = tempDir("otto-cfg-");
    const seen: string[] = [];
    const world = createLocalWorld({ configRoot: root, onConfigWrite: (rel) => seen.push(rel) });
    await world.config!.write("memories/USER.md", "x");
    expect(seen).toEqual(["memories/USER.md"]);
  });
});
