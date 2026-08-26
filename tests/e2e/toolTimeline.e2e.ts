// 工具时间线的折叠头说什么、思考在不在里面。
//
// 为什么单测不够:分组表(lib/partGrouping.ts)和文案(shared/toolSummary.ts)各有
// 单测,但「思考到底画在时间线里还是外面」是三段拼起来的结果 —— 投影分 part、
// groupBy 分组、thread.tsx 挑组件。任一段接错,两个单测照样全绿,界面上思考却
// 还在折叠区里。这条用例量的是最终 DOM。

import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

test("折叠头报的是「工作了多久」,思考画在时间线外", async () => {
  const fake = await startFakeModel((_req, index) =>
    index === 0
      ? {
          reasoning: "先看看这个目录里有什么。",
          // 带工具的 content = 旁白,它该留在时间线里当一步
          content: "我先列一下。",
          // read_file 而不是 bash:bash 过审批门,卡在门前的调用**没有**开跑标记,
          // 折叠头就没有耗时可报(那时报一个数才是说假话)。这条用例要验的是
          // 真跑完之后那行文案,所以挑一把不需要审批的工具
          toolCalls: [
            { name: "read_file", args: { path: "one.txt" } },
            { name: "read_file", args: { path: "two.txt" } },
          ],
        }
      : { content: "看完了。" }
  );
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  writeFileSync(join(ws, "one.txt"), "第一份\n");
  writeFileSync(join(ws, "two.txt"), "第二份\n");
  try {
    const { win } = otto;
    await startSession(otto, ws, "看看这个目录");

    const timeline = win.locator('[data-slot="tool-timeline"]');
    await expect(timeline).toBeVisible({ timeout: 30_000 });

    // ① 折叠头是耗时 + 步数,不是那份按动作归并的工具清单
    const trigger = timeline.getByRole("button").first();
    await expect(trigger).toHaveText(/(工作了|工作中).*步/, { timeout: 30_000 });
    await expect(trigger).not.toContainText("×");

    // ② 思考在时间线**外**:它自己一条折叠头,不在时间线的子树里
    const thinking = win.getByText(/思考 \d+ 字/);
    await expect(thinking).toBeVisible({ timeout: 30_000 });
    expect(await timeline.locator("text=/思考 \\d+ 字/").count()).toBe(0);

    // ③ 展开才是一个个工具行;旁白(带工具的那句)留在时间线里当一步
    await trigger.click();
    await expect(timeline).toContainText("one.txt");
    await expect(timeline).toContainText("two.txt");
    await expect(timeline).toContainText("我先列一下。");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
