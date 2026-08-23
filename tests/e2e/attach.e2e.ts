// 附件的两条入口 —— #123 表里「#106 的拖拽浮层、粘贴」。
//
// 这两条当初写的是「没有逐条人工走查」。它们其实不需要人：拖放和粘贴都是
// 标准 DOM 事件，造一个带 File 的 DataTransfer 派发下去，走的就是用户拖进来
// 那条路（ADR-0030：＋/粘贴/拖拽三条入口共用同一道闸门）。
//
// 剩下真需要人的是同一条里的「展开/收起动效好不好看」—— 那是手感，不是事实。

import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, expectNoRendererErrors, launchOtto, startSession } from "./harness.js";

/** 造一个装着文件的 DataTransfer，留在页面里给后续事件复用 */
async function fileTransfer(win: Page, name: string, text: string) {
  return win.evaluateHandle(
    ({ name, text }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: "text/plain" }));
      return dt;
    },
    { name, text }
  );
}

async function composerBox(win: Page): Promise<Locator> {
  return win.getByRole("textbox", { name: /输入消息|描述任务/ });
}

test("#123/#106 拖文件到会话框：浮层出现说「松手添加为附件」，松手就成了附件", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话");
    const box = await composerBox(win);
    const dt = await fileTransfer(win, "拖进来的.txt", "拖放测试");

    await box.dispatchEvent("dragenter", { dataTransfer: dt });
    await expect(win.getByText("松手添加为附件")).toBeVisible();

    // 拖出去：浮层收掉，什么都没加上
    await box.dispatchEvent("dragleave", { dataTransfer: dt });
    await expect(win.getByText("松手添加为附件")).toHaveCount(0);

    // 再拖进来并松手
    await box.dispatchEvent("dragenter", { dataTransfer: dt });
    await box.dispatchEvent("drop", { dataTransfer: dt });
    await expect(win.getByText("拖进来的.txt")).toBeVisible({ timeout: 10_000 });
    // 松手之后浮层必须收掉，否则它会一直盖在会话框上
    await expect(win.getByText("松手添加为附件")).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#123/#106 往会话框里粘贴文件：和拖拽同一道闸门，进的是同一个暂存区", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话");
    const box = await composerBox(win);
    await box.click();
    // paste 得在页面里自己造 ClipboardEvent：clipboardData 是 ClipboardEvent
    // 构造器的字段，不是随便哪个 Event 都挂得上（dispatchEvent 那条路给的
    // 事件对象上 clipboardData 是空的，handler 一个文件都读不到）
    await box.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["粘贴测试"], "粘上来的.txt", { type: "text/plain" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(win.getByText("粘上来的.txt")).toBeVisible({ timeout: 10_000 });

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#123/#106 工作区改动浮窗：git 里有改动才出现，头行可展开可收起（附两张截图）", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-git-"));
  // 数据源是 git status，不是事件日志投影 —— 所以工程得真是个 git 仓库，
  // 里面得真有改动（非 git 目录不显示这个浮窗是有意的，不是漏）
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "初始"], {
    cwd: ws,
    env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" },
  });
  writeFileSync(join(ws, "新加的文件.ts"), "export const x = 1;\n");
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话看改动浮窗");

    const head = win.getByRole("button", { expanded: false }).filter({ hasText: "新加的文件.ts" });
    await expect(head).toBeVisible({ timeout: 30_000 });
    await win.screenshot({ path: join(ROOT, "test-results", "worktree-pill-收起.png") });

    // 展开：整条头行都是触发器（不用去点那颗 5px 的箭头）
    await head.click();
    await expect(win.getByRole("button", { expanded: true })).toBeVisible();
    await win.waitForTimeout(800); // GSAP 那条编排跑完再拍
    await win.screenshot({ path: join(ROOT, "test-results", "worktree-pill-展开.png") });

    // 收起
    await win.getByRole("button", { expanded: true }).click();
    await expect(win.getByRole("button", { expanded: false }).filter({ hasText: "新加的文件.ts" })).toBeVisible();

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
