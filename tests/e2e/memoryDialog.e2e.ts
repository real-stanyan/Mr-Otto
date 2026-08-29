// 记忆设置页那扇「查看 / 编辑」弹窗的真机验收：内容不许画到卡片外面去。
//
// 这条 bug 的样子很有迷惑性 —— 看起来像"弹窗变透明了"：卡片底色只有 720px
// 那一块，内容却横着铺满整个窗口，于是页面上的 USER/PROJECT 卡片和弹窗的
// 正文叠在一起，读作一层半透明的玻璃。真相是栅格轨道被撑开了。
//
// 触发条件是三个东西凑齐，少一个都复现不出来：
//   ① 有项目记忆（MemorySettings 里 `projects.length === 0 ? {} : { entryAction }`
//      —— 没有项目档时那个条目列表根本不渲染）
//   ② 列表行用 `truncate`（= white-space:nowrap，min-content 是一整行宽）
//   ③ 弹窗是 grid，子项默认 min-width:auto，于是 ② 的 min-content 成了轨道宽
// 所以门禁里的单元测试照不到它，这里得把三样都摆好。

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, openSettings } from "./harness.js";

const LONG =
  "2026-08 首页重设计：分屏一屏 100svh 锁死——左 65vw 深色 Dither shader（src/components/dither-background.tsx）+水獭头像 scale(1.35)；右 35vw Apple 官网式白底排版，标题 clamp(2.5rem,5vw,4rem)";

test("记忆弹窗：长条目 + 项目档在场，内容仍待在卡片里", async () => {
  const otto = await launchOtto({});
  try {
    const { win } = otto;
    // 复现要的是"近全屏"：窗口越宽，被撑开的轨道越显眼
    await otto.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) throw new Error("没有窗口——launchOtto 应该已经等到 firstWindow");
      w.setSize(1760, 1120);
      w.center();
    });

    const dir = join(otto.userConfig, "memories");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "MEMORY.md"),
      Array.from({ length: 6 }, (_, i) => `${LONG}（第 ${i + 1} 条）`).join("\n§\n"),
      "utf8"
    );
    // 条件 ①：有一份项目记忆，MEMORY 那份才会长出条目列表
    const proj = join(dir, "projects", "abc123def456");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "root.txt"), "/Users/somebody/Github/Mr_Otto", "utf8");
    writeFileSync(join(proj, "MEMORY.md"), "项目记忆一条", "utf8");

    await openSettings(win, "记忆");
    await win.getByRole("button", { name: "查看 / 编辑" }).first().click();

    const dialog = win.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // 入场动画跑完再量，否则量到的是 scale(0.96) 那一帧
    await expect
      .poll(async () => dialog.evaluate((el) => getComputedStyle(el).opacity), { timeout: 5_000 })
      .toBe("1");

    // ① 没有任何一个子孙画到卡片左右边界外面
    const strays = await dialog.evaluate((el) => {
      const card = el.getBoundingClientRect();
      const out: string[] = [];
      el.querySelectorAll("*").forEach((n) => {
        const r = n.getBoundingClientRect();
        if (r.width === 0) return;
        if (r.right > card.right + 1 || r.left < card.left - 1) {
          out.push(`${n.tagName}.${String(n.className).slice(0, 30)} ${Math.round(r.left)}..${Math.round(r.right)}`);
        }
      });
      return out;
    });
    expect(strays).toEqual([]);

    // ② 卡片自己待在视口里，页脚够得着（bug 现场里"保存"被顶出屏幕）
    const fits = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
    });
    expect(fits.left).toBeGreaterThanOrEqual(-1);
    expect(fits.right).toBeLessThanOrEqual(fits.vw + 1);
    expect(fits.top).toBeGreaterThanOrEqual(-1);
    expect(fits.bottom).toBeLessThanOrEqual(fits.vh + 1);
    await expect(win.getByRole("button", { name: "保存" })).toBeVisible();

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
