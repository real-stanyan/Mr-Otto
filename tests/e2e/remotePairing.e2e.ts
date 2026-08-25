// 「手机」栏目的真机验收。
//
// 这一页有一件事只有在真 Electron 里才成立:身份私钥进 safeStorage
// (macOS 上就是钥匙串托管的密钥)。单测里那是一个注入的假实现,
// 这里跑的是真的 —— 开着 OTTO_REMOTE=1 还能把页面渲染出来,
// 就说明 openIdentityStore 在这台机器上真的拿到了系统封装。

import { expect, test } from "@playwright/test";
import { expectNoRendererErrors, launchOtto, openSettings, type Otto } from "./harness.js";

test("没开开关时：说清楚是没开，而不是空列表", async () => {
  let otto: Otto | null = null;
  try {
    otto = await launchOtto();
    await openSettings(otto.win, "手机");
    await expect(otto.win.getByText("远程功能没有开启")).toBeVisible();
    expectNoRendererErrors(otto);
  } finally {
    await otto?.close();
  }
});

test("OTTO_REMOTE=1：真机上拿得到系统封装，页面讲清楚要核对安全码", async () => {
  let otto: Otto | null = null;
  try {
    otto = await launchOtto({ env: { OTTO_REMOTE: "1" } });
    await openSettings(otto.win, "手机");

    // 这一条同时是 openIdentityStore 的真机断言:safeStorage 不可用的话
    // 页面会是「这台机器没有可用的系统安全存储」
    await expect(otto.win.getByText("配对前先核对安全码")).toBeVisible();
    await expect(otto.win.getByText("这台机器没有可用的系统安全存储")).toHaveCount(0);

    // 没登录 → 目录读不出任何设备,空态要有交代而不是一片白
    await expect(otto.win.getByText("还没有手机登记到这个账号")).toBeVisible();
    expectNoRendererErrors(otto);
  } finally {
    await otto?.close();
  }
});
