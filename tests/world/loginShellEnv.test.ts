import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLoginShellPath,
  primeLoginShellPath,
  loginShellPath,
  __resetLoginShellPathForTest,
} from "../../src/world/loginShellEnv.js";
import { createLocalWorld } from "../../src/world/localWorld.js";

// issue #453：Finder/Dock 起的 Electron 只有 launchd 的最小 PATH，LocalWorld
// spawn 出去的子 shell 找不到 npm/node（exit 127）。修法 = 启动时跑一次登录
// shell 取 PATH，缓存进 childEnv。这里钉三段：解析（rc 噪音里捞 marker）、
// 取值（真起子进程，含超时与失败路径）、注入（exec 的子进程真的看到新 PATH）。

afterEach(() => __resetLoginShellPathForTest());

/** 造一个假 "shell"：无视参数，按脚本内容输出。真 zsh 的 rc 不可控，测试不碰它 */
function fakeShell(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-fake-shell-"));
  const p = join(dir, "sh");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("parseLoginShellPath：从 rc 噪音里捞出 marker 包裹的 PATH", () => {
  it("噪音在前在后都不影响", () => {
    const out = "nvm loading...\n__OTTO_PATH_START__/a/bin:/usr/bin__OTTO_PATH_END__\ntrailing";
    expect(parseLoginShellPath(out)).toBe("/a/bin:/usr/bin");
  });

  it("没有 marker = null（别把整段 rc 输出当 PATH 用）", () => {
    expect(parseLoginShellPath("/a/bin:/usr/bin")).toBeNull();
    expect(parseLoginShellPath("")).toBeNull();
  });

  it("marker 里是空串 = null（空 PATH 比没有 PATH 更糟）", () => {
    expect(parseLoginShellPath("__OTTO_PATH_START____OTTO_PATH_END__")).toBeNull();
  });
});

describe("primeLoginShellPath：真起子进程取一次，缓存进模块级登记处", () => {
  it("拿到了：返回 PATH 且 loginShellPath() 从此读得到", async () => {
    const shell = fakeShell(
      `echo "some rc noise"\nprintf '%s' "__OTTO_PATH_START__/login/bin:/usr/bin__OTTO_PATH_END__"`
    );
    const got = await primeLoginShellPath({ shell });
    expect(got).toBe("/login/bin:/usr/bin");
    expect(loginShellPath()).toBe("/login/bin:/usr/bin");
  }, 15_000);

  it("shell 起不来：返回 null，登记处保持原样", async () => {
    const got = await primeLoginShellPath({ shell: "/no/such/shell" });
    expect(got).toBeNull();
    expect(loginShellPath()).toBeNull();
  }, 15_000);

  it("rc 挂住不退出：超时兜底，返回 null 而不是永远等", async () => {
    const shell = fakeShell("sleep 30");
    const got = await primeLoginShellPath({ shell, timeoutMs: 500 });
    expect(got).toBeNull();
    expect(loginShellPath()).toBeNull();
  }, 15_000);
});

describe("LocalWorld.exec 的子进程用登录 shell 的 PATH", () => {
  it("注入的 PATH 对子进程可见", async () => {
    const world = createLocalWorld({ loginPath: () => "/login/bin:/usr/bin:/bin" });
    const res = await world.exec(`echo "[$PATH]"`);
    expect(res.stdout.trim()).toBe("[/login/bin:/usr/bin:/bin]");
  }, 15_000);

  it("没取到（null）= 维持现状，原样继承主进程 PATH", async () => {
    const world = createLocalWorld({ loginPath: () => null });
    const res = await world.exec(`echo "[$PATH]"`);
    expect(res.stdout.trim()).toBe(`[${process.env.PATH}]`);
  }, 15_000);

  it("不传 loginPath = 用全局登记处（prime 过就生效）", async () => {
    const shell = fakeShell(
      `printf '%s' "__OTTO_PATH_START__/primed/bin:/usr/bin:/bin__OTTO_PATH_END__"`
    );
    await primeLoginShellPath({ shell });
    const world = createLocalWorld();
    const res = await world.exec(`echo "[$PATH]"`);
    expect(res.stdout.trim()).toBe("[/primed/bin:/usr/bin:/bin]");
  }, 15_000);
});
