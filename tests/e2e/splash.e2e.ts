// 启动画面:起来时盖在最上面、进度条在走、boot 完 + 最短停留后自己退场,
// 且 WebGL shader 编译不报错(DitherBackground 编译失败走 console.error,这里会红)。

import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = join(ROOT, "out", "main", "index.js");

test("启动画面:出现、走进度、退场、零异常", async () => {
  expect(existsSync(MAIN), "先 npm run build —— e2e 跑的是 out/ 里的产物").toBe(true);
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, OTTO_PROFILE: "e2e" } });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    win.on("console", (m) => {
      if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    });
    await win.waitForLoadState("domcontentloaded");

    const splash = win.getByTestId("splash");
    await expect(splash).toBeVisible({ timeout: 20_000 });
    await expect(splash.getByRole("progressbar")).toBeVisible();
    await win.screenshot({ path: join(ROOT, "test-results", "splash.png") });

    // 最短停留 1.2s + 淡出 0.36s,之后必须从 DOM 里消失(不是 opacity:0 留着挡点击)
    await expect(splash).toHaveCount(0, { timeout: 10_000 });
    await expect(win.locator("#root > *").first()).toBeVisible();
    await win.waitForTimeout(500);
    expect(errors, `渲染层有异常:\n  ${errors.join("\n  ")}`).toEqual([]);
  } finally {
    await app.close();
  }
});
