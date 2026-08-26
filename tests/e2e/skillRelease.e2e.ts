// ADR-0110 的「停用」这条路的端到端守卫：点了那个按钮，时间线上真的长出一行。
//
// 为什么单测不够（而且这条 bug 恰恰是单测挡不住的形状）：`EventRow` 里写了
// `case "skill_released"`，看代码像是做完了；但事件要先过 `isAuditEvent`
// （toThreadMessages.ts）才会变成 system 消息，而那份名单漏了它——于是那个
// case 是**永不执行的死代码**，用户点了「停用」只能靠「按钮消失」这个隐式信号
// 猜发生了什么。三份名单的对表测试（tests/renderer/timelineLists.test.ts）
// 挡的是源码层的 drift，这一条挡的是「从点击到那一行」整条链路。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

const MARKER = "e2e-demo 正文里的这句话只应该在启用之后出现在请求体里。";

test("点「停用」：时间线上出现停用行，按钮跟着退场", async () => {
  const fake = await startFakeModel(() => ({ content: "好的。" }));
  const otto = await launchOtto({
    skills: [{ name: "e2e-demo", description: "e2e 用的假 skill", body: MARKER }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话");
    await expect.poll(() => fake.requests.length, { timeout: 20_000 }).toBeGreaterThan(0);

    // 用 `$` 启用（不依赖模型愿不愿意调工具 —— 这条用例验的是停用那一半）
    const composer = win.getByRole("textbox", { name: /输入消息/ });
    await composer.fill("$e2e-demo 帮我看看");
    await composer.press("Enter");

    // 启用卡 + 它自带的停用入口
    await expect(win.getByText("已启用 skill「e2e-demo」", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    const release = win.getByRole("button", { name: "停用 skill「e2e-demo」" });
    await expect(release).toBeVisible();

    await release.click();

    // 这一行就是整条用例的全部：它此前永远不出现（isAuditEvent 没放行，
    // EventRow 那个 case 执行不到）
    await expect(win.getByText("已停用 skill「e2e-demo」", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    // 按钮退场不是本地状态控制的，是台账重算出来的（Timeline 的 SkillInvokedRow）
    await expect(release).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
