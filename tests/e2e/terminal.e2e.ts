// 内嵌终端的真机验收 —— #123 表里「#117 的 7 条」（plan 的 Task 6 Step 6）。
//
// 这一栏本来是全清单里最没法「读代码验」的：PTY 是原生模块（node-pty），
// 它到底能不能在 Electron 的 ABI 下加载、进程有没有活着、关了标签有没有留孤儿，
// 全是运行时事实。

import { expect, test } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession, type Otto } from "./harness.js";

/** xterm 的可见文本。DOM 渲染器把每一行画成一个 div，读整块就够判断了 */
async function screenText(otto: Otto): Promise<string> {
  return (await otto.win.locator(".xterm-rows").first().innerText()).replace(/ /g, " ");
}

async function typeLine(otto: Otto, line: string): Promise<void> {
  await otto.win.locator(".xterm-screen").first().click();
  await otto.win.keyboard.type(line);
  await otto.win.keyboard.press("Enter");
}

test("#123/#117-1/2/7 ⌃` 开关面板；TERM 是 xterm-256color；pwd 是会话的工程文件夹", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话好开终端");

    // 7. ⌃` 开面板（VS Code 同款肌肉记忆）
    await win.keyboard.press("Control+`");
    await expect(win.locator(".xterm-screen").first()).toBeVisible({ timeout: 20_000 });

    // 1. 这是一台真 PTY：$TERM 得是 xterm-256color，否则彩色提示符无从谈起
    await typeLine(otto, "echo TERM=$TERM");
    await expect.poll(() => screenText(otto), { timeout: 20_000 }).toContain("TERM=xterm-256color");

    // 2. 落脚点是会话的工程文件夹，不是 app 的 cwd。
    //    终端只有 80 列，长路径会被折行——比对前先把换行抹掉
    await typeLine(otto, "pwd");
    // macOS 的 /var/folders 是 /private/var 的软链，pwd 可能吐任一种
    const real = ws.replace(/^\/var\//, "/private/var/");
    await expect
      .poll(async () => (await screenText(otto)).replace(/\n/g, ""), { timeout: 20_000 })
      .toContain(real.replace("/private", ""));

    // 7. ⌃` 再按一次关掉
    await win.keyboard.press("Control+`");
    await expect(win.locator(".xterm-screen")).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#123/#117-3/4 关面板不杀进程、切走再回来输出连续；两个标签各跑各的不串台", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话好开终端");
    await win.keyboard.press("Control+`");
    await expect(win.locator(".xterm-screen").first()).toBeVisible({ timeout: 20_000 });

    // 3. 起一个一直吐东西的进程，关面板 → 切去 Git Graph → 再开终端
    await typeLine(otto, "i=0; while true; do i=$((i+1)); echo tick$i; sleep 1; done");
    await expect.poll(() => screenText(otto), { timeout: 20_000 }).toContain("tick2");

    await win.keyboard.press("Control+`");
    await expect(win.locator(".xterm-screen")).toHaveCount(0);
    await win.waitForTimeout(3000);
    await win.keyboard.press("Control+`");
    await expect(win.locator(".xterm-screen").first()).toBeVisible({ timeout: 20_000 });
    // 进程没死：数字接着往上走（关面板期间它一直在跑）
    await expect.poll(() => screenText(otto), { timeout: 20_000 }).toContain("tick6");
    // 输出连续：关面板之前那几行还在，不是从「切回来那一刻」重新开始
    expect(await screenText(otto)).toContain("tick2");
    await win.keyboard.press("Control+c");

    // 4. ＋ 开第二个标签：两个标签各跑各的
    await win.getByRole("button", { name: "新终端" }).click();
    await expect.poll(async () => (await win.locator(".xterm-rows").count()) >= 1).toBe(true);
    await typeLine(otto, "echo 这是第二个标签");
    await expect.poll(() => screenText(otto), { timeout: 20_000 }).toContain("这是第二个标签");
    expect(await screenText(otto), "第二个标签串到了第一个的输出").not.toContain("tick2");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#123/#117-6 关标签 → 进程死；关整个 app → 不留孤儿", async () => {
  const marker = `ottoe2e${Date.now().toString(36)}`;
  const alive = (m: string): boolean => {
    try {
      execSync(`pgrep -f ${m}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };

  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话好开终端");
    await win.keyboard.press("Control+`");
    await expect(win.locator(".xterm-screen").first()).toBeVisible({ timeout: 20_000 });

    // 记号得出现在**命令行**里 pgrep -f 才找得到（argv[0] 那个花招在 macOS 上
    // 不算数：ps 显示的是 exec 出来的名字）。所以把它写进脚本的**文件名**
    writeFileSync(join(ws, `${marker}-tab.sh`), "sleep 900\n");
    writeFileSync(join(ws, `${marker}-app.sh`), "sleep 900\n");
    await typeLine(otto, `sh ${join(ws, `${marker}-tab.sh`)}`);
    await expect.poll(() => alive(`${marker}-tab`), { timeout: 20_000 }).toBe(true);

    // 关标签 → 那个进程跟着死
    // 标签行在面板顶栏，标签排在「新终端」之前；那颗 × 平时是 opacity-0，
    // 悬停才现身（它是标签按钮里的一个 svg，不是独立按钮 —— 按钮套按钮是非法
    // DOM，和 SubagentSettings 里内置行的取舍同源）
    const panelHeader = win
      .locator("header")
      .filter({ has: win.getByRole("button", { name: "新终端" }) });
    const tab = panelHeader.locator("button").first();
    await tab.hover();
    await tab.locator("svg").click();
    await expect.poll(() => alive(`${marker}-tab`), { timeout: 20_000 }).toBe(false);

    // 关整个 app → 不留孤儿（ad-hoc 签名的包里 spawn-helper 最容易在这儿出事）
    await win.getByRole("button", { name: "新终端" }).click();
    await expect(win.locator(".xterm-screen").first()).toBeVisible({ timeout: 20_000 });
    await typeLine(otto, `sh ${join(ws, `${marker}-app.sh`)}`);
    await expect.poll(() => alive(`${marker}-app`), { timeout: 20_000 }).toBe(true);

    await otto.close();
    await expect.poll(() => alive(`${marker}-app`), { timeout: 20_000 }).toBe(false);
  } finally {
    await otto.close();
    try {
      execSync(`pkill -f ${marker} || true`, { stdio: "pipe" });
    } catch {
      // 已经没了
    }
  }
});

test("#123/#117-5 拖分隔线改宽度 → fit 生效：PTY 那侧的列数真的跟着变了", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话好开终端");
    await win.keyboard.press("Control+`");
    await expect(win.locator(".xterm-screen").first()).toBeVisible({ timeout: 20_000 });

    // 清单原文是「拖分隔线改宽度 → vim 里画面不歪」。「画面歪不歪」是人眼的事，
    // 但它歪的**原因**只有一个：fit 没把新尺寸告诉 PTY，于是 shell 还按旧列数
    // 排版。所以这里验那个原因 —— 列数是从 PTY 里问出来的（tput cols），
    // 不是从 DOM 上量出来的
    const cols = async (): Promise<number> => {
      await typeLine(otto, "tput cols");
      await win.waitForTimeout(700);
      const lines = (await screenText(otto)).trim().split("\n");
      return Number(lines.at(-2));
    };
    const before = await cols();
    expect(before).toBeGreaterThan(0);

    // 把分隔线往左拖：面板变宽
    const handle = win.locator("[data-panel-resize-handle-id]").first();
    const box = (await handle.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 10 });
    await win.mouse.up();
    await win.waitForTimeout(1000);
    expect(await cols(), "拖宽了但 PTY 还按旧列数排版 —— fit 没生效").toBeGreaterThan(before);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
