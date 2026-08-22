// 冒烟:真 Electron 起得来、窗口画得出、渲染层没抛异常。
//
// 这是仓库第三层验证(端到端)的最小一格 —— 前两层(tsc / vitest)看不见
// 渲染进程崩没崩、preload 桥接通没通、原生模块在 Electron 的 Node 里加载正不正常。
// 四条「真机验收」欠账(#123 #142 #147 #169)的根因就是没有这一层(ADR-0058)。
//
// 不在 gate 里:要先 build,十几秒起步;GUI 改动的 PR 贴它的输出。
// 不碰模型、不碰网络:用独立 profile(OTTO_PROFILE=e2e → userData 是 mr-otto-e2e),
// 跑多少次都不污染日常那份数据。

import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = join(ROOT, "out", "main", "index.js");

test("app 起来、窗口有内容、渲染层零异常", async () => {
  expect(existsSync(MAIN), "先 npm run build —— e2e 跑的是 out/ 里的产物").toBe(true);

  // 传仓库根而不是 out/main/index.js:Electron 读 package.json 的 main 去找入口,
  // app.getAppPath() 才是根目录(和 npm run dev / 打包后一致);直接传 index.js
  // 的话 getAppPath 是 out/main,resources/ 之类按根目录拼的路径全部落空
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, OTTO_PROFILE: "e2e" },
  });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    win.on("console", (m) => {
      if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    });

    await win.waitForLoadState("domcontentloaded");
    // React 挂上了:根节点下有东西,不是白屏
    await expect(win.locator("#root > *").first()).toBeVisible({ timeout: 20_000 });
    // 桥接通了:渲染层能摸到 window.otter(ShellBridge 是唯一通道)
    const bridged = await win.evaluate(
      () => typeof (window as unknown as { otter?: unknown }).otter === "object"
    );
    expect(bridged, "window.otter 不在 —— preload 没装上或 contextBridge 没暴露").toBe(true);
    // 给异步报错一点时间浮上来
    await win.waitForTimeout(1500);
    expect(errors, `渲染层有异常:\n  ${errors.join("\n  ")}`).toEqual([]);
  } finally {
    await app.close();
  }
});
