// tests/e2e/island.e2e.ts —— 岛窗起得来、置顶、主窗关了它还在。不在 gate 里
import { _electron as electron, expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test.skip(process.platform !== "darwin", "灵动岛只在 mac");

test("岛窗存在、置顶、主窗关闭后仍在", async () => {
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, OTTO_PROFILE: "e2e" } });
  try {
    await app.firstWindow();
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(2);
    const info = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), top: w.isAlwaysOnTop() }))
    );
    const island = info.find((w) => w.title.includes("Island"));
    expect(island?.top).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => !w.getTitle().includes("Island"))?.close();
    });
    await expect.poll(() => app.windows().length).toBe(1);
  } finally {
    await app.close();
  }
});
