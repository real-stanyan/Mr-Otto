// 同目录下的 TS 文件名，去掉扩展名之后不许只差大小写（issue #687）。
//
// 起因：tests/renderer/ 下同时有 McpDirectory.test.tsx（组件）和 mcpDirectory.test.ts
// （纯逻辑）。去扩展名后是 McpDirectory.test 与 mcpDirectory.test，只差首字母大小写。
// macOS 的 APFS 默认大小写不敏感，tsc 按规范化路径去重，两者撞成同一个键，.ts 的
// 扩展名优先级高于 .tsx，于是 .tsx 那份被**静默丢出 program**——本机 tsc 从头到尾
// 没检查过它。Linux 上文件名大小写敏感，两个键都在，CI 全检查。
//
// 后果不是"报错信息难看"，是**本机门禁与 CI 给出不同的答案**：往那个 .tsx 里塞一行
// const x: number = "nope"，本机一声不吭，推上去 CI 立刻红。AGENTS.md 门禁一节的
// 「CI == Gate contract」保的是"本机绿 ⇒ CI 绿"，这个前提在有碰撞时就不成立。
// 而 vitest 是按文件系统 glob 的，两个文件在盘上是真的两份，测试照跑——所以现象是
// 「测试都在跑，但其中一份从没过过本机的类型检查」，不会有人注意到。
//
// 光改名不够：下一个人再起一对同名文件就静默复发。这条断言是那次改名的保鲜期。
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
// mobile/ 有自己的 tsconfig 与 node_modules，不进根门禁（见根 tsconfig.json 的注释）
const SKIP = new Set(["node_modules", ".git", "out", "dist", "mobile", ".claude", ".worktrees"]);

/** 每个目录一张表：去扩展名的小写名 → 该目录下命中它的真实文件名 */
function collisionsUnder(dir: string): string[] {
  const found: string[] = [];
  const byStem = new Map<string, string[]>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) found.push(...collisionsUnder(join(dir, entry.name)));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const stem = entry.name.replace(/\.tsx?$/, "").toLowerCase();
    byStem.set(stem, [...(byStem.get(stem) ?? []), entry.name]);
  }
  for (const [, names] of byStem) {
    if (names.length > 1) found.push(`${relative(ROOT, dir) || "."}/ → ${names.join(" / ")}`);
  }
  return found;
}

describe("同目录 TS 文件名去扩展名后不撞大小写（issue #687）", () => {
  it("没有一对文件会在大小写不敏感的文件系统上互相遮蔽", () => {
    const collided = collisionsUnder(ROOT);
    expect(
      collided,
      collided.length === 0
        ? ""
        : "这两个文件在 macOS（大小写不敏感）上会被 tsc 当成同一个，.ts 留下、.tsx 被静默" +
          "丢出类型检查——本机门禁从此查不到它，CI 却查得到，两边答案不一样。改名消掉碰撞：" +
          `${collided.join("；")}`
    ).toEqual([]);
  });
});
