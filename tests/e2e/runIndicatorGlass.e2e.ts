// 运行指示条那块液态玻璃：机器判不了「好不好看」，但玻璃**没生效**是能判的 ——
// 而且这是这套做法唯一的失败模式：`backdrop-filter` 里但凡有一段解析不了
// （滤镜 id 带非法字符、贴图 data URI 没编码、SVG 没挂进文档），整条声明被
// 静默丢弃，画面只是"少了点材质"，控制台一个字都不会说。
//
// 所以这里断言三件事：类挂上了、backdrop-filter 里真的有 url(...) 那一段、
// 它指向的 <filter> 真的在文档里找得到。截图落 test-results/，人看一眼。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

test("运行指示条的液态玻璃：折射滤镜真的挂上了（不是被静默丢掉的那种）", async () => {
  // 一轮慢慢吐的正文 —— turn 得一直跑着，指示条才在场
  const fake = await startFakeModel(() => ({
    content: "慢慢想。".repeat(40),
    delayMs: 120,
  }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "跑一轮，看看运行指示条");

    const status = win.getByRole("status");
    await expect(status.first()).toBeVisible({ timeout: 20_000 });
    const glass = status.first().locator("xpath=ancestor::div[contains(@class,'liquid-glass')][1]");
    await expect(glass).toHaveCount(1);

    const probe = await glass.evaluate((el) => {
      const backdrop = getComputedStyle(el).backdropFilter;
      const id = /url\(["']?#([^"')]+)/.exec(backdrop)?.[1] ?? null;
      return {
        backdrop,
        filterFound: id === null ? false : el.ownerDocument.getElementById(id)?.tagName === "filter",
      };
    });
    expect(probe.backdrop, "backdrop-filter 整条被丢了（多半是滤镜 id 或贴图 URI 非法）")
      .toMatch(/url\(/);
    expect(probe.backdrop).toMatch(/blur\(/);
    expect(probe.filterFound, "url(#…) 指向的 <filter> 不在文档里").toBe(true);

    await win.screenshot({ path: join(ROOT, "test-results", "run-indicator-glass.png") });
  } finally {
    await otto.close();
    await fake.close();
  }
  expectNoRendererErrors(otto);
});
