// 会话视角跟不跟模型的输出走。
//
// 为什么单测不够:跟随不是本仓写的一段逻辑,是「视口上挂的那几个 prop」+「浏览器
// 真的排版出了一个比视口高的滚动区」两件事合起来的结果(assistant-ui 的
// useThreadViewportAutoScroll 靠 ResizeObserver + scrollHeight 判定)。jsdom 没有布局,
// scrollHeight 永远是 0 —— 在那儿写多少个断言都量不到「有没有贴着底」。
// 所以这一条只能在真 Electron 里跑:一边流式吐字,一边量视口离底还有多远。
//
// 量的是两件事,而且是**一对**:跟随要真的跟(①),人一上滑要真的松手(②)。
// 只验前者的话,把 autoScroll 焊死也能全绿,而那是比不跟随更糟的界面 —— 用户想回头
// 看上面那段,视线被一次次拽回底部。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

/** 够长 —— 要长到撑出滚动条,并且在人上滑之后还剩得下一大截没吐完 */
const LONG_ANSWER = Array.from(
  { length: 60 },
  (_, i) => `第 ${i + 1} 段:这是一段用来把会话撑高的正文,好让视口真的有得滚。`
).join("\n\n");

test("直播的时候视线贴着底;人一上滑就松手", async () => {
  const fake = await startFakeModel((_req, index) =>
    // 一个字一个字地吐,中间留 8ms —— 用例要在"还在吐"的时候动手,吐完就量不到跟随了
    index === 0 ? { content: LONG_ANSWER, delayMs: 8 } : { content: "完。" }
  );
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "说点长的");

    const viewport = win.locator('[data-slot="aui_thread-viewport"]');
    await expect(viewport).toBeVisible({ timeout: 30_000 });
    const metrics = () =>
      viewport.evaluate((el) => ({
        top: el.scrollTop,
        height: el.scrollHeight,
        client: el.clientHeight,
      }));

    // ① 内容一撑出滚动条,视线就该贴着底。没长够高之前报一个大数,
    //    poll 会继续等 —— 不跟随的话这个数只会越滚越大,等到超时也降不下来
    await expect
      .poll(
        async () => {
          const m = await metrics();
          if (m.height < m.client * 1.5) return Number.MAX_SAFE_INTEGER;
          return Math.round(m.height - m.top - m.client);
        },
        { timeout: 30_000, message: "正文在长,视口却没跟着贴到底" }
      )
      .toBeLessThanOrEqual(8);

    // ② 人往上滑一下 —— 真滚轮,不是改 scrollTop:isUserScrollUp 判的是滚动事件
    await viewport.hover();
    await win.mouse.wheel(0, -400);
    await win.waitForTimeout(300); // 等这一下滑稳
    const before = await metrics();
    expect(before.height - before.top - before.client, "上滑之后还贴着底,那是没滑动").toBeGreaterThan(50);

    // 还在吐字的这一秒里,视线不该被拽回去
    await win.waitForTimeout(1500);
    const after = await metrics();
    expect(after.height, "这一秒里模型已经吐完了,量不到「跟随会不会抢回视线」").toBeGreaterThan(
      before.height
    );
    expect(Math.abs(after.top - before.top), "人上滑之后又被拽回了底部").toBeLessThanOrEqual(2);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
