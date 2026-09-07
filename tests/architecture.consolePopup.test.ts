// 「可执行保鲜期」守卫（issue #1027）：win32 的 GUI 进程起 console 子系统程序会弹
// cmd 黑框，修法是每个 child_process 调用点带上 windowsHide（与 detached 互斥的
// 那一对收口在 src/shared/childProcess.ts 的 consoleSafeSpawnOpts，MSDN/ADR-0163）。
// 改一遍现有调用点不够——下一次有人顺手 spawn 一个命令时，黑框就回来了，而这个
// 失败模式在 mac 开发机上**没有任何症状**。这里把「import 了 node:child_process
// 就必须表态」钉成会红的规则。
//
// 形状与 tests/architecture.test.ts 同款：纯 grep 级（读源码文本找 import 语句，
// 不做 AST），挡的是"顺手"犯的错。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 文件里所有 import/require 的模块说明符 */
function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  const re = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[1]!);
  return specs;
}

const CHILD_PROCESS = (s: string) => /^(node:)?child_process$/.test(s);

/** 显式允许清单：不加 windowsHide 的理由写在条目里，新增条目必须写理由 */
const ALLOWED = new Set([
  "main/index.ts", // 只起 mac-only 的子进程（island bridge / simctl / ps），win32 走不到
  "main/updaterHost.ts", // ADR-0163：故意 detached 起 NSIS 安装器，windowsHide 与它互斥
]);

describe("child_process 调用点都表过态（#1027）", () => {
  it("import 了 node:child_process 的文件，要么用 consoleSafeSpawnOpts / windowsHide，要么在允许清单里", () => {
    const bad = walk(ROOT)
      .filter((f) => imports(f).some(CHILD_PROCESS))
      .filter((f) => !ALLOWED.has(relative(ROOT, f)))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return !src.includes("consoleSafeSpawnOpts") && !src.includes("windowsHide");
      })
      .map((f) => relative(ROOT, f));
    expect(
      bad,
      `这些文件 import 了 node:child_process，但既没有 consoleSafeSpawnOpts / windowsHide，也不在允许清单里:\n  ${bad.join("\n  ")}\n` +
        "修法：spawn/execFile 的选项里加 windowsHide:true；要 detached 的话改用" +
        "...consoleSafeSpawnOpts()（win32 上两者互斥，见 src/shared/childProcess.ts 文件头）。" +
        "确实不该加的（如 mac-only 路径），连同理由加进本用例的 ALLOWED 清单"
    ).toEqual([]);
  });
});
