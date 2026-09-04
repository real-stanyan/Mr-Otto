// 工作区入口冒烟（Task 13，ADR-0198 收尾；入口位置改于 issue #917 / ADR-0217）。
//
// 现实检查：工作区功能过主进程打 Supabase——`workspaceManager` 未登录时统一
// 回 `{ ok:false, message:"还没登录" }`（`src/main/index.ts` 的 `NOT_SIGNED_IN`）。
// 但 e2e 的 `authRecord`（默认 true）只是喂一份 `auth.json` 让 app 越过
// SignInScreen 那道进门闸，不建立真实 Supabase session——`AccountManager.restore()`
// 是 fire-and-forget 的网络往返（`auth.getUser()`），这条用例不等它、也不该
// 等它：不碰网络是 harness.ts 顶部立的第一条规矩，e2e 的环境里也没有真的
// Supabase 凭据能让这次校验成功。所以 `account.signedIn` 在这条用例整个
// 生命周期里都是 false。
//
// 于是这一屏必然停在 `workspaceAccess` 的 signed_out 那一档（见
// src/renderer/src/lib/workspaceAccess.ts）：侧栏里没有工作区那一节（一条都
// 没有 + 没有错误 = 整节不出），「＋ 新工作区」照常在——它是常驻的发现入口，
// 点开告诉你为什么现在不行、并给一条出去的路。这两件事正是这条用例能诚实
// 断言的全部；建群 → 改名 → 贡献连接器 → 撤回的完整链路需要两个真实登录的
// 账号，走 docs/dev-two-accounts.md 手册手动验，不写进自动化。

import { expect, test } from "@playwright/test";

import { expectNoRendererErrors, launchOtto } from "./harness.js";

test("新工作区：未登录时弹窗说清为什么 + 给出去的路，关得掉也开得回来", async () => {
  const otto = await launchOtto();
  try {
    // 侧栏里没有工作区那一节：一条工作区都没有（也拉不到）时整节不渲染，
    // 段头「工作区」这三个字不该出现在侧栏里
    await expect(otto.win.getByRole("button", { name: "新工作区" })).toBeVisible({ timeout: 15_000 });

    await otto.win.getByRole("button", { name: "新工作区" }).click();
    const dialog = otto.win.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // signed_out 这一档：说的是「先登录」，不是「你没有订阅」——后者是一句
    // 这台机器根本没能力判断的话（billing 快照压根没查过）
    await expect(dialog.getByText("工作区跟着账号走——先登录才能建。")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "去登录" })).toBeVisible();
    // 名字输入框不该在：这一档没有「建」这个动作可给
    await expect(dialog.getByRole("textbox", { name: "工作区名称" })).toHaveCount(0);

    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog, "「取消」点了但弹窗还在").toHaveCount(0, { timeout: 5_000 });

    // 关掉之后还能再开：状态是真的翻回去了，不是把 DOM 抹了
    await otto.win.getByRole("button", { name: "新工作区" }).click();
    await expect(otto.win.getByRole("dialog")).toBeVisible({ timeout: 10_000 });

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
