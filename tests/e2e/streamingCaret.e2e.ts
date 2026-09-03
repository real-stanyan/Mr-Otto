// 流式输出的时候屏幕上有几个光标（issue #894）。
//
// 为什么只能在真 Electron 里验：光标是 streamdown 画的一个 `::after` 伪元素
// （`content: var(--streamdown-caret)`，值是 `" ▋"`）。jsdom 没有真正的样式解析，
// `getComputedStyle(el, "::after")` 拿不到 content —— 在那儿数多少遍都是 0。
//
// 数的是**同一时刻**有几个，不是「有没有」：有没有光标一直是对的，
// 用户报的是「多行光标一起输出」。所以断言必须是 `=== 1`，`>= 1` 会全程绿。
//
// 采样跑在页面里（`setInterval` + 一个峰值变量），不从测试端一次次 `evaluate`：
// 每次 evaluate 都要过一趟 IPC，两次采样之间的空档比流式窗口还长，
// 峰值恰好落在空档里就什么都测不到 —— 第一版就是这么假绿的。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

/** 多段正文：用户说的「多行文本输出」就是这个形状 —— 正文被切成多个块级子元素 */
const MULTI_PARAGRAPH = Array.from(
  { length: 10 },
  (_, i) => `第 ${i + 1} 段：这一段是为了把正文切成多个块级子元素，好让「多行」这个条件成立。`,
).join("\n\n");

const THINKING = Array.from(
  { length: 6 },
  (_, i) => `想第 ${i + 1} 步：先看看 caret 是谁画的，再看它挂在谁身上。`,
).join("\n\n");

declare global {
  interface Window {
    __caretPeak?: number;
    __caretSeries?: number[];
  }
}

test("流式输出时，屏幕上始终只有一个光标", async () => {
  test.setTimeout(120_000);
  // 一轮就够：一条 running 的消息里同时有 reasoning part 和 text part，
  // 两处都渲染 MarkdownText。刻意不带工具调用 —— bash 要过审批门，
  // 用例会卡在「等你处理」上，而这一条要验的不是审批
  const fake = await startFakeModel(() => ({
    content: MULTI_PARAGRAPH,
    reasoning: THINKING,
    delayMs: 25,
  }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;

    // 采样器：此刻有几个 <Streamdown> 真的在画光标。
    //
    // 判据取「wrapper 上有没有内联的 `--streamdown-caret`」而不是遍历整棵树量
    // `::after` 的 content —— 后者要对每个元素调一次 getComputedStyle，40ms 一轮
    // 能把渲染进程拖到流式都跑不完（第一版就是这么超时的）。两者等价：
    // streamdown 里 class 的条件是 `caret && !Ge`、变量的条件是 `caret && isAnimating && !Ge`，
    // 变量有值 ⇒ class 一定在 ⇒ 那个 `::after` 一定画得出来。
    // 用 evaluate 不用 addInitScript —— 页面在 launchOtto 里已经加载完了，
    // addInitScript 只对之后的导航生效，装上去等于没装（采样 0 次）
    await win.evaluate(() => {
      window.__caretPeak = 0;
      window.__caretSeries = [];
      setInterval(() => {
        const n = document.querySelectorAll('[style*="--streamdown-caret"]').length;
        window.__caretSeries!.push(n);
        if (n > window.__caretPeak!) window.__caretPeak = n;
      }, 40);
    });

    await startSession(otto, ws, "说点多段的");

    // 等到最后一段出来 = 两轮都流完了
    await expect(win.getByText(/第 10 段/)).toBeVisible({ timeout: 60_000 });

    const peak = await win.evaluate(() => window.__caretPeak ?? -1);
    const series = await win.evaluate(() => window.__caretSeries ?? []);
    // 先确认采样器真的看见过光标 —— 一个都没看见的话下面那条断言是假绿
    expect(peak, `采样器一次都没数到光标（采样 ${series.length} 次），用例本身没验到东西`)
      .toBeGreaterThanOrEqual(1);
    expect(peak, `流式过程中最多同时出现了 ${peak} 个光标（采样序列：${series.join(",")}）`).toBe(1);

    // 收口之后一个都不该剩 —— 「还在长字」是光标唯一的含义
    await expect
      .poll(() => win.evaluate(() => window.__caretSeries?.at(-1) ?? -1), { timeout: 15_000 })
      .toBe(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
