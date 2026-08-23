// 子智能体「作用域」的真机验收 —— issue #147 清单第 1–8 条（除 6、7 两条要派活的，
// 它们在 subagentDispatch.e2e.ts）。
//
// ADR-0048 这条分支合并时全程没跑过 GUI，四条复核结论写的是 "read from source only"。
// 这里把「文件到底落在哪一层」这件事交给磁盘断言，而不是交给读代码 —— 落错一层的
// 后果正是这个特性要治的病（全局命名空间被工程私有的定义污染）。

import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  CONFIG_DIR,
  expectNoRendererErrors,
  launchOtto,
  openSettings,
  selectScope,
  startSession,
} from "./harness.js";

test("#147-1..5/8 开页停在当前工程；两层各写各的；同名时工作区那份赢并标「工作区」", async () => {
  const otto = await launchOtto({
    userAgents: [{ name: "user-level", description: "用户级的一份" }],
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  const wsLabel = basename(ws);
  try {
    const { win, userAgentsDir } = otto;
    await startSession(otto, ws);
    await openSettings(win, "子智能体");

    // 1. 在工程 W 的会话里打开这一页，下拉应当**已经**停在 W，不是「用户」
    const scopeBox = win.getByRole("combobox", { name: "作用域" });
    await expect(scopeBox).toHaveText(wsLabel);
    // 选中工程时清单是**两层合并**的（工作区盖用户），所以用户级那份在，
    // 但要带「用户」徽章标明它是哪一层来的 —— 徽章只在选中工程时出现，
    // 「用户」视图里两条根都是用户级，标签没有信息量
    const userRow = win.getByRole("button", { name: /^user-level/ });
    await expect(userRow.getByText("用户", { exact: true })).toBeVisible();

    // 2. 切到「用户」再切回 W，列表跟着换（这一条的判据是徽章：同一行，两种视图）
    await selectScope(win, "用户");
    await expect(userRow).toBeVisible();
    await expect(userRow.getByText("用户", { exact: true })).toHaveCount(0);
    await selectScope(win, wsLabel);
    await expect(userRow.getByText("用户", { exact: true })).toBeVisible();

    // 3. 在 W 里新建一个，文件要落在 <W>/.mr-otto/agents/
    await win.getByRole("button", { name: "新建" }).first().click();
    await win.getByLabel("名称").fill("scoped");
    await win.getByRole("button", { name: "创建" }).click();
    await expect(win.getByRole("button", { name: /^scoped/ })).toBeVisible();
    const wsFile = join(ws, CONFIG_DIR, "agents", "scoped.md");
    expect(existsSync(wsFile), `工作区级的定义要落在 ${wsFile}`).toBe(true);
    expect(existsSync(join(userAgentsDir, "scoped.md")), "不许同时落进用户级").toBe(false);

    // 4. 切到「用户」：W 那份不该漏进来（这一层看不见工程私有的定义）
    await selectScope(win, "用户");
    await expect(win.getByRole("button", { name: /^scoped/ })).toHaveCount(0);

    // 5. 在用户级建一个**同名**的（覆盖规则允许），再回 W：只剩一份，且是 W 那份
    await win.getByRole("button", { name: "新建" }).first().click();
    await win.getByLabel("名称").fill("scoped");
    await win.getByLabel("Description").fill("用户级的 scoped");
    await win.getByRole("button", { name: "创建" }).click();
    await expect(win.getByRole("button", { name: /^scoped/ })).toBeVisible();
    expect(readFileSync(join(userAgentsDir, "scoped.md"), "utf8")).toContain("用户级的 scoped");

    await selectScope(win, wsLabel);
    const row = win.getByRole("button", { name: /^scoped/ });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("工作区", { exact: true })).toBeVisible();
    await expect(row, "赢的是 W 那份，不该显示用户级那份的 description").not.toContainText(
      "用户级的 scoped"
    );

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#147-8 新建时撞上另一层的同名定义，弹出「会盖住哪一份」", async () => {
  const otto = await launchOtto({
    userAgents: [{ name: "shadowme", description: "用户级的一份" }],
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws);
    await openSettings(win, "子智能体");
    await win.getByRole("button", { name: "新建" }).first().click();
    await win.getByLabel("名称").fill("shadowme");
    // 提示要在**输入名字时**就出来，不是建完才说
    await expect(win.getByText(/已经有一份/)).toBeVisible();
    await expect(win.getByText(/会盖住它/)).toBeVisible();
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
