// 代码块的复制键 —— #123 表里「#119 的第二条」。
//
// 那条欠账当年卡在环境上：Typeless 的听写浮层贴着输入框，挡住人手的所有点击
// 路径（issue #119）。**这个卡点对 e2e 不成立** —— Playwright 走 CDP 直接驱动
// 渲染进程，不走系统级点击，浮层挡不住它。所以这条从「等人点」变成门禁的一部分，
// 与上一班把终端那 7 条搬进 terminal.e2e.ts 是同一件事。
//
// 顺带钉住的是一件更值钱的事：`assistant-ui/code-block.tsx` 的头注写明，
// 一旦给 StreamdownTextPrimitive 传了 componentsByLanguage，adapter 会整个接管
// code 元素，查不到语言时退回一个**裸 `<pre><code>`** —— 没高亮、没标题栏、
// 没复制钮。那份注释自己说了：「这件事在装的时候不会报错、测试也测不出来
// (它是渲染结果，不是类型)」。它测得出来 —— 只要问「复制钮在不在」：
// 降级成裸 pre 的那条路上没有复制钮。所以下面第一条断言不是铺垫，是那个兜底
// 还在不在的哨兵。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

/** 围栏里的正文。带缩进和空行 —— 复制出来的应该是**源码原文**，
    不是渲染后从 DOM 上刮下来的东西（行号、高亮 span 都不该混进去） */
const CODE = `function greet(name) {\n  if (!name) return "hi";\n\n  return \`hi \${name}\`;\n}`;

test("#123/#119 代码块:复制钮在（= shiki 兜底没失效），点它把源码原文放进剪贴板", async () => {
  const fake = await startFakeModel(() => ({
    content: `给你一段：\n\n\`\`\`javascript\n${CODE}\n\`\`\`\n`,
  }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));

  // 复制键写的是**系统剪贴板**，跑测试的人可能正拿它装着别的东西。
  // 借完还回去 —— 用例不该顺手清空开发者的剪贴板
  const before = await otto.app.evaluate(({ clipboard }) => clipboard.readText());

  try {
    const { win } = otto;
    await startSession(otto, ws, "给我一段代码");

    // 代码块渲染出来了：CodeBlock 那条路才有复制钮，裸 pre 那条没有。
    // 这一句红 = adapter 的全局兜底掉了，所有非 mermaid 语言一起降级
    const copy = win.locator('[data-streamdown="code-block-copy-button"]');
    await expect(copy, "代码块降级成裸 pre 了 —— ShikiCodeBlock 兜底没接上").toBeVisible({
      timeout: 20_000,
    });

    await copy.click();

    // 剪贴板从主进程读：那才是系统剪贴板本身。渲染层的 navigator.clipboard.readText()
    // 在 Electron 里要额外权限，而且读的是同一份东西 —— 绕开它没有损失。
    //
    // 结尾多一个 \n 是**对的**：markdown 围栏的正文是"闭合 ``` 之前的全部字符"，
    // 最后那个换行属于正文。断言写死它而不是 trimEnd —— 复制出来的东西该
    // 逐字节等于源码，"差不多一样"正是这条用例要防的
    await expect
      .poll(() => otto.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toBe(`${CODE}\n`);

    // 复制完按钮仍在（它把图标切成对勾，不弹 toast —— 复制是微动作，
    // 值不上一次全局打断）。不断言图标形状：那是 streamdown 内部的事
    await expect(copy).toBeVisible();

    expectNoRendererErrors(otto);
  } finally {
    await otto.app.evaluate(
      ({ clipboard }, text) => (text ? clipboard.writeText(text) : clipboard.clear()),
      before
    );
    await otto.close();
    await fake.close();
  }
});
