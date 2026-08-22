// tests/e2e/island.e2e.ts —— 岛窗起得来、置顶、主窗关了它还在。不在 gate 里
//
// 岛是 mac 上的第二个 BrowserWindow(ADR-0059)。它的三条命根子只有真跑起来
// 才看得见:窗建没建成、alwaysOnTop 生没生效、主窗关掉之后它还在不在 ——
// 最后这条尤其重要:主窗现在是"藏起来"而不是"关掉"(#175 I5),推送目标和
// "回主窗"这条路都还得是活的。
import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = join(ROOT, "out", "main", "index.js");

test.skip(process.platform !== "darwin", "灵动岛只在 mac");

test("岛窗存在、置顶、主窗关闭后仍在", async () => {
  expect(existsSync(MAIN), "先 npm run build —— e2e 跑的是 out/ 里的产物").toBe(true);

  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, OTTO_PROFILE: "e2e" } });
  const errors: string[] = [];
  try {
    await app.firstWindow();
    // 数窗口个数会先撞上"两个窗都建了但岛还没 load 完"的空档 —— 直接等那个
    // 标题出现,它才是"岛真的起来了"
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some((w) => w.getTitle().includes("Island"))
          ),
        { timeout: 20_000 }
      )
      .toBe(true);

    // 岛这一页的渲染层不能抛:它没有任何 UI 能报错,崩了就是一块不动的黑胶囊
    await expect.poll(() => app.windows().some((p) => p.url().includes("island")), { timeout: 20_000 }).toBe(true);
    const islandPage = app.windows().find((p) => p.url().includes("island"));
    islandPage?.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    islandPage?.on("console", (m) => {
      if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    });

    const info = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), top: w.isAlwaysOnTop() }))
    );
    expect(info.find((w) => w.title.includes("Island"))?.top).toBe(true);

    // 关主窗 = mac 惯例的"收起来":窗还在(推送目标、"回主窗"那条路都还有效),
    // 只是不可见。岛一动不动地继续工作
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => !w.getTitle().includes("Island"))?.close();
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const all = BrowserWindow.getAllWindows();
          const main = all.find((w) => !w.getTitle().includes("Island"));
          return {
            count: all.length,
            mainAlive: !!main,
            mainVisible: main?.isVisible() ?? null,
            islandVisible: all.find((w) => w.getTitle().includes("Island"))?.isVisible() ?? null,
          };
        })
      )
      // 两个窗都还在:主窗只是藏了(没 destroy),岛照旧在顶上
      .toEqual({ count: 2, mainAlive: true, mainVisible: false, islandVisible: true });

    await islandPage?.waitForTimeout(1000);
    expect(errors, `岛的渲染层有异常:\n  ${errors.join("\n  ")}`).toEqual([]);
  } finally {
    await app.close();
  }
});
