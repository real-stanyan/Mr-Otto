// TS 源码里不许出现字面控制字符（NUL 尤其）（issue #841）。
//
// 起因：三个源码文件拿字面 NUL 字节当 map 键的分隔符（deltaCoalescer / proxyStore /
// useAttachmentUrls），于是 git 把整个文件当二进制：`git diff` 只剩一行
// 「Bin 12345 -> 12400 bytes」——没有行级 diff、没有逐行合并，两条 lane 同时改到
// proxyStore.ts 得到的是整文件冲突。这个错没有任何症状：tsc 与 vitest 全绿，唯一的
// 信号是 git diff 里那行 Bin。
//
// 修好后为什么还需要这条断言：源码里写一个字面 NUL 不会有任何人报错，下次复发只能
// 靠某个人碰巧 git diff 时多看一眼。运行时想要 NUL 请写转义（`"\\u0000"` 这六个字符）
// ——源文件是 ASCII，求值出来逐字节相同。
//
// 扫描范围与 caseCollision 同一张 SKIP 表：根门禁覆盖到的所有 .ts/.tsx（mobile/ 有
// 自己的 tsconfig 与 node_modules，不进根门禁）。多字节 UTF-8 的字节都 ≥ 0x80，
// 按 utf8 读成字符串再匹配 ASCII 区间的控制符不会误伤中文。
//
// **.md 是 #1251 加进来的**：写这条 issue 的那一班在 ADR 与 AGENTS.md 里讲「NUL 的转义
// 长什么样」，那几处当场写成了真 NUL——而 git 把 AGENTS.md 当二进制的代价比一个源码文件
// 更大（它是全仓唯一的规则来源，两条 lane 同时改它就是整文件冲突），当时这条断言正好
// 看不见 .md。文档里的控制字符没有任何正当用途：要讲转义就写转义。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
// mobile/ 有自己的 tsconfig 与 node_modules，不进根门禁（见根 tsconfig.json 的注释）
const SKIP = new Set(["node_modules", ".git", "out", "dist", "mobile", ".claude", ".worktrees"]);
// \t \n \r 之外的 C0 控制符 + DEL
const CONTROL_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function offendersUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) found.push(...offendersUnder(join(dir, entry.name)));
      continue;
    }
    if (!/\.(tsx?|md)$/.test(entry.name)) continue;
    const text = readFileSync(join(dir, entry.name), "utf8");
    const path = relative(ROOT, join(dir, entry.name));
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo += 1;
      if (CONTROL_CHAR.test(line)) found.push(`${path}:${lineNo}`);
    }
  }
  return found;
}

describe("源码与文档里没有字面控制字符（issue #841、#1251）", () => {
  it("没有任何 .ts/.tsx/.md 含 NUL 等控制字符", () => {
    const offenders = offendersUnder(ROOT);
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "字面控制字符会让 git 把整份文件当二进制——没有行 diff、没法逐行合并，且 tsc/vitest " +
          "全绿没有任何信号。请改用转义写法（如 `\\u0000`），运行时逐字节相同。命中：" +
          offenders.join("；")
    ).toEqual([]);
  });
});
