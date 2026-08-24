// files 列表的可执行契约（issue #312）。
//
// 背景：electron-builder 对「只含排除模式」的 fileset 会隐式补 **/*——
// 平台级 files 写成纯 !… 负模式列表时，「排除几个平台包」实际变成
// 「把整个仓库目录打进 asar」：v1.0.1 win 包因此 1.6GB（asar 3.0GB，
// 里面有 node_modules 全量、Swift 编译产物、.claude/worktrees、src、tests）。
//
// 所以：yml 里每个 files: 列表必须至少含一个正模式（不以 ! 开头的条目）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const yml = readFileSync(join(__dirname, "../../electron-builder.yml"), "utf8");

/**
 * 每个 files: 块的条目列表。yml 是扁平两级缩进，逐行状态机够用，不引 yaml 依赖：
 * 命中 files: 后收集后续更深缩进的 "- …" 行（跳过注释），缩进回落即块结束。
 */
function collectFilesBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = (lines[i] ?? "").match(/^(\s*)files:\s*$/);
    if (!head) continue;
    const indent = (head[1] ?? "").length;
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue; // 注释/空行不终结块
      const item = line.match(/^(\s*)- (.+?)\s*$/);
      if (!item || (item[1] ?? "").length <= indent) break;
      items.push((item[2] ?? "").replace(/^["']|["']$/g, ""));
    }
    blocks.push(items);
  }
  return blocks;
}

const blocks = collectFilesBlocks(yml);

describe("electron-builder files 模式", () => {
  it("yml 里真的解析到了 files 块（顶层 + mac + win）", () => {
    // 解析器失灵会让下面的断言空转——先保证块数符合现状
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const items of blocks) expect(items.length).toBeGreaterThan(0);
  });

  it("每个 files 列表至少含一个正模式，纯排除列表会触发隐式 **/*", () => {
    for (const items of blocks) {
      const positives = items.filter((p) => !p.startsWith("!"));
      expect(positives.length, `files 块「${items.join(", ")}」只有排除模式`).toBeGreaterThan(0);
    }
  });
});
