// 子智能体编辑页的真机验收 —— #142 第 4/5/6 条 + #147 第 12/16 条。
//
// 这几条的共同点是「界面上那个禁用状态到底对不对」：保存键什么时候可点、
// 红字什么时候出现、返回列表会不会把没存的改动带回来。它们全都只在真 DOM 上成立，
// 纯逻辑单测（本仓 tests/renderer/ 那一层）碰不到。

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, openSettings } from "./harness.js";

test("#142-4/5 改 Description：脏了才能存；不存就返回，改动不留；存了磁盘真的变", async () => {
  const otto = await launchOtto({
    userAgents: [{ name: "editme", description: "原来的说明", tools: "read_file" }],
  });
  try {
    const { win, userAgentsDir } = otto;
    const file = join(userAgentsDir, "editme.md");
    await openSettings(win, "子智能体");
    await win.getByRole("button", { name: /^editme/ }).click();

    // 没改动时保存键是灰的，文案是「已保存」
    const save = win.getByRole("button", { name: /^(保存|已保存)$/ });
    await expect(save).toBeDisabled();
    await expect(save).toHaveText("已保存");

    // 一开始打字就变可用
    await win.getByLabel("Description").fill("改过的说明");
    await expect(save).toBeEnabled();
    await expect(save).toHaveText("保存");

    // 不保存直接返回列表、再进来：改动应该没了（草稿只活在这一页上）
    await win.getByRole("button", { name: "返回列表" }).click();
    await win.getByRole("button", { name: /^editme/ }).click();
    await expect(win.getByLabel("Description")).toHaveValue("原来的说明");
    expect(readFileSync(file, "utf8")).toContain("原来的说明");

    // 这次存下去：按钮变回灰的「已保存」，磁盘上那行真的换了
    await win.getByLabel("Description").fill("改过的说明");
    await save.click();
    await expect(save).toHaveText("已保存");
    await expect(save).toBeDisabled();
    expect(readFileSync(file, "utf8")).toContain("description: 改过的说明");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#142-6 一把工具都不选：保存键变灰 + 红字说明原因；勾回来报错消失", async () => {
  const otto = await launchOtto({
    userAgents: [{ name: "toolless", description: "验工具白名单", tools: "read_file, write_file" }],
  });
  try {
    const { win } = otto;
    await openSettings(win, "子智能体");
    await win.getByRole("button", { name: /^toolless/ }).click();

    const tools = win.getByRole("group", { name: "工具" });
    const checked = tools.getByRole("checkbox", { checked: true });
    const n = await checked.count();
    expect(n, "这份定义该有两把工具").toBe(2);
    for (let i = 0; i < n; i++) await checked.first().click();

    await expect(win.getByText(/至少留一把工具/)).toBeVisible();
    await expect(win.getByRole("button", { name: /^(保存|已保存)$/ })).toBeDisabled();

    // 勾回来一把：红字消失，保存键活过来
    await tools.getByRole("checkbox").first().click();
    await expect(win.getByText(/至少留一把工具/)).toHaveCount(0);
    await expect(win.getByRole("button", { name: /^保存$/ })).toBeEnabled();

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#147-12 前置词选「自定义」却不填字：保存禁用 + 红字，而不是静默存成「用全局」", async () => {
  const otto = await launchOtto({
    userAgents: [{ name: "blankpre", description: "验空自定义前置词", tools: "read_file" }],
  });
  try {
    const { win } = otto;
    await openSettings(win, "子智能体");
    await win.getByRole("button", { name: /^blankpre/ }).click();

    await win.getByRole("radiogroup", { name: "前置词" }).getByRole("radio", { name: "自定义" }).click();
    await expect(win.getByText(/自定义前置词不能是空的/)).toBeVisible();
    await expect(win.getByRole("button", { name: /^(保存|已保存)$/ })).toBeDisabled();

    // 填上字就放行
    await win.getByPlaceholder("这一段会替代内置的那段前置词，只对这个子智能体生效").fill("你是我的专用检索员。");
    await expect(win.getByText(/自定义前置词不能是空的/)).toHaveCount(0);
    await expect(win.getByRole("button", { name: /^保存$/ })).toBeEnabled();

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#147-16 手写 context: ../../etc/passwd —— 设置页读不出它，只认白名单里那两份", async () => {
  const otto = await launchOtto({
    userAgents: [
      {
        name: "sneaky",
        raw: "---\nname: sneaky\ndescription: 手写的越界 context\ntools: read_file\ncontext: ../../etc/passwd, AGENTS.md\n---\n\n正文。\n",
      },
    ],
  });
  try {
    const { win } = otto;
    await openSettings(win, "子智能体");
    await win.getByRole("button", { name: /^sneaky/ }).click();

    const ctx = win.getByRole("group", { name: "工作区文档" });
    // 控件里只有白名单那两项，越界那条一个字都不该出现在页面上
    await expect(ctx.getByRole("checkbox")).toHaveText(["AGENTS.md", "CLAUDE.md"]);
    await expect(win.getByText(/passwd/)).toHaveCount(0);
    // 同一份定义里合法的那条要留下（不是整行丢掉）
    await expect(ctx.getByRole("checkbox", { name: "AGENTS.md" })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
