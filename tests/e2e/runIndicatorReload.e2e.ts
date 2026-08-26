// issue #548：turn 跑着的时候重载渲染进程，运行指示条不该消失。
//
// 这个洞不是渲染 bug 而是**通信模型的缺口**：turn 状态只在变化的那一刻推一次
// （onTurnStatus），重载之后那一拍已经过去，store 里查无此会话 → 指示条整个
// 不渲染，一直空到这一轮结束。所以用例的关键动作只有一个：`win.reload()`。
//
// 慢吐的假模型是为了给 reload 留出窗口 —— turn 必须在重载之后还活着，
// 否则这条用例测的是"重载后 turn 刚好结束"，永远绿，什么也没保住。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

test("#548 turn 跑着时重载：运行指示条还在（补状态那一问接上了错过的推送）", async () => {
  // 正文按字符发，每个字之间停 200ms —— 这一轮至少活 8 秒，够重载跑完
  const fake = await startFakeModel(() => ({
    content: "慢慢想慢慢想慢慢想慢慢想慢慢想慢慢想慢慢想慢慢想",
    delayMs: 200,
  }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "跑一轮,中途重载看看指示条还在不在");

    await expect(win.getByRole("status").first()).toBeVisible({ timeout: 20_000 });
    // **必须等到正文开始流才重载**：running 推送分两拍（turn 锁一上先推一次不带
    // turnId 的，engine 落下开场 user_message 后再推一次带上，见 TurnStatusUpdate）。
    // 卡在两拍之间重载的话，第二拍会顺手把状态补回去 —— 用例就变成了"碰巧绿"，
    // 测不到真实场景（人是在 turn 跑到一半时重载的，那时两拍早就过去了）
    await expect(win.getByText(/慢慢想/).first()).toBeVisible({ timeout: 20_000 });

    await win.evaluate(() => { (window as unknown as { __beforeReload?: boolean }).__beforeReload = true; });
    await win.reload();
    expect(await win.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload ?? false),
      "reload 没真的换页").toBe(false);
    await expect(win.getByTestId("splash")).toHaveCount(0, { timeout: 20_000 });

    // 重载后指示条必须自己回来。修复之前这里是空的（statusBySession 查无此会话
    // → RunIndicator return null），一直空到这一轮结束
    const status = win.getByRole("status").first();
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status).toContainText(/思考中|作答中|检索中|执行中/);

    // 玻璃也跟着回来了：指示条是整块一起补的，不是只剩一行裸字
    const glass = status.locator("xpath=ancestor::div[contains(@class,'liquid-glass')][1]");
    await expect(glass).toHaveCount(1);

    await win.screenshot({ path: join(ROOT, "test-results", "run-indicator-after-reload.png") });
  } finally {
    await otto.close();
    await fake.close();
  }
  expectNoRendererErrors(otto);
});

test("#548 卡在审批门上时重载：审批那一档也补得回来", async () => {
  // 一把要审批的工具（bash）。turn 会停在审批门上等人——这正是"重载最可能发生"
  // 的时刻：人走开、回来、顺手刷新
  const fake = await startFakeModel((req) =>
    req.messages.some((m) => m.role === "tool")
      ? { content: "跑完了。" }
      : { toolCalls: [{ name: "bash", args: { cmd: "echo hi" } }] },
  );
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "跑条命令,停在审批上");

    const status = win.getByRole("status").first();
    await expect(status).toContainText("等待审批…", { timeout: 20_000 });

    await win.reload();
    await expect(win.getByTestId("splash")).toHaveCount(0, { timeout: 20_000 });

    // 审批卡是推来的，和 turn 状态同一个洞：重载后 approvals 里查无此会话，
    // 指示条要么整个不在、要么退回"思考中…"（谎报——它根本没在想，它在等人）
    await expect(win.getByRole("status").first()).toContainText("等待审批…", { timeout: 15_000 });
    await expect(win.getByRole("button", { name: /^(允许|批准|同意)/ }).first()).toBeVisible();
  } finally {
    await otto.close();
    await fake.close();
  }
  expectNoRendererErrors(otto);
});
