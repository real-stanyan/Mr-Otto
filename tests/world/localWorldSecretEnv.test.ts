import { describe, it, expect, afterEach } from "vitest";
import { createLocalWorld } from "../../src/world/localWorld.js";

// issue #153：keyVault 把 API key 明文写进 process.env，而子进程默认整份继承——
// agent 的一句 `echo $DEEPSEEK_API_KEY` 就读到明文。这两组用例钉的是"摘掉的是
// 登记在案的那几个，别的一个不动"。
// 真起子进程，不打桩：这条不变量的落点就在 spawn 的 env 参数上，桩子测不出来。

const SECRET = "OTTO_TEST_SECRET_ENV";
const PLAIN = "OTTO_TEST_PLAIN_ENV";

afterEach(() => {
  delete process.env[SECRET];
  delete process.env[PLAIN];
});

const ptyLoadable = await import("node-pty").then(() => true).catch(() => false);

describe("LocalWorld.exec 不把凭据递给子进程", () => {
  it("登记在案的变量在子进程里是空的", async () => {
    process.env[SECRET] = "sk-should-not-leak";
    const world = createLocalWorld({ secretEnvNames: () => [SECRET] });
    const res = await world.exec(`echo "[$${SECRET}]"`);
    expect(res.stdout.trim()).toBe("[]");
    // 主进程自己那份没被动过——adapter 还要用它
    expect(process.env[SECRET]).toBe("sk-should-not-leak");
  }, 15_000);

  it("没登记的变量原样继承（PATH/nvm 那一类不能连坐）", async () => {
    process.env[PLAIN] = "keep-me";
    const world = createLocalWorld({ secretEnvNames: () => [SECRET] });
    const res = await world.exec(`echo "[$${PLAIN}]"`);
    expect(res.stdout.trim()).toBe("[keep-me]");
  }, 15_000);

  it("不给 secretEnvNames = 用全局登记处（此刻是空的，什么都不摘）", async () => {
    process.env[PLAIN] = "keep-me";
    const world = createLocalWorld();
    const res = await world.exec(`echo "[$${PLAIN}]"`);
    expect(res.stdout.trim()).toBe("[keep-me]");
  }, 15_000);
});

describe.skipIf(!ptyLoadable)("LocalWorld.openTerminal 不把凭据递给子 shell", () => {
  it("登记在案的变量在终端里是空的", async () => {
    process.env[SECRET] = "sk-should-not-leak";
    const world = createLocalWorld({ secretEnvNames: () => [SECRET] });
    const term = await world.openTerminal!({ cols: 80, rows: 24, shell: "/bin/sh" });
    let out = "";
    term.onData((d) => { out += d; });
    const exited = new Promise<number>((resolve) => term.onExit(resolve));
    // -c 不 source profile：测的是继承下来的那一份，不是 shell 自己补回来的
    term.write(`printf 'SECRET=[%s]\\n' "$${SECRET}"\nexit\n`);
    await exited;
    expect(out).toContain("SECRET=[]");
    expect(out).not.toContain("sk-should-not-leak");
  }, 15_000);

  it("TERM 照旧是 xterm-256color（摘凭据不该顺手改别的）", async () => {
    const world = createLocalWorld({ secretEnvNames: () => [SECRET] });
    const term = await world.openTerminal!({ cols: 80, rows: 24, shell: "/bin/sh" });
    let out = "";
    term.onData((d) => { out += d; });
    const exited = new Promise<number>((resolve) => term.onExit(resolve));
    term.write('printf "TERM=[%s]\\n" "$TERM"\nexit\n');
    await exited;
    expect(out).toContain("TERM=[xterm-256color]");
  }, 15_000);
});
