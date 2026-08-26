// 会话重命名的真机验收：⋮ 菜单 → 重命名 → 输入新标题 → 保存 → 侧栏那行改名。
// 为什么值得单开一条：这颗菜单项原来调的是 window.prompt，而 Electron 的 prompt
// 是**抛异常**的（"prompt() is not supported."），点下去整条 onClick 半路夭折，
// 界面上什么都不发生 —— 门禁全绿、jsdom 里 prompt 又是存在的，只有真机能红。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

test("重命名：⋮ 菜单弹应用内输入框，保存后侧栏那行改名", async () => {
  const fake = await startFakeModel(() => ({ content: "收到。" }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "把 order detail 的字体调大");
    await expect(win.getByText("收到。")).toBeVisible({ timeout: 20_000 });

    const row = win.getByRole("listitem").filter({ has: win.getByRole("button", { name: "会话操作" }) });
    await expect(row).toHaveCount(1);
    // 假模型不产标题，侧栏那行退回工程文件夹名（`s.title ?? g.label`）——
    // 输入框预填的也该是这一个，用户看见什么就从什么改起
    await expect(row.getByText(basename(ws))).toBeVisible();

    await row.getByRole("button", { name: "会话操作" }).click();
    await win.getByRole("menuitem", { name: "重命名" }).click();

    // 对话框真的开了（prompt 抛异常的年代，这一步就已经不成立）
    const field = win.getByRole("textbox", { name: "新标题" });
    await expect(field).toBeVisible({ timeout: 10_000 });
    // 输入框预填当前标题：改名多数是小改，从零打起是白让人重敲一遍
    await expect(field).toHaveValue(basename(ws));

    // 空标题不给保存
    await field.fill("   ");
    await expect(win.getByRole("button", { name: "保存" })).toBeDisabled();

    await field.fill("订单详情字号");
    await win.getByRole("button", { name: "保存" }).click();

    await expect(field).toHaveCount(0, { timeout: 10_000 });
    await expect(row.getByText("订单详情字号")).toBeVisible();
    await expect(row.getByText(basename(ws), { exact: true })).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
