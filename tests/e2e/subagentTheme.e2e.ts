// #142-19：深色 / 浅色两个主题下，派活卡（AgentStatus）和多行清单（SubagentList）
// 都要看得清。
//
// 这一条机器判不了「好不好看」，但机器能做两件事：把两种主题下的**同一屏**稳定地
// 摆出来并截图（人只需要看两张图，不用自己去装环境、造两条派活记录），以及断言
// 那些一眼看不出、却正是「看不清」根因的硬事实 —— 文字节点真的在、不是被同色底
// 吞掉的空壳。截图落在 test-results/ 下，PR 里贴出来。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, expectNoRendererErrors, launchOtto, openSettings, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel, type FakeRequest } from "./fakeModel.js";

function isParentTurn(req: FakeRequest): boolean {
  return (req.tools ?? []).some((t) => t.function.name === "task");
}

test("#142-19 深色/浅色下的派活卡与多行清单：截图 + 文字对比度不为零", async () => {
  const fake = await startFakeModel((req) =>
    isParentTurn(req)
      ? req.messages.some((m) => m.role === "tool")
        ? { content: "两件都办完了。" }
        : {
            toolCalls: [
              { name: "task", args: { agent: "searcher", task: "第一件：清点文件" } },
              { name: "task", args: { agent: "searcher", task: "第二件：找 README" } },
            ],
          }
      : { content: "办完了。" }
  );
  const otto = await launchOtto({
    userAgents: [{ name: "searcher", description: "只读搜索员", tools: "read_file", approval: "deny" }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "一次派两个活，看看两种主题");
    await expect(win.getByText("第二件：找 README")).toBeVisible({ timeout: 20_000 });
    await expect(win.getByText("第二件：找 README")).toBeVisible();

    for (const theme of ["浅色", "深色"] as const) {
      await openSettings(win, "外观");
      await win.getByRole("radiogroup", { name: "主题" }).getByRole("radio", { name: theme }).click();
      await win.getByRole("button", { name: "返回会话" }).click();
      await expect(win.getByText("第二件：找 README")).toBeVisible();
      // 卡片上的字必须是真的字：拿到实际前景色，别是 transparent / 和底色同值
      const [fg, bg] = await win.getByText("第二件：找 README").evaluate((el) => {
        const s = getComputedStyle(el);
        const card = el.closest("[data-slot='subagent-list'],[data-slot='agent-status']") ?? el;
        return [s.color, getComputedStyle(card as Element).backgroundColor];
      });
      expect(fg, `${theme}：卡片上的文字是透明的`).not.toMatch(/rgba\(.*,\s*0\)$/);
      expect(fg, `${theme}：文字色和卡片底色一模一样`).not.toBe(bg);
      await win.screenshot({ path: join(ROOT, "test-results", `subagent-${theme}.png`) });
    }

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
