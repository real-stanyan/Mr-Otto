// iOS 模拟器面板的真机验收（#401）。
//
// 这一栏和终端那栏同一个理由必须真跑：simctl 在不在、Simulator.app 有没有窗口、
// helper 二进制编没编出来、有没有「辅助功能」授权——全是运行时事实，读代码验不了。
//
// 用例刻意**不假设这台机器上有 Xcode**：没有的话面板该自己说"没有可用设备"，
// 而不是白屏或炸掉——那本身就是要验的降级行为。

import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";

/** 这台机器上此刻有没有已开机的设备。有才验得了画面链路——
    用例不自己开机:冷启一台模拟器要几十秒,不该压在 e2e 里 */
function bootedDevice(): string | null {
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "booted"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return /\(([0-9A-F-]{36})\) \(Booted\)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 这台机器上有没有可用的模拟器设备。没有 Xcode = xcrun 直接抛 */
function hasSimulators(): boolean {
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const devices = (JSON.parse(out) as { devices?: Record<string, unknown[]> }).devices ?? {};
    return Object.values(devices).some((list) => Array.isArray(list) && list.length > 0);
  } catch {
    return false;
  }
}

test("#401 面板开得出来：有 Xcode 就列出设备，没有就明说没有——不白屏", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话好开模拟器面板");

    await win.getByRole("button", { name: "更多" }).click();
    await win.getByRole("menuitem", { name: "iOS 模拟器" }).click();

    const picker = win.getByRole("combobox", { name: "模拟器设备" });
    await expect(picker).toBeVisible({ timeout: 20_000 });

    if (hasSimulators()) {
      // 设备列表是主进程现问 simctl 拿的:选项里至少有一台带运行时名字的设备
      await expect
        .poll(async () => (await picker.locator("option").allInnerTexts()).join("|"), {
          timeout: 30_000,
        })
        .toMatch(/iOS|iPadOS|watchOS/);
      // 有设备就一定有一台被选中,于是开机(或关机)那颗按钮是可按的。
      // 这条是回归钉:曾经"一台都没开机时 selected 停在 null",屏幕上下拉
      // 显示着第一台、按钮却永远是灰的——看着有设备,点不动
      await expect(
        win.getByRole("button", { name: /^开机|^关机/ })
      ).toBeEnabled({ timeout: 20_000 });
    } else {
      await expect(picker.locator("option")).toHaveText(/没有可用设备/, { timeout: 20_000 });
    }

    // 关掉面板:会话回到前台(面板只是收起,设备继续开着)
    await win.getByRole("button", { name: /^关闭面板/ }).click();
    await expect(picker).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#401 没授权时给的是出口,不是静默不响应", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话");
    await win.getByRole("button", { name: "更多" }).click();
    await win.getByRole("menuitem", { name: "iOS 模拟器" }).click();

    // e2e 起的是 Electron 开发二进制,它拿不到「辅助功能」授权(CI 上更不可能),
    // 所以这条横幅必然在。它是"点了没反应"这个最坏体验的唯一出口
    await expect(win.getByText(/还不能点/)).toBeVisible({ timeout: 20_000 });
    await expect(win.getByRole("button", { name: "去授权" })).toBeVisible();

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("#401 有已开机的设备时,画面真的流到面板上(截图→JPEG→IPC→<img> 整条链)", async () => {
  const booted = bootedDevice();
  test.skip(!booted, "这台机器上没有已开机的模拟器 —— 画面链路验不了");
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话");
    await win.getByRole("button", { name: "更多" }).click();
    await win.getByRole("menuitem", { name: "iOS 模拟器" }).click();

    // hub 没选过设备时会跟着"已经开着的那台"走,所以不用手选
    const shot = win.getByAltText("iOS 模拟器画面");
    await expect(shot).toBeVisible({ timeout: 30_000 });
    // 真的是一帧图,不是占位:data URI 有实际长度
    const src = await shot.getAttribute("src");
    expect(src?.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect((src ?? "").length).toBeGreaterThan(5_000);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
