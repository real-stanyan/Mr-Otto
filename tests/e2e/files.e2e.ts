// Files 面板的端到端 —— 这一栏读代码验不了:IPC 通道真的接上了吗、树真的
// 按点击一层层展开吗(懒加载不是"先扫全树再显示一部分")、互斥真的把终端
// 关掉了吗。单测里这三件事全是被假 deps 顶住的。

import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";

test("#400 Files 面板:⌘⇧E 开、展开一层、点文件出预览、开终端把它互斥关掉", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  mkdirSync(join(ws, "src"));
  writeFileSync(join(ws, "src", "hello.ts"), "export const hello = 1\n");
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话好开文件面板");

    await win.keyboard.press("Meta+Shift+E");
    await expect(win.getByTestId("files-tree")).toBeVisible({ timeout: 20_000 });

    // 根目录列出来了:src 这个目录在
    const srcRow = win.locator('[data-testid="files-row"][data-rel="src"]');
    await expect(srcRow).toBeVisible();

    // 懒加载:没展开之前,子目录的内容根本没被请求过
    await expect(win.locator('[data-testid="files-row"][data-rel="src/hello.ts"]')).toHaveCount(0);
    await srcRow.click();
    const fileRow = win.locator('[data-testid="files-row"][data-rel="src/hello.ts"]');
    await expect(fileRow).toBeVisible();

    // 点文件出预览,内容是真读出来的
    await fileRow.click();
    await expect(win.getByTestId("files-preview")).toContainText("export const hello", { timeout: 10_000 });

    // 互斥:开终端,Files 面板整个消失
    await win.keyboard.press("Control+`");
    await expect(win.getByTestId("files-tree")).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.app.close();
  }
});
