// AGENTS.md 的 Hard rules 从"写在文档里"变成"跑在门禁里"(Harness Engineering:
// 架构约束要变成可执行检查,错误信息要带修法,不只是指出违规)。
//
// 四条边界,前三条是 AGENTS.md 原文,第四条是 ADR-0064 落下来的分层约束:
//   1. 工具实现只依赖 ExecutionWorld 接口,禁止直接 import fs / child_process
//   2. 渲染进程只通过 ShellBridge 与后端通信,禁止直接触碰 Node API
//   3. @modelcontextprotocol/sdk 只允许 src/main/mcpClient.ts import(ADR-0050)
//   4. src/loop 不 import src/main —— turn 循环是纯逻辑层,装配(型号 id、便宜模型
//      通道、设置文件路径)是 main 的事(ADR-0064 的微压缩就踩在这条线上)
//
// 纯 grep 级:读源码文本找 import 语句,不做 AST。简单到一眼能看懂,也够用——
// 这里挡的是"顺手"犯的错,不是刻意绕过。

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

function offenders(dir: string, banned: (spec: string) => boolean): string[] {
  return walk(dir)
    .filter((f) => imports(f).some(banned))
    .map((f) => relative(ROOT, f));
}

const NODE_FS_OR_PROC = (s: string) =>
  /^(node:)?(fs|fs\/promises|child_process)$/.test(s);
const NODE_BUILTIN = (s: string) =>
  s.startsWith("node:") ||
  /^(fs|path|os|child_process|crypto|net|http|https|stream|util|events|electron)(\/|$)/.test(s);

describe("Hard rules(AGENTS.md)是门禁的一部分", () => {
  it("src/tools 不直接 import fs / child_process —— 工具只依赖 ExecutionWorld", () => {
    const bad = offenders(join(ROOT, "tools"), NODE_FS_OR_PROC);
    expect(
      bad,
      `这些工具直接碰了 Node fs/child_process:\n  ${bad.join("\n  ")}\n` +
        "修法:改走传进来的 world(world.fs.read / world.exec),让 LocalWorld 去碰真 fs;" +
        "需要新能力就在 src/world/executionWorld.ts 加接口,而不是绕过它"
    ).toEqual([]);
  });

  it("src/renderer 不 import Node/Electron 模块 —— 只走 window.otter(ShellBridge)", () => {
    const bad = offenders(join(ROOT, "renderer"), NODE_BUILTIN);
    expect(
      bad,
      `渲染层这些文件直接 import 了 Node/Electron 模块:\n  ${bad.join("\n  ")}\n` +
        "修法:把那段逻辑搬进主进程,在 src/shared/shellBridge.ts 加一条方法," +
        "src/preload 暴露、src/main/index.ts 实现,渲染层调 window.otter.xxx()"
    ).toEqual([]);
  });

  it("src/loop 不 import src/main —— 循环是纯逻辑,装配留给 main", () => {
    const bad = offenders(join(ROOT, "loop"), (s) => /^(\.\.\/)+main(\/|$)/.test(s));
    expect(
      bad,
      `src/loop 这些文件反向依赖了主进程:\n  ${bad.join("\n  ")}\n` +
        "修法:把那个常量/能力做成参数,由 src/main/index.ts 装配时注入" +
        "(如微压缩的 MICRO_MODEL 与 cheapAdapter,见 ADR-0064);" +
        "loop 只该依赖 session / model / shared / world"
    ).toEqual([]);
  });

  it("@modelcontextprotocol/sdk 只有 src/main/mcpClient.ts 能 import(ADR-0050)", () => {
    const bad = offenders(ROOT, (s) => s.startsWith("@modelcontextprotocol/")).filter(
      (f) => f !== "main/mcpClient.ts"
    );
    expect(
      bad,
      `这些文件越过 mcpClient 直接用了 MCP SDK:\n  ${bad.join("\n  ")}\n` +
        "修法:需要的能力加到 src/main/mcpClient.ts 的导出里,其它地方只依赖那层包装"
    ).toEqual([]);
  });
});
