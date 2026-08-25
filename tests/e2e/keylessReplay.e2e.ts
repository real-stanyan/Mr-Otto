// keyless 回放（issue #389）：**没有任何 API key** 时，历史会话照样打得开、
// 轨迹视图照样渲染。key 门只该在「发送」那一刻（modelRoute blocked → turn
// 失败给人话），查看历史（resume → 投影 → 轨迹）全程不需要模型。
//
// harness 天生 keyless（隔离 HOME、不碰网络，见 harness.ts 头注），这组用例
// 就是把这个事实钉成验收：产品哪天在启动/恢复路径上加了 key 门，这里先红。

import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";

test("无 key：会话建得起、发送失败给人话、轨迹视图照常渲染历史", async () => {
  // 显式清掉默认模型的 key：harness 会继承 process.env，开发机 shell 里可能
  // 真配着 DEEPSEEK_API_KEY——keyless 是这组用例的前提，不能靠碰运气
  const otto = await launchOtto({ env: { DEEPSEEK_API_KEY: "" } });
  const ws = mkdtempSync(join(tmpdir(), "otto-keyless-ws-"));
  try {
    // 发送会失败（没有 key，也不该有）——会话本身在发请求之前就已落盘
    await startSession(otto, ws, "keyless 轨迹验收");

    // 失败以人话浮出（modelRoute blocked 的文案指向设置页），不是白屏/裸异常
    await expect(otto.win.getByText(/还没配 key/).first()).toBeVisible({ timeout: 20_000 });

    // 轨迹视图：同一份日志的另一种投影，不碰模型
    await otto.win.getByRole("tab", { name: "轨迹" }).click();
    await expect(otto.win.getByText("keyless 轨迹验收").first()).toBeVisible();

    // 全程渲染层零异常：查看路径不该有任何「缺 key」引发的报错
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    rmSync(ws, { recursive: true, force: true });
  }
});
