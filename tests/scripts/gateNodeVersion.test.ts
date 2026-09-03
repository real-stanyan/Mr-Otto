// scripts/check-node.mjs 的可执行版(issue #897)。
//
// 它挡的是"门禁跑在错版本 node 上"——那种失败会红,但红得像代码有问题
// (摘要行写 "Test Files 370 passed (403)",而真相是 50 个文件一条没跑)。
// 所以要钉的不只是"低版本会退出 1",还有两条更容易坏的:
//   1. 认不出的版本号**不拦**——拦了就是某天 node 改版本号格式时整条门禁锁死;
//   2. 它真的挂在 pretest 上——一个没人调用的检查等于没有这个检查。
//
// 照 laneTooling.test.ts 的路子 spawn 真脚本:脚本是 .mjs,从 TS 里 import 会撞 allowJs,
// 走子进程也更接近它实际被调用的样子。版本从 argv 传入,不必伪造一个 node 进程。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../..");
const SCRIPT = join(REPO, "scripts/check-node.mjs");

function check(version?: string): { code: number; err: string } {
  try {
    execFileSync(process.execPath, version === undefined ? [SCRIPT] : [SCRIPT, version], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, err: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? -1, err: err.stderr ?? "" };
  }
}

describe("门禁的 node 版本闸", () => {
  it("node 20 被拦下,并且说清了修法", () => {
    const { code, err } = check("20.20.2");
    expect(code).toBe(1);
    expect(err).toContain("20.20.2");
    expect(err).toContain("nvm use 24");
    expect(err).toContain("#897"); // 病根查得到,才不会被当成"又一个 flaky"
  });

  it("v 前缀与刚好在门槛上的版本都放行", () => {
    expect(check("v22.0.0").code).toBe(0);
    expect(check("24.1.0").code).toBe(0);
  });

  it("认不出的版本号不拦人", () => {
    // 拦住 = 某天 node 换了版本号形状,门禁在一个完全健康的运行时上锁死
    expect(check("weird").code).toBe(0);
    expect(check("").code).toBe(0);
  });

  it("当前跑门禁的这个 node 自己过得去", () => {
    expect(check().code).toBe(0);
  });

  it("真的挂在 pretest 上,而且 engines 也声明了下限", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      engines?: { node?: string };
    };
    expect(pkg.scripts.pretest).toContain("scripts/check-node.mjs");
    expect(pkg.engines?.node).toBe(">=22");
  });
});
