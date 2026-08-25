// 上下文用量卡的真机验收：悬停那颗胶囊 → 卡片出来，且**没有**箭头。
//
// 为什么单立一条：藏箭头这件事在 CSS 层试过两版（[&>svg]:hidden、
// [&_[data-slot=tooltip-arrow]]:hidden），两版都写得像模像样、也都没生效
// —— Radix 给箭头 svg 打了内联 style="display:block"，class 压不过内联样式。
// 光看代码看不出没生效，只有真机能报这个"没生效"。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

test("上下文用量卡：悬停出卡，卡上不带箭头", async () => {
  const fake = await startFakeModel(() => ({ content: "收到。" }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "看看上下文用量");
    await expect(win.getByText("收到。")).toBeVisible({ timeout: 20_000 });

    await win.locator('[data-slot="context-display-trigger"]').hover();
    // 触发钮和卡片共用同一句 aria-label，按 label 会先撞上钮 —— 认浮层本身
    const card = win.locator('[data-slot="tooltip-content"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("窗口");
    await expect(card).toContainText("系统提示词");

    // 卡片是信息卡，不是提示气泡：那颗菱形不该在（藏不掉就压根别渲染）
    await expect(win.locator('[data-slot="tooltip-arrow"]')).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
