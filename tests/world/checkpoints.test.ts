import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createShadowGitCheckpoints,
  sessionCheckpointStoreName,
  workspaceStoreName,
} from "../../src/world/checkpoints.js";

let root: string;
let ws: string;
let gitDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otter-ckpt-"));
  ws = join(root, "workspace");
  gitDir = join(root, "shadow");
  await mkdir(ws, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cap() {
  return createShadowGitCheckpoints({ workspace: ws, gitDir });
}

describe("影子 git 检查点（issue #395）", () => {
  it("save 返回 commit id；restore 把被跟踪文件改回快照时刻", async () => {
    const cp = cap();
    await writeFile(join(ws, "a.txt"), "v1");
    const id1 = await cp.save("turn 1");
    expect(id1).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(ws, "a.txt"), "v2");
    const id2 = await cp.save("turn 2");
    expect(id2).not.toBe(id1);

    await cp.restore(id1);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("v1");
    // 回到未来同样可行（ref 保可达）
    await cp.restore(id2);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("v2");
  });

  it("快照后新建、且进过后续快照的文件：restore 到更早的点会删掉它", async () => {
    const cp = cap();
    await writeFile(join(ws, "a.txt"), "base");
    const id1 = await cp.save("t1");
    await writeFile(join(ws, "later.txt"), "agent 后来写的");
    await cp.save("t2");
    await cp.restore(id1);
    await expect(access(join(ws, "later.txt"))).rejects.toThrow();
  });

  it("从未进过任何快照的文件（untracked）：restore 不动它", async () => {
    const cp = cap();
    await writeFile(join(ws, "a.txt"), "base");
    const id1 = await cp.save("t1");
    await writeFile(join(ws, "wip.txt"), "还没存过档");
    await cp.restore(id1);
    expect(await readFile(join(ws, "wip.txt"), "utf8")).toBe("还没存过档");
  });

  it("无改动的 save 也出新 id（每个 turn 一个锚点）", async () => {
    const cp = cap();
    await writeFile(join(ws, "a.txt"), "x");
    const id1 = await cp.save("t1");
    const id2 = await cp.save("t2");
    expect(id2).not.toBe(id1);
  });

  it("工作区 .gitignore 生效：被忽略的文件不进快照、restore 不还原它", async () => {
    const cp = cap();
    await writeFile(join(ws, ".gitignore"), "secret.env\n");
    await writeFile(join(ws, "secret.env"), "KEY=1");
    await writeFile(join(ws, "a.txt"), "v1");
    const id1 = await cp.save("t1");
    await writeFile(join(ws, "secret.env"), "KEY=2");
    await writeFile(join(ws, "a.txt"), "v2");
    await cp.save("t2");
    await cp.restore(id1);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("v1");
    expect(await readFile(join(ws, "secret.env"), "utf8")).toBe("KEY=2"); // 忽略区不归检查点管
  });

  it("工作区自己的 .git 不被影子仓碰（分支/历史安全）", async () => {
    const cp = cap();
    await mkdir(join(ws, ".git"));
    await writeFile(join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(ws, "a.txt"), "v1");
    const id1 = await cp.save("t1");
    await writeFile(join(ws, ".git", "HEAD"), "ref: refs/heads/feature\n");
    await writeFile(join(ws, "a.txt"), "v2");
    await cp.save("t2");
    await cp.restore(id1);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("v1");
    expect(await readFile(join(ws, ".git", "HEAD"), "utf8")).toContain("feature"); // 没被还原
  });

  it("restore 拒绝形状非法的 id（防手滑，也防未来把用户输入接进来）", async () => {
    const cp = cap();
    await expect(cp.restore("HEAD~3")).rejects.toThrow(/非法/);
    await expect(cp.restore("main; rm -rf /")).rejects.toThrow(/非法/);
  });

  it("workspaceStoreName：稳定、且不同工作区不同名", () => {
    expect(workspaceStoreName("/a/b")).toBe(workspaceStoreName("/a/b"));
    expect(workspaceStoreName("/a/b")).not.toBe(workspaceStoreName("/a/c"));
    expect(workspaceStoreName("/a/b")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("sessionCheckpointStoreName：同工作区不同会话不同仓,且带工作区前缀", () => {
    const a = sessionCheckpointStoreName("/a/b", "s-20260826-abcd1234");
    const b = sessionCheckpointStoreName("/a/b", "s-20260826-ffff0000");
    expect(a).not.toBe(b);
    expect(a.startsWith(workspaceStoreName("/a/b"))).toBe(true);
  });

  it("按会话拆仓(#573)：A 回退不吞 B 在 A 快照之后新建的文件", async () => {
    // Default 工作区的场景:同一个 ws,两个会话各一份影子仓
    const capA = createShadowGitCheckpoints({ workspace: ws, gitDir: join(root, "shadow-A") });
    await writeFile(join(ws, "a.txt"), "A 的 v1");
    const id = await capA.save("A turn 1");
    await writeFile(join(ws, "a.txt"), "A 的 v2");
    await capA.save("A turn 2");
    // B 会话此后才新建自己的文件——它在 A 的仓里从没被跟踪过
    await writeFile(join(ws, "b.txt"), "B 的产出");
    await capA.restore(id);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("A 的 v1"); // A 自己的回退生效
    expect(await readFile(join(ws, "b.txt"), "utf8")).toBe("B 的产出"); // B 的新文件毫发无损
  });
});
