// 门禁只跑 vitest（CI == Gate 契约），tsc 不在里面。所以「orb 尺寸必须是包支持的档位」
// 这条得由一个测试来守，否则它只活在类型层，CI 一次都不会检查。
//
// 背景（issue #51）：thinking-orbs 的预设表只有 20 和 64 两档，
// `size={16}` 在运行时取到 undefined 抛 TypeError，炸穿整棵 React 树 = 黑屏。
// 而包自带的 d.ts 在 nodenext 下解析不到（无扩展名的相对导出），
// 类型全成 any，tsc 当时一声没吭 —— 这个测试就是补那一声。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER = join(process.cwd(), "src/renderer/src");

/** thinking-orbs v0.3.1 只调了这两档；它们是两套独立设计，不是缩放系数 */
const SUPPORTED_SIZES = new Set(["20", "64"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("ThinkingOrb 尺寸", () => {
  it("渲染层里所有 size 都落在包支持的档位上", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(RENDERER)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<ThinkingOrb\b[^>]*?\bsize=\{(\d+)\}/g)) {
        if (!SUPPORTED_SIZES.has(m[1]!)) {
          bad.push(`${file.replace(process.cwd() + "/", "")}: size={${m[1]}}`);
        }
      }
    }
    // 失败时把违规处逐个列出来——只说"有错"等于让人再查一遍
    expect(bad).toEqual([]);
  });

  it("扫描本身是活的（找得到 ThinkingOrb 用法，别静默扫了个寂寞）", () => {
    const hits = sourceFiles(RENDERER)
      .map((f) => readFileSync(f, "utf8"))
      .join("")
      .match(/<ThinkingOrb\b/g);
    expect(hits?.length ?? 0).toBeGreaterThan(0);
  });
});
