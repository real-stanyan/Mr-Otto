// services/edge/src/** 不许 import node:* —— 那个目录跑在 workerd 里，开 nodejs_compat
// 的代价是整层 Node 兼容（ADR-0203 已知未做；规矩要有测试守，ADR-0173 的先例）。
// 唯一的例外是 src/worker.ts：它是装配层，import cloudflare:workers 与 wrangler 类型，
// 本来就不在「纯函数、跑在根门禁里」那一侧。Node 侧测试与工具（本目录）不在此限。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const EDGE_SRC = join(ROOT, "services/edge/src");
/** worker.ts 是装配层：它 import cloudflare:workers，本来就不适用「纯 Web 平台 API」这条 */
const EXEMPT = new Set(["worker.ts"]);

const NODE_IMPORT = /(?:from|import)\s*["']node:/;

function offenders(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...offenders(p)); continue; }
    if (!/\.ts$/.test(entry.name) || EXEMPT.has(entry.name)) continue;
    if (NODE_IMPORT.test(readFileSync(p, "utf8"))) out.push(relative(ROOT, p));
  }
  return out;
}

describe("services/edge/src 不 import node:*（ADR-0203 已知未做，#859）", () => {
  it("纯文件（worker.ts 以外）只用 Web 平台 API", () => {
    const bad = offenders(EDGE_SRC);
    expect(
      bad,
      bad.length === 0
        ? ""
        : "这些 edge 纯文件 import 了 node:* —— 它们跑在 workerd 里（root vitest 也直接跑它们），" +
          "要 node 内建模块就得开 nodejs_compat，那是为一处方便拉进整层 Node 兼容。" +
          "改用 Web 平台 API（crypto.subtle / TextEncoder / fetch…），或把这段挪进 worker.ts：" +
          bad.join("；")
    ).toEqual([]);
  });
});
