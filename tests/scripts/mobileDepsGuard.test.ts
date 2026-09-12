// scripts/check-mobile-deps.mjs 的可执行版（#422，ADR-0293）。
//
// 它挡的是「手机端依赖没装」——那种失败会红，但红得像门禁自己坏了：
// npm 回一句 `sh: tsc: command not found` 加一串它自己的 error 栈，而真相是
// 这台机器还没 `npm --prefix mobile ci`。要钉的是三条：
//   1. 没装 → 退出 1，且**说得出去装哪一句**（一条无法执行的报错等于没报）；
//   2. 装了 → 放行（这道闸不该在正常仓库上说话）；
//   3. 它真的挂在 pretest 上——一个没人调用的检查等于没有这个检查。
// 照 gateNodeVersion.test.ts 的路子 spawn 真脚本：仓库根从 argv 传入，
// 不必挪动真的 node_modules。

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../..");
const SCRIPT = join(REPO, "scripts/check-mobile-deps.mjs");

function check(root: string): { code: number; err: string } {
  try {
    execFileSync(process.execPath, [SCRIPT, root], {
      cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, err: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? -1, err: err.stderr ?? "" };
  }
}

describe("门禁的手机端依赖闸", () => {
  it("没装的时候拦下，并且说清了修法", () => {
    const { code, err } = check(mkdtempSync(join(tmpdir(), "otto-mobile-deps-")));
    expect(code).toBe(1);
    expect(err).toContain("npm --prefix mobile ci"); // 唯一要人做的那件事
    expect(err).toContain("#422"); // 病根查得到，才不会被当成"又一个环境玄学"
  });

  it("装好的仓库放行", () => {
    expect(check(REPO).code).toBe(0);
  });

  it("真的挂在 pretest 上", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.pretest).toContain("scripts/check-mobile-deps.mjs");
    // 门禁的那一句本身：手机端类型检查串在 typecheck 末尾（AGENTS.md 门禁段说的三件事之一）
    expect(pkg.scripts.typecheck).toContain("npm --prefix mobile run typecheck");
  });
});
