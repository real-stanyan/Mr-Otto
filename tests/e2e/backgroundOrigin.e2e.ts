// #428 / #452：后台任务在界面上必须是看得见、且看得出「不是我发的」。
//
// 这两条只有端到端跑得出来：载体是 user_message（对模型来说就该是一条用户消息），
// 差别只在事件上多一个 origin 标 + 渲染层据此换皮；面板那条更是要真的有个进程
// 在跑才成立。中间隔着真的 bash 后台任务、真的完成回调、真的回注 turn。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel, type FakeRequest } from "./fakeModel.js";

/** 后台任务的完成回注会带着 [后台任务 bg-N 完成] 前缀进来 —— 认它来分轮次。
    注意这只是**测试**在分轮次，产品代码不许这么认（ADR-0103/0109：身份和
    关联都记在事件上，不靠正文前缀反解） */
function isReinjectedTurn(req: FakeRequest): boolean {
  return req.messages.some(
    (m) => typeof m.content === "string" && m.content.includes("[后台任务 bg-1 完成]")
  );
}

test("#452 后台回注是居中的系统卡片，默认折叠，不是用户气泡", async () => {
  const fake = await startFakeModel((req) => {
    if (isReinjectedTurn(req)) return { content: "后台那件事我看到了。" };
    // 工具结果回来的那一圈：收工，别再派活
    if (req.messages.some((m) => m.role === "tool")) return { content: "已经丢到后台跑了。" };
    return {
      toolCalls: [
        { name: "bash", args: { cmd: "echo 后台干完了", run_in_background: true } },
      ],
    };
  });
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    // 免审批：这一条验的是回注卡片，不是审批卡（审批那条路自己有用例）
    await win.getByRole("switch", { name: "免审批" }).click();
    await startSession(otto, ws, "去后台跑一下 echo");

    // 回注 turn 的答复出现 = 后台任务完成 → 注回 → 模型又答了一轮
    await expect(win.getByText("后台那件事我看到了。")).toBeVisible({ timeout: 30_000 });

    const bubbles = win.locator("[data-slot='aui_user-message-root']");
    await expect(bubbles).toHaveCount(2);
    // 第一条是人打的：没有 origin
    await expect(bubbles.nth(0)).not.toHaveAttribute("data-origin", "background");
    // 第二条是后台回注：带标 + 说清「不是你发的」+ 标题用的是事件上的 taskId
    const card = bubbles.nth(1);
    await expect(card).toHaveAttribute("data-origin", "background");
    await expect(card.getByText("bg-1")).toBeVisible();
    await expect(card.getByText("的结果 · 不是你发的")).toBeVisible();

    // 默认折叠：命令输出不摊在时间线上
    await expect(card.getByText("后台干完了")).toBeHidden();
    // 点开才看到全文
    await card.getByRole("button", { expanded: false }).click();
    await expect(card.getByText("后台干完了")).toBeVisible();

    // 不是用户气泡：人打的那条有 .aui-user-message-content，回注卡没有。
    // 这一条钉的正是 #452 要改的东西——#428 那版两者都有，只是底色不同
    await expect(bubbles.nth(0).locator(".aui-user-message-content")).toHaveCount(1);
    await expect(card.locator(".aui-user-message-content")).toHaveCount(0);

    await expectNoRendererErrors(otto);
  } finally {
    await otto.app.close();
    await fake.close();
  }
});

test("#452 任务还在跑的时候，输入框上方有面板说它在跑", async () => {
  const fake = await startFakeModel((req) => {
    if (isReinjectedTurn(req)) return { content: "睡醒了。" };
    if (req.messages.some((m) => m.role === "tool")) return { content: "丢后台睡去了。" };
    return {
      toolCalls: [
        // 睡够久，好让面板那一档被观察到（echo 一瞬间就完了，看不见 running）
        { name: "bash", args: { cmd: "sleep 8", run_in_background: true } },
      ],
    };
  });
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await win.getByRole("switch", { name: "免审批" }).click();
    await startSession(otto, ws, "去后台睡一会");

    const panel = win.getByLabel("后台任务");
    // 起了就该看得见——这正是 #452 的由来：在此之前界面上一点痕迹都没有
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("sleep 8")).toBeVisible();
    await expect(panel.getByText("1 个在跑")).toBeVisible();

    // 结果注回对话后，这一行就该从面板上摘掉（判据是「进了对话」不是「跑完了」）
    await expect(win.getByText("睡醒了。")).toBeVisible({ timeout: 30_000 });
    await expect(panel).toBeHidden();

    await expectNoRendererErrors(otto);
  } finally {
    await otto.app.close();
    await fake.close();
  }
});
