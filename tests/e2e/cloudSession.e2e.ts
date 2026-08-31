// 云会话冒烟（Task 14，ADR-0199）。
//
// 现实检查——比 workspace.e2e.ts 那层还要再往上追一级：这条用例原本想验的是
// 「打开工作区页 → 断言云会话小节渲染、「新建云会话」按钮存在 → 点它、runtime
// 不在线时页面进入 connecting/错误态而不崩」。但云会话小节（WorkspacePage.tsx
// 的 CloudSessionsSection，含「新建云会话」按钮）只活在 WorkspacePage 里，而
// WorkspacePage 只在 WorkspacesPanel 判定 `account.signedIn` 为真时才挂载——
// WorkspacesPanel.tsx:31-33 `if (!account.signedIn) return <div>...</div>`，
// 这一步早于任何 workspaceGroups / 云会话相关的逻辑。
//
// `account.signedIn` 在这套隔离 e2e 里恒为 false：它只由 AccountManager.restore()
// 的真实网络往返置真（account.ts:306-307 `this.client.auth.getUser()`），而
// harness.ts 顶部的隔离三件套刻意不给这次往返任何能成功的凭据——`authRecord`
// 播的只是 SignInScreen 认的本地 session 形状（过进门闸用），key 特意不是
// supabase-js 会当真去刷新的那个（见 harness.ts 的 `seedAuthRecord` 注释）。
// 这与 workspace.e2e.ts 头部那段「account.signedIn 在这条用例整个生命周期里
// 都是 false」的结论完全一致，只是这条用例继续往下追了一层：不只是"工作区
// 列表摸不到"，是"云会话小节所在的整页 WorkspacePage 都摸不到"。main 进程
// 那侧 workspaceManager 未登录时也统一回绝（同一段注释提到的 `NOT_SIGNED_IN`），
// 双保险——即使 UI 层的闸门被绕过，点「新建云会话」也只会拿到一句「还没
// 登录」的错误，不会真的走到 runtime 连接、更摸不到 connecting/错误态。
//
// 所以这条用例能诚实断言的是：工作区面板打开时安全兜底到「登录后可用」，
// 云会话的入口（「云会话」小节标题、「新建云会话」按钮）不会跟着冒出来，
// 也不会把页面崩掉——这是当前隔离环境下最贴近 brief 意图的断言。"点新建
// 云会话 → runtime 不在线 → connecting/错误态"那条链路需要一个真实登录的
// 账号，留给 docs/dev-two-accounts.md 手动验收，同 workspace.e2e.ts 结尾的
// 结论。

import { expect, test } from "@playwright/test";

import { expectNoRendererErrors, launchOtto } from "./harness.js";

test("云会话冒烟：未真实登录时工作区面板安全兜底，云会话入口不出现也不崩", async () => {
  const otto = await launchOtto(); // authRecord 默认 true——只过 SignInScreen 那道闸，见头部注释
  try {
    const close = otto.win.getByRole("button", { name: "关闭工作区面板" });

    await otto.win.getByRole("button", { name: "工作区" }).click();
    await expect(close).toBeVisible({ timeout: 15_000 });

    // account.signedIn 恒假 → WorkspacesPanel 提前 return，云会话小节摸不到，
    // 断言的是这句静态文案本身，不是「没崩」这种弱断言
    await expect(otto.win.getByText("登录后可用")).toBeVisible();

    // 负向断言：证明「摸不到」是确定行为，不是巧合——这一屏不该露出云会话的
    // 任何入口（真出现了说明 signedIn 判断被绕过或改坏了）
    await expect(otto.win.getByText("云会话")).toHaveCount(0);
    await expect(otto.win.getByRole("button", { name: "新建云会话" })).toHaveCount(0);

    await close.click();
    await expect(close, "✕ 点了但面板还在——这个面板就没有别的出口了").toHaveCount(0, {
      timeout: 5_000,
    });

    // 关掉之后还能再开：状态是真的翻回去了，同一句兜底文案还在，不是把
    // DOM 抹了或者留下半截状态
    await otto.win.getByRole("button", { name: "工作区" }).click();
    await expect(close).toBeVisible({ timeout: 10_000 });
    await expect(otto.win.getByText("登录后可用")).toBeVisible();

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
