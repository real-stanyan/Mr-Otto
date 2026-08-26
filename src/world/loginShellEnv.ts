// 登录 shell 的 PATH（issue #453）。
// Finder/Dock 起的 Electron 拿的是 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
// nvm / homebrew / .hermes 那些全不在——LocalWorld spawn 的子 shell 跑 npm 一律
// exit 127，模型得自己撞出来再补 export，每条命令白烧一两轮。
// 修法 = 业界常规（fix-path / shell-env 那一类）：启动时跑一次 `$SHELL -i -l -c`
// 把用户登录 shell 的 PATH 捞出来，缓存在模块级登记处，childEnv 起子进程时合并。
// 只在 app.isPackaged 时 prime（index.ts）：终端里 `npm run dev` 起的进程本来就
// 继承终端的 PATH，再跑一次 rc 纯付副作用。
//
// marker 包裹是必须的：`-i` 会跑用户的 rc，nvm/oh-my-zsh 往 stdout 打的噪音
// 和 PATH 混在一起，裸 echo 分不出来。取不到（shell 挂了/超时/没 marker）一律
// 返回 null——childEnv 维持原样继承，绝不比现状更糟。

import { spawn } from "node:child_process";

const START = "__OTTO_PATH_START__";
const END = "__OTTO_PATH_END__";

/** 从登录 shell 的 stdout 里捞 marker 包裹的 PATH；捞不到或是空串 = null。
    lastIndexOf：rc 里万一有人 echo 了同名字符串，最后一对才是我们自己 printf 的 */
export function parseLoginShellPath(stdout: string): string | null {
  const e = stdout.lastIndexOf(END);
  if (e === -1) return null;
  const s = stdout.lastIndexOf(START, e);
  if (s === -1) return null;
  const path = stdout.slice(s + START.length, e).trim();
  return path.length > 0 ? path : null;
}

/** 模块级登记处：app 一辈子 prime 一次，所有 LocalWorld 实例（每会话一个 +
    hookWorld）共读。与 secretEnv 的全局登记处同款形状 */
let cached: string | null = null;

export function loginShellPath(): string | null {
  return cached;
}

export function __resetLoginShellPathForTest(): void {
  cached = null;
}

/** 跑一次登录 shell 取 PATH 并缓存。失败（起不来/超时/解析不出）返回 null 且不动缓存。
    `-i -l` 分开传：zsh/bash 认 `-ilc` 连写，fish 不认。
    超时 SIGKILL：rc 里等输入的进程 SIGTERM 可能被 trap 吞掉 */
export async function primeLoginShellPath(
  opts: { shell?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const stdout = await new Promise<string>((done) => {
    const child = spawn(shell, ["-i", "-l", "-c", `printf '%s' "${START}$PATH${END}"`], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
    });
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      done(buf);
    };
    child.on("error", finish);
    // exit code 不看：rc 脚本最后一条命令非零会传染 shell 的退出码，
    // 但 printf 已经跑过了——marker 在不在说了算。
    // 也不等 close：rc 里起的后台进程（daemon/sleep）会抓着继承来的 stdout
    // 不放，close 可以永远不来；exit 后缓一个 tick 收掉在途数据就够了
    child.on("exit", () => setImmediate(finish));
    child.on("close", finish);
  });
  const parsed = parseLoginShellPath(stdout);
  if (parsed) cached = parsed;
  return parsed;
}
