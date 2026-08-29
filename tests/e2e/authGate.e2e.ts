// 进门那道闸（issue #723 / ADR-0182）：没有登录记录的人只看得到登录页。
//
// 两条断言各挡一个方向的回归，缺一不可：
//   1. 没记录 → 登录屏在，而**里面的东西一个都不在**（侧栏那几颗常驻按钮是最好的
//      探针：它们在 app 的任何页面都渲染，包括设置页和欢迎页）。只断言"登录卡看得见"
//      是不够的 —— 把登录卡叠在 app 上面也能过，那不叫闸。
//   2. 有记录 → 登录屏不在。这一条挡的是"闸门一收紧就把老用户也关在外面"，
//      也顺带说明 harness 默认播的那条记录确实起作用（33 条既有用例全靠它）。

import { expect, test } from "@playwright/test";
import { join } from "node:path";

import { ROOT, expectNoRendererErrors, launchOtto } from "./harness.js";

test("没有登录记录：只看得到登录页，app 本体一处都摸不到", async () => {
  const otto = await launchOtto({ authRecord: false });
  try {
    await expect(otto.win.getByTestId("sign-in-screen")).toBeVisible({ timeout: 20_000 });
    await expect(otto.win.getByRole("button", { name: "用 Google 登录" })).toBeVisible();
    await expect(otto.win.getByPlaceholder("邮箱")).toBeVisible();

    // 侧栏常驻的两颗：在 app 里的任何一页都有，所以它们不在 = 里面的树根本没挂
    await expect(otto.win.getByRole("button", { name: "设置" }), "登录屏底下不该还挂着 app 的树").toHaveCount(0);
    await expect(otto.win.getByRole("button", { name: "好友" })).toHaveCount(0);

    // 留一张给人看的：这一屏的材质（dither 背景 + 半透明卡）没有断言能替代，
    // 同 splash.e2e.ts 的做法
    await otto.win.screenshot({ path: join(ROOT, "test-results", "sign-in.png") });

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("有登录记录：直接进 app，不闪登录页", async () => {
  const otto = await launchOtto();
  try {
    await expect(otto.win.getByRole("button", { name: "设置" })).toBeVisible({ timeout: 20_000 });
    await expect(otto.win.getByTestId("sign-in-screen")).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
