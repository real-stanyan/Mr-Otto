// #434：换型号之前，把「这一下要作废多少缓存」摆在做决定的地方。
//
// 缓存是按型号存的：换过去那一刻新型号没见过这段前缀，整个上下文按未命中价
// 重算一次。这条验的是那句提示真的挂在型号浮层里，且数字来自上一次账单 ——
// 不是写死的文案。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

test("#434 型号浮层底部报出「换型号会作废多少缓存」", async () => {
  const fake = await startFakeModel(() => ({ content: "好的。", cachedTokens: 47_744 }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "随便说句话");
    await expect(win.getByText("好的。")).toBeVisible({ timeout: 20_000 });

    // 浮层没开的时候，这句话不该占着输入区
    await expect(win.getByText(/换型号会作废/)).toHaveCount(0);

    await win.getByTitle(/选择模型/).click();
    const hint = win.getByText(/换型号会作废/);
    await expect(hint).toBeVisible();
    // 数字来自上一次账单（47,744 → 47.7K），不是写死的
    await expect(hint).toContainText("47.7K");

    // 截图落在 test-results/ 下（同 subagentTheme 的做法）：这句话长什么样、
    // 和浮层里其余信息的轻重关系，机器判不了，人看一眼就知道
    await win.screenshot({ path: "test-results/434-model-switch-cache-hint.png" });

    await win.keyboard.press("Escape");
    await expectNoRendererErrors(otto);
  } finally {
    await otto.app.close();
    await fake.close();
  }
});
