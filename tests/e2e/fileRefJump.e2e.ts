// 正文里的「文件:行号」→ 点开 → 面板滚到那一行。
//
// 为什么单测不够:这条功能横跨四层——rehype 插件造节点、streamdown 的消毒管线
// 让不让这些节点活着、store 把路径削成工作区相对、Files 面板读文件后能不能找到
// 第 N 行。前三层各有单测,但"点了到底跳没跳"只有真跑一遍才知道;尤其是消毒那层,
// 削掉 data-file-ref 的话所有单测照样全绿,界面上却是一段普通文字。

import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

test("#449 模型提到 src/hello.ts:2 → 正文里可点 → Files 面板滚到第 2 行并高亮", async () => {
  const fake = await startFakeModel(() => ({
    content: "问题在 src/hello.ts:2 那一行,常量写反了。",
  }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  mkdirSync(join(ws, "src"));
  writeFileSync(join(ws, "src", "hello.ts"), "export const one = 1\nexport const two = 2\n");
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话");

    const composer = win.getByRole("textbox", { name: /输入消息/ });
    await composer.fill("看看那个常量");
    await composer.press("Enter");

    // ① 正文里那段路径真的成了一枚可点的东西(不是一段普通文字)
    const chip = win.getByTestId("file-ref").filter({ hasText: "src/hello.ts:2" }).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });

    // ② 点它:Files 面板开、文件读出来
    await chip.click();
    const preview = win.getByTestId("files-preview");
    await expect(preview).toContainText("export const two", { timeout: 20_000 });

    // ③ 高亮落在第 2 行 —— 落在别的行比不落更糟(读者会跟着看错地方)
    const hit = preview.locator(".code-line-hit");
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveAttribute("data-line", "2");
    await expect(hit).toContainText("export const two");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
