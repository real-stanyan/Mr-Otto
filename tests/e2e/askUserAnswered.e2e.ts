// 模型问 → 我答 → 时间线上留下「问了什么、我答了什么」。
//
// 为什么单测不够:这条链横跨三层——问卷卡把答案发回主进程、工具把答案格式化成
// tool_result 落盘、时间线再把这段文本解析回一张卡。中间两层各有单测
// (tests/tools/askUser.test.ts 的往返、tests/renderer/askUserCard.test.ts 的配对),
// 但"答完之后界面上到底还剩什么"只有真跑一遍才知道:分支挂错工具名、卡片被
// task 那样的过滤器压掉,单测照样全绿,界面上却只剩一行折起来的工具行。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

test("答完的问卷留在时间线上:题面 + 我选中的那个选项", async () => {
  // 第一轮问,第二轮收工——不这么分,模型会拿着答案接着问下去,卡片被后面的内容顶走
  const fake = await startFakeModel((_req, index) =>
    index === 0
      ? {
          toolCalls: [
            {
              name: "ask_user",
              args: {
                questions: [
                  {
                    header: "展示形态",
                    question: "答完的问卷怎么留在时间线上?",
                    options: [
                      { label: "内联工具卡", description: "跟工具行同一侧" },
                      { label: "用户气泡", description: "右对齐" },
                    ],
                  },
                ],
              },
            },
          ],
        }
      : { content: "记下了。" }
  );
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    // 开会话时打的那句就是第一轮 —— 假模型的第 0 轮回的正是 ask_user,
    // 不用再从输入框补一句（问卷挂起时输入框让位给了问卷卡）
    await startSession(otto, ws, "这个怎么做?");

    // ① 问卷卡真的弹出来了(工具挂起在等人)
    const choice = win.getByRole("radio", { name: /内联工具卡/ });
    await expect(choice).toBeVisible({ timeout: 30_000 });

    // ② 选一个 + 提交
    await choice.click();
    await win.getByRole("button", { name: "提交" }).click();

    // ③ 答完之后:时间线上留下的是题面 + 选中的那个选项,不是一行折起来的工具行
    const card = win.getByText("你回答了 Otto 的提问");
    await expect(card).toBeVisible({ timeout: 30_000 });
    const answered = win.locator('[data-slot="elicitation-form"]').filter({ hasText: "已作答" });
    await expect(answered).toContainText("答完的问卷怎么留在时间线上?");
    await expect(answered).toContainText("内联工具卡");
    // 没选中的那个也在——这张卡的价值一半在"当时的备选是什么"
    await expect(answered).toContainText("用户气泡");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
