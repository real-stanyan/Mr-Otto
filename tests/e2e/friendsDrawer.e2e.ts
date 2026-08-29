// 好友抽屉开得了、关得掉（issue #713）。
//
// 起因是一次假警报：dev 里热更新过 FriendsSection.tsx 之后，右上角那个 ✕ 点了没反应；
// 重启 dev 就好了——vaul 的抽屉是 portal 出去的，HMR 之后可能留着一份失效的处理器。
// 代码本身没问题，这条用例第一次跑（干净构建）就是绿的。
//
// 留着它不是为了那个不存在的 bug，是因为这条路此前一个断言都没有：✕ 是这个面板
// 唯一常驻的出口（点外面和 Esc 是 vaul 自带的，坏了也不归本仓管），而它一旦坏掉，
// 表现就是"面板关不掉"——用户只能重启 app。未登录态就能验，不需要账号。

import { expect, test } from "@playwright/test";

import { expectNoRendererErrors, launchOtto } from "./harness.js";

test("好友抽屉：点开、✕ 关得掉", async () => {
  const otto = await launchOtto();
  try {
    const close = otto.win.getByRole("button", { name: "关闭好友面板" });

    await otto.win.getByRole("button", { name: "好友" }).click();
    await expect(close).toBeVisible({ timeout: 15_000 });

    await close.click();
    await expect(close, "✕ 点了但面板还在——这个面板就没有别的出口了").toHaveCount(0, {
      timeout: 5_000,
    });

    // 关掉之后还能再开：状态是真的翻回去了，不是把 DOM 抹了
    await otto.win.getByRole("button", { name: "好友" }).click();
    await expect(close).toBeVisible({ timeout: 10_000 });

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
