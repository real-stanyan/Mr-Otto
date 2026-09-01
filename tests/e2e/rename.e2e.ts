// 会话重命名的真机验收：⋮ 菜单 → 重命名 → 输入新标题 → 保存 → 侧栏那行改名。
// 为什么值得单开一条：这颗菜单项原来调的是 window.prompt，而 Electron 的 prompt
// 是**抛异常**的（"prompt() is not supported."），点下去整条 onClick 半路夭折，
// 界面上什么都不发生 —— 门禁全绿、jsdom 里 prompt 又是存在的，只有真机能红。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

/** 这句话本身就是这条用例的初始标题基线（见下方大注释）——单独提出来，
    免得 startSession() 那句和三处断言各写一份，改一处忘一处 */
const FIRST_MESSAGE = "把 order detail 的字体调大";

test("重命名：⋮ 菜单弹应用内输入框，保存后侧栏那行改名", async () => {
  const fake = await startFakeModel(() => ({ content: "收到。" }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, FIRST_MESSAGE);
    await expect(win.getByText("收到。")).toBeVisible({ timeout: 20_000 });

    const row = win.getByRole("listitem").filter({ has: win.getByRole("button", { name: "会话操作" }) });
    await expect(row).toHaveCount(1);
    // 标题是日志投影，不是模型产物：renamed || autotitled || 首条 user_message 首行
    // （src/session/store.ts:483，App.tsx:1789 同一句话）。会话一开就有第一条消息，
    // 这一支必中——工程文件夹名那个 fallback 只对「从没发过话」的会话生效，
    // startSession() 一定先发一条消息，那个分支根本到不了。
    // 假模型不产 autotitle 是真的，但标题不等模型，侧栏这行此刻显示的就是刚发的这句话，
    // 输入框预填的也该是它
    await expect(row.getByText(FIRST_MESSAGE)).toBeVisible();

    await row.getByRole("button", { name: "会话操作" }).click();
    await win.getByRole("menuitem", { name: "重命名" }).click();

    // 对话框真的开了（prompt 抛异常的年代，这一步就已经不成立）
    const field = win.getByRole("textbox", { name: "新标题" });
    await expect(field).toBeVisible({ timeout: 10_000 });
    // 输入框预填当前标题：改名多数是小改，从零打起是白让人重敲一遍
    await expect(field).toHaveValue(FIRST_MESSAGE);

    // 空标题不给保存
    await field.fill("   ");
    await expect(win.getByRole("button", { name: "保存" })).toBeDisabled();

    await field.fill("订单详情字号");
    await win.getByRole("button", { name: "保存" }).click();

    await expect(field).toHaveCount(0, { timeout: 10_000 });
    await expect(row.getByText("订单详情字号")).toBeVisible();
    await expect(row.getByText(FIRST_MESSAGE, { exact: true })).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
