// "这个测试文件根本没被跑" 是所有失败形态里最贵的一种:它不红,它什么都不说。
//
// 起因是 issue #897 的另一半。那一半(node 版本不对导致 worker 崩)其实**会**让
// 退出码变 1,只是摘要行读起来像"几个用例挂了";挡它的是 scripts/check-node.mjs。
// 真正安静的是这一半:一个测试文件的名字没落进 vitest 的 include 里,于是它
// 一次都没跑过,而门禁全绿 —— 没有错误、没有 skip 计数、没有括号里的差值,
// 什么线索都不留。`.test.tsx` 那次(见 vitest.config.ts 的注释)正是这个形状:
// 在补上后缀之前,压根没有任何 .tsx 测试被执行过,而没有人发现。
//
// 判据取"这个文件 import 了 vitest":本仓的 vitest 没开 globals,所以任何真在写
// 断言的文件都必须显式 import 一次 —— 这让信号既准又难绕过。规则因此是一条:
// **tests/ 底下 import 了 vitest 的文件,要么是配置里点名的 setupFile,
// 要么必须落进 include。** tests/e2e/ 不必单列一条:那批走 playwright、不 import
// vitest,自然过关;而万一有人把一条 vitest 测试写进 e2e 目录(那里不在 gate 的
// include 里,ADR-0138),这条断言恰好把它接住。
//
// include / setupFiles 直接从 vitest.config.ts 读,不在这里抄一份:抄一份就会有
// 一天两边不一样,而不一样的那天,这条断言保护的正是"配置改了没人跟上"。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

const ROOT = resolve(__dirname, "..");
const TESTS = join(ROOT, "tests");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 只认 include 里实际用到的那点 glob 语法:`**` / `*` / `?`。够用,且一眼能看懂 */
function globToRe(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      out += "(?:[^/]*/)*"; // `**/` 连斜杠一起吃掉,这样 a/**/b 也匹配 a/b
      i += 2;
    } else if (c === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const include = (config.test?.include ?? []).map(globToRe);
// setupFiles 写成 "./tests/…" 或绝对路径都是合法的,归一化到和 rel 同一种形状再比,
// 否则 setup.ts 会被当成孤儿报出来 —— 那条报错说的是完全另一件事
const setupFiles = [config.test?.setupFiles ?? []]
  .flat()
  .map((f) => relative(ROOT, resolve(ROOT, String(f))).split("\\").join("/"));

describe("测试发现", () => {
  it("include 与 setupFiles 是从配置里读出来的,不是抄的", () => {
    // 读不到就说明 vitest.config.ts 的形状变了,下面那条断言会静默变成空跑
    expect(include.length).toBeGreaterThan(0);
    expect(setupFiles.length).toBeGreaterThan(0);
  });

  it("tests/ 里 import 了 vitest 的文件都在 include 里(否则它一次都不会跑,而门禁照样绿)", () => {
    const orphans = walk(TESTS)
      .map((p) => relative(ROOT, p).split("\\").join("/"))
      .filter((rel) => /(?:from|import)\s*\(?\s*["']vitest["']/.test(readFileSync(join(ROOT, rel), "utf8")))
      .filter((rel) => !setupFiles.includes(rel))
      .filter((rel) => !include.some((re) => re.test(rel)));

    expect(
      orphans,
      `这些文件 import 了 vitest,却不在 vitest.config.ts 的 include 里 —— 它们一次都不会被执行,` +
        `而门禁不会因此变红。改名成 *.test.ts / *.test.tsx(或把它挪出 tests/、` +
        `或显式加进 include),别让它们留在"看着像测试、其实从没跑过"的状态:\n` +
        orphans.map((f) => `  ${f}`).join("\n")
    ).toEqual([]);
  });
});
