import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld } from "../../src/world/localWorld.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otter-world-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalWorld 围栏（root 圈地）", () => {
  it("相对路径落在 root 下", async () => {
    const world = createLocalWorld({ root });
    await world.fs.write("a.txt", "hi");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hi");
    expect(await world.fs.read("a.txt")).toBe("hi");
  });

  it("root 内的绝对路径放行", async () => {
    const world = createLocalWorld({ root });
    await world.fs.write(join(root, "b.txt"), "in");
    expect(await world.fs.read(join(root, "b.txt"))).toBe("in");
  });

  it("../ 逃逸 → 抛错，文件系统没被碰", async () => {
    const world = createLocalWorld({ root });
    await expect(world.fs.write("../evil.txt", "x")).rejects.toThrow(/越出工程文件夹/);
  });

  it("外部绝对路径 → 抛错", async () => {
    const world = createLocalWorld({ root });
    await expect(world.fs.read("/etc/hosts")).rejects.toThrow(/越出工程文件夹/);
  });

  it("变体逃逸：root 前缀相同的兄弟目录也拦（/root-evil 不算 /root 里面）", async () => {
    const world = createLocalWorld({ root });
    await expect(world.fs.write(`${root}-evil/x.txt`, "x")).rejects.toThrow(/越出工程文件夹/);
  });

  it("exec 的 cwd = root", async () => {
    const world = createLocalWorld({ root });
    const result = await world.exec("pwd");
    // macOS 的 /tmp 是 /private/tmp 的符号链接，比对真实路径结尾即可
    expect(result.stdout.trim().endsWith(root.split("/").pop()!)).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("不配 root = 不设防（旧行为不变）", async () => {
    const world = createLocalWorld();
    const path = join(root, "free.txt");
    await world.fs.write(path, "free");
    expect(await world.fs.read(path)).toBe("free");
  });
});

describe("LocalWorld exec 中断（ADR-0006）", () => {
  it("signal 翻转 → 杀死子进程并抛'命令被中断'，不伪装成命令失败", async () => {
    const world = createLocalWorld({ root });
    const ctrl = new AbortController();
    const running = world.exec("sleep 30", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    await expect(running).rejects.toThrow(/命令被中断/);
  });

  it("不带 signal 照旧：接口向后兼容", async () => {
    const world = createLocalWorld({ root });
    const result = await world.exec("echo ok");
    expect(result.stdout.trim()).toBe("ok");
  });
});
