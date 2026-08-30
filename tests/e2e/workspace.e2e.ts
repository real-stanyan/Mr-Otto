// 工作区抽屉冒烟（Task 13，ADR-0198 收尾）。
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
// `WorkspacesPanel`（`embedded` 分支）据此提前返回一句静态文案「登录后可用」
// （见 WorkspacesPanel.tsx 的 `if (!account.signedIn) return ...`），连
// 输入框都不渲染，也不会调用 `refreshWorkspaceGroups`——建群 / 贡献连接器 /
// 撤回这些交互单实例、不登录压根摸不到，「还没登录」这句 IPC 错误文案也就
// 没有机会出现在这个面板里（它会先被静态文案挡住）。
//
// 所以单实例诚实能验的只有：抽屉开得了、未登录态渲染这句文案而不是崩溃、
// ✕ 关得掉、再开一次状态还在。建群 → 改名 → 贡献连接器（含「以你的身份」
// 那句确认文案）→ 撤回的完整链路需要两个真实登录的账号，走
// docs/dev-two-accounts.md 手册手动验，不写进自动化。

import { expect, test } from "@playwright/test";

import { expectNoRendererErrors, launchOtto } from "./harness.js";

test("工作区抽屉：未登录态渲染不崩，开得了关得掉", async () => {
  const otto = await launchOtto();
  try {
    const close = otto.win.getByRole("button", { name: "关闭工作区面板" });

    await otto.win.getByRole("button", { name: "工作区" }).click();
    await expect(close).toBeVisible({ timeout: 15_000 });

    // 未登录（account.signedIn 为假）：面板提前返回静态文案，不发任何工作区
    // IPC——断言的是这句文案本身，不是「没崩」这种弱断言
    await expect(otto.win.getByText("登录后可用")).toBeVisible();

    await close.click();
    await expect(close, "✕ 点了但面板还在——这个面板就没有别的出口了").toHaveCount(0, {
      timeout: 5_000,
    });

    // 关掉之后还能再开：状态是真的翻回去了，不是把 DOM 抹了
    await otto.win.getByRole("button", { name: "工作区" }).click();
    await expect(close).toBeVisible({ timeout: 10_000 });

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
