// 子智能体设置页的真机验收 —— issue #142「设置页」那一节 + #147「作用域」那一节。
//
// 这两张清单本来是给人照着点的，卡了三个多月没人点完；卡点写的是「实施 agent 跑不了
// Electron GUI」。跑得了：Playwright 起的是真 Electron、真主进程、真磁盘（HOME 换成
// 一次性临时目录，见 harness.ts）。所以这里把清单里**机器判得了对错**的那些条
// 逐条落成用例，条目号写在每个 test 名字里，人只需要复核判据本身。
//
// 判不了的留给人：外观好不好看、深浅色能不能看清（那类改成截图，人看图）。

import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, openSettings } from "./harness.js";
import { ACCOUNTS_DIR } from "../../src/main/accountScope.js";

test("#142-1/2/3 空态有交代；新建落盘；中文名在发 IPC 前就被挡住", async () => {
  const otto = await launchOtto();
  try {
    const { win, userAgentsDir } = otto;
    await openSettings(win, "子智能体");

    // 1. 空态要说清楚这一栏是空的（原先那句"怎么建"的引导文案随 f250f1d 一并删了，
    //    界面上只留标题 + 新建钮，断言跟着收窄到还在的那半）
    await expect(win.getByText("你还没定义自己的子智能体")).toBeVisible();

    // 2. 新建 → ASCII 名字 → 提交：回列表、出现新行、磁盘上有带 frontmatter 的文件
    await win.getByRole("button", { name: "新建" }).first().click();
    await win.getByLabel("名称").fill("demo-agent");
    await win.getByRole("button", { name: "创建" }).click();
    await expect(win.getByRole("button", { name: /demo-agent/ })).toBeVisible();
    const written = readFileSync(join(userAgentsDir, "demo-agent.md"), "utf8");
    expect(written, "落盘的文件要带 YAML frontmatter").toMatch(/^---\nname: demo-agent\n/);

    // 3. 中文名字：报错是中文的，且目录里不许多出任何文件 —— 尤其不许有 ---.md
    //    （那是主进程把中文 replace 成 "-" 时塌出来的空壳，曾经真的建出来过）
    await win.getByRole("button", { name: "新建" }).first().click();
    await win.getByLabel("名称").fill("搜索员");
    await win.getByRole("button", { name: "创建" }).click();
    await expect(win.getByText(/只能用|字母|ASCII/)).toBeVisible();
    expect(readdirSync(userAgentsDir).sort()).toEqual(["demo-agent.md"]);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

// #142-7 与 #147-20/21 的原文已经**过期**：它们要的是「`~/.claude/agents/` 来的行
// 标只读 + 复制到 ~/.mr-otto/agents」，而 ADR-0056 已经把那条扫描根整个撤了
// （Mr Otto 只看自己的目录）。清单是那之前写的。这里按现状重写成两条：
//   ① 撤掉这件事本身要有回归闸门 —— 别哪天又被顺手扫回来；
//   ② 「只读的一份变成我自己的一份」这条路还活着，出口换成了内置那三份，
//      按 #142-7 的本意验它。
//
// 顺带记一笔：`freeCopyName`（-copy / -copy-2，#147-21 要验的那个）在产品里已经
// **没有调用方**了 —— EditSubagentPage 里 `def.builtin ? def.name : freeCopyName(...)`
// 的 else 分支要有一份「磁盘上的只读定义」才走得到，而现在没有任何根是只读的。

test("#142-7 内置那份「改成我自己的一份」；ADR-0056 撤掉的 ~/.claude/agents 不许扫回来", async () => {
  const otto = await launchOtto({
    claudeAgents: [{ name: "borrowed", description: "Claude Code 那边的定义", tools: "read_file" }],
  });
  try {
    const { win, userAgentsDir } = otto;
    await openSettings(win, "子智能体");

    // ① ~/.claude/agents/ 里躺着一份 borrowed，清单里不许出现（ADR-0056）
    await expect(win.getByText("你还没定义自己的子智能体")).toBeVisible();
    await expect(win.getByText("borrowed")).toHaveCount(0);

    // ② 内置那份：点开是只读展示 + 「改成我自己的一份」，写出的是同名定义、
    //    落在当前作用域，且按钮的 title 说的就是落点
    await win.getByRole("button", { name: /^Explore 内置/ }).click();
    await expect(win.getByLabel("Description")).toBeDisabled();
    const materialize = win.getByRole("button", { name: "改成我自己的一份" });
    // 落点跟着账号走（ADR-0186）：title 上写的是真路径，不再是 `~/.mr-otto/agents`
    await expect(materialize).toHaveAttribute("title", userAgentsDir);
    await materialize.click();

    // 点完**留在编辑页**，只是这一页现在编的是磁盘上那份（issue #268）：
    // 走到这一步的用户刚说了「我要改它」，原来却会被甩回列表、且那句
    // 「已写出「X」到…」永远看不到（组件按 rowKey 找 def，materialize 之后
    // `builtin:Explore` 这个 key 当场失效）
    await expect(win.getByLabel("Description")).toBeEnabled({ timeout: 10_000 });
    // 这一页的身份换了：不再是「内置」，而是「内置 · 已自定义」+ 磁盘路径
    await expect(win.getByText("内置 · 已自定义")).toBeVisible();
    await expect(win.getByText(new RegExp(`${ACCOUNTS_DIR}/[0-9a-f]{16}/agents/Explore\\.md$`))).toBeVisible();

    const written = readFileSync(join(userAgentsDir, "Explore.md"), "utf8");
    expect(written).toMatch(/^---\nname: Explore\n/);

    // 回列表：清单里仍然只有一行 Explore（不是内置一行 + 磁盘一行），
    // 它留在「内置」那一栏挂着「已自定义」—— 那份文件是内置那份的覆盖层
    await win.getByRole("button", { name: "返回列表" }).click();
    await expect(win.getByRole("button", { name: /^Explore/ })).toHaveCount(1);
    await expect(win.getByText("内置子智能体").locator("xpath=following-sibling::span[1]")).toHaveText(
      "3 项"
    );
    await expect(win.getByRole("button", { name: /^Explore/ })).toContainText("已自定义");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
