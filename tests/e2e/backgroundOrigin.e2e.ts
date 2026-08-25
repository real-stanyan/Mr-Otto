// #428：后台任务回注的那条消息，不能长得和用户亲手打的字一样。
//
// 这一条只有端到端跑得出来：载体是 user_message（对模型来说就该是一条用户消息），
// 差别只在事件上多一个 origin 标 + 渲染层据此换皮。中间隔着真的 bash 后台任务、
// 真的完成回调、真的回注 turn —— 断言只看最后那屏 DOM：两个气泡，一个带
// data-origin="background"，一个没有。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel, type FakeRequest } from "./fakeModel.js";

/** 后台任务的完成回注会带着 [后台任务 bg-N 完成] 前缀进来 —— 认它来分轮次 */
function isReinjectedTurn(req: FakeRequest): boolean {
  return req.messages.some(
    (m) => typeof m.content === "string" && m.content.includes("[后台任务 bg-1 完成]")
  );
}

test("#428 后台回注的气泡带 origin 标，人打的字没有", async () => {
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
    // 免审批：这一条验的是回注气泡，不是审批卡（审批那条路自己有用例）
    await win.getByRole("switch", { name: "免审批" }).click();
    await startSession(otto, ws, "去后台跑一下 echo");

    // 回注 turn 的答复出现 = 后台任务完成 → 注回 → 模型又答了一轮
    await expect(win.getByText("后台那件事我看到了。")).toBeVisible({ timeout: 30_000 });

    const bubbles = win.locator("[data-slot='aui_user-message-root']");
    await expect(bubbles).toHaveCount(2);
    // 第一条是人打的：没有 origin
    await expect(bubbles.nth(0)).not.toHaveAttribute("data-origin", "background");
    // 第二条是后台回注：带标 + 一行「不是你发的」的交代
    await expect(bubbles.nth(1)).toHaveAttribute("data-origin", "background");
    await expect(bubbles.nth(1).getByText("后台任务回注 · 不是你发的")).toBeVisible();

    // 换皮是真换了：两个气泡的底色不一样（同色 = 等于没改）
    const [human, bg] = await bubbles.evaluateAll((els) =>
      els.map((el) => {
        const body = el.querySelector(".aui-user-message-content");
        return body ? getComputedStyle(body).backgroundColor : "";
      })
    );
    expect(human).not.toBe("");
    expect(bg).not.toBe(human);

    await expectNoRendererErrors(otto);
  } finally {
    await otto.app.close();
    await fake.close();
  }
});
