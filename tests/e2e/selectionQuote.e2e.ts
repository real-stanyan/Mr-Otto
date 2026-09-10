// 划词引用的整条链（issue #881 / ADR-0284）：在消息里选一段 → 点「引用」→
// 输入框上方多一张 chip → 打字发出去 → 那条消息里，引用块在正文**之前**。
//
// 为什么值得一条 e2e：这条 issue 的落地被拆成三段（store 一格、chip 渲染、
// `dispatch` 里折回引用块），每一段都有单测，但**没有任何一层能验「选中的那段
// 文字真的走完了全程」**——选区在 jsdom 里没有几何（`getBoundingClientRect`
// 恒为 0），而 `ChatComposer.dispatch` 是 App.tsx 里的一个闭包，import 不进
// vitest（那一处只钉得住源码长什么样，见 tests/renderer/composerQuoteWiring.test.ts）。
//
// 选区用 Range API 造、再手动派一个 mouseup：SelectionQuote 的定位就挂在
// document 的 mouseup 上（选区此刻才定下来，见那个组件的头注）。这不是绕过
// 用户路径——鼠标拖选最后落到的就是这个事件。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

/** 助手回复里要被引用的那一行。挑一个不会在界面别处出现的串 —— 断言按文本找元素 */
const TARGET = "ALPHA-QUOTE-TARGET-42";

test("#881 划词引用:选中的话变成一张 chip,发出去时引用块排在正文前面", async () => {
  const fake = await startFakeModel(() => ({ content: `看这一行：\n\n${TARGET}\n` }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话");

    await expect(win.getByText(TARGET)).toBeVisible({ timeout: 20_000 });

    // 选中那一行，然后派 mouseup —— 拖选最后落到的就是这个事件
    await win.evaluate((needle) => {
      const el = [...document.querySelectorAll("p, span, div")]
        .reverse()
        .find((n) => n.textContent?.trim() === needle);
      if (!el) throw new Error(`页面上找不到 ${needle}`);
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, TARGET);

    await win.getByRole("button", { name: "引用" }).click();

    // 引用**没有**落进输入框——这正是这条 issue 修的东西
    const box = win.getByRole("textbox", { name: /输入消息/ });
    await expect(box).toHaveValue("");

    // 落成了一张 chip：名字是那一行，副行说它是引用
    const chip = win.locator('[data-slot="composer-attachment"]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText(TARGET);
    await expect(chip).toContainText("引用 · 1 行");

    await box.fill("改成大写");
    await box.press("Enter");

    // 发出去的那条:引用块在正文之前。DirectiveText 画的是纯文本,
    // 所以 `> ` 逐字出现在 DOM 上
    const mine = win.locator('[data-role="user"]').last();
    await expect(mine).toContainText(`> ${TARGET}`, { timeout: 20_000 });
    await expect(mine).toContainText("改成大写");

    // chip 用掉了就该消失 —— 留着的话下一条消息会把同一段引用再带一遍
    await expect(win.locator('[data-slot="composer-attachment"]')).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
