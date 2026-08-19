import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld } from "../../src/world/localWorld.js";

// node-pty 是原生模块:跑过 electron-rebuild 之后它只认 Electron 的 ABI,
// Node 侧的 vitest 就加载不了了(better-sqlite3 同款处境)。
// 那种情况下跳过这一组,而不是让门禁变红——门禁该测的是我们的代码,
// 不是"此刻装的这份原生模块编给了谁"。假 pty 的单测(Task 3)照常保护逻辑。
const ptyLoadable = await import("node-pty").then(() => true).catch(() => false);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otter-pty-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!ptyLoadable)("LocalWorld.openTerminal（真 PTY）", () => {
  it("跑一条命令，拿得到输出和退出码", async () => {
    const world = createLocalWorld({ root });
    const term = await world.openTerminal!({ cols: 80, rows: 24, shell: "/bin/sh" });

    let out = "";
    term.onData((d) => { out += d; });
    const exited = new Promise<number>((resolve) => term.onExit(resolve));

    term.write("echo otter-pty-ok\n");
    term.write("exit\n");

    const code = await exited;
    expect(out).toContain("otter-pty-ok");
    expect(code).toBe(0);
  }, 15_000);

  it("cwd 是工程文件夹", async () => {
    const world = createLocalWorld({ root });
    const term = await world.openTerminal!({ cols: 80, rows: 24, shell: "/bin/sh" });
    let out = "";
    term.onData((d) => { out += d; });
    const exited = new Promise<number>((resolve) => term.onExit(resolve));
    term.write("pwd\nexit\n");
    await exited;
    // macOS 的 /var 是 /private/var 的软链,tmpdir 两种写法都可能出现
    expect(out).toContain(root.replace(/^\/private/, ""));
  }, 15_000);

  it("kill 杀得掉常驻进程", async () => {
    const world = createLocalWorld({ root });
    const term = await world.openTerminal!({ cols: 80, rows: 24, shell: "/bin/sh" });
    const exited = new Promise<number>((resolve) => term.onExit(resolve));
    term.write("sleep 60\n");
    term.kill();
    await expect(exited).resolves.toBeTypeOf("number");
  }, 15_000);
});
