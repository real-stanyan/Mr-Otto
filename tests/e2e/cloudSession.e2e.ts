// 云会话冒烟（Task 14，ADR-0199；入口位置改于 issue #917 / ADR-0217）。
//
// 现实检查——比 workspace.e2e.ts 那层还要再往上追一级：这条用例原本想验的是
// 「打开工作区页 → 断言云会话小节渲染、「新建云会话」按钮存在 → 点它、runtime
// 不在线时页面进入 connecting/错误态而不崩」。但云会话小节（WorkspacePage.tsx
// 的 CloudSessionsSection，含「新建云会话」按钮）只活在 WorkspacePage 里，而
// WorkspacePage 只在**点开侧栏里某一个工作区**时才挂载（issue #917 之后由
// App.tsx 的 openWorkspaceId 驱动，抽屉是它的载体）——而侧栏里一个工作区都
// 没有：workspaceGroups 要 `account.signedIn` 为真才拉得到。
//
// `account.signedIn` 在这套隔离 e2e 里恒为 false：它只由 AccountManager.restore()
// 的真实网络往返置真（account.ts:306-307 `this.client.auth.getUser()`），而
// harness.ts 顶部的隔离三件套刻意不给这次往返任何能成功的凭据——`authRecord`
// 播的只是 SignInScreen 认的本地 session 形状（过进门闸用），key 特意不是
// supabase-js 会当真去刷新的那个（见 harness.ts 的 `seedAuthRecord` 注释）。
// 这与 workspace.e2e.ts 头部那段结论完全一致，只是这条用例继续往下追了一层：
// 不只是「工作区列表是空的」，是「云会话小节所在的整页 WorkspacePage 都没有
// 入口可以走到」。main 进程那侧 workspaceManager 未登录时也统一回绝（同一段
// 注释提到的 `NOT_SIGNED_IN`），双保险。
//
// 所以这条用例能诚实断言的是：这一屏上云会话的入口（「云会话」小节标题、
// 「新建云会话」按钮）一个都不冒出来，而且这不是因为界面崩了。"点新建云会话
// → runtime 不在线 → connecting/错误态"那条链路需要一个真实登录的账号，
// 留给 docs/dev-two-accounts.md 手动验收，同 workspace.e2e.ts 结尾的结论。

import { expect, test } from "@playwright/test";

import { expectNoRendererErrors, launchOtto } from "./harness.js";

test("云会话冒烟：未真实登录时侧栏没有工作区可点，云会话入口不出现也不崩", async () => {
  const otto = await launchOtto(); // authRecord 默认 true——只过 SignInScreen 那道闸，见头部注释
  try {
    // 侧栏画出来了（拿常驻的「＋ 新工作区」当锚点），说明这一屏是活的——
    // 下面那几条负向断言才有意义，否则「什么都没有」也可能只是界面崩了
    await expect(otto.win.getByRole("button", { name: "新工作区" })).toBeVisible({ timeout: 15_000 });

    // 负向断言：证明「摸不到」是确定行为，不是巧合——这一屏不该露出云会话的
    // 任何入口（真出现了说明 signedIn 判断被绕过或改坏了）
    await expect(otto.win.getByText("云会话")).toHaveCount(0);
    await expect(otto.win.getByRole("button", { name: "新建云会话" })).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
