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

// 下面两条真起子进程、又要求「取得到 PATH」的用例，时限由这一对常量说了算（#1323）。
// 不显式传的话吃的是产品那条默认值（loginShellEnv.ts 的 `timeoutMs ?? 10_000`），而那个数
// 回答的是另一个问题——「shell 起不来多久算数」。608 个测试文件并行把 CPU 打满时，一个
// printf 脚本真的会超过 10 秒，超时**不抛、返回 null**（那是它对「shell 起不来」该有的
// 行为），于是断言看到的是 `expected null to be '/login/bin:/usr/bin'`：读起来像产品坏了，
// 实际是机器被压满了。这两条要验的是「取得到」，不是「10 秒之内取得到」。
//
// 两个数的大小顺序是要紧的、不是随手排的：PRIME_BUDGET_MS **必须大于** PRIME_IT_MS，
// 这样真挂住时先到的是 vitest 的「Test timed out」（说的正是「子进程没回来」），而不是
// 一个合法返回值 null。反过来排就把这条 issue 原样修回去了。
// 同族 #1249（tests/runtime/sessionService.test.ts 在满负载下偶发 5s 超时）。
const PRIME_BUDGET_MS = 30_000;
const PRIME_IT_MS = 20_000;

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
  // 大小顺序写成断言（量级本身不写，同 ADR-0236 第 1 条：那是会跟着机器变的数）。
  // 排反了不会有任何东西报错，只会让 #1323 那个「像产品坏了」的失败形态原样回来
  it("两条时限的顺序：产品那条预算要比 it 的时限大", () => {
    expect(PRIME_BUDGET_MS).toBeGreaterThan(PRIME_IT_MS);
  });

  it("拿到了：返回 PATH 且 loginShellPath() 从此读得到", async () => {
    const shell = fakeShell(
      `echo "some rc noise"\nprintf '%s' "__OTTO_PATH_START__/login/bin:/usr/bin__OTTO_PATH_END__"`
    );
    const got = await primeLoginShellPath({ shell, timeoutMs: PRIME_BUDGET_MS });
    expect(got, "null = 子进程没在预算内回话，多半是机器被压满了，不是解析挂了").toBe(
      "/login/bin:/usr/bin"
    );
    expect(loginShellPath()).toBe("/login/bin:/usr/bin");
  }, PRIME_IT_MS);

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
    await primeLoginShellPath({ shell, timeoutMs: PRIME_BUDGET_MS });
    const world = createLocalWorld();
    const res = await world.exec(`echo "[$PATH]"`);
    expect(res.stdout.trim()).toBe("[/primed/bin:/usr/bin:/bin]");
  }, PRIME_IT_MS);
});
