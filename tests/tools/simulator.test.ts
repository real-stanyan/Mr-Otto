import { describe, it, expect, vi } from "vitest";
import { simulatorTool } from "../../src/tools/simulator.js";
import type { ExecutionWorld, SimulatorCapability } from "../../src/world/executionWorld.js";

function fakeWorld(sim?: Partial<SimulatorCapability>): ExecutionWorld {
  const base: SimulatorCapability = {
    list: async () => [
      { udid: "U-1", name: "iPhone 17 Pro", runtime: "iOS 26.4", state: "Booted", booted: true },
    ],
    boot: async () => ({ udid: "U-1", name: "iPhone 17 Pro", runtime: "iOS 26.4", state: "Booted", booted: true }),
    shutdown: async () => {},
    screenshot: async () => ({ udid: "U-1", image: "AA", mime: "image/jpeg", width: 480, height: 1044, ts: 0 }),
    describe: async () => [
      { role: "AXButton", label: "登录", frame: { x: 100, y: 200, width: 60, height: 40 } },
    ],
    tap: async () => {},
    swipe: async () => {},
    typeText: async () => {},
    pressButton: async () => {},
    openUrl: async () => {},
    install: async () => {},
    launch: async () => {},
    terminate: async () => {},
    inputReady: () => true,
  };
  return {
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
    simulator: { ...base, ...sim },
  };
}

const run = (args: object, world = fakeWorld()) => simulatorTool.run(args, world);

describe("simulator 工具", () => {
  it("这个世界没有模拟器时说清楚要什么,而不是崩", async () => {
    const bare: ExecutionWorld = {
      fs: { read: async () => "", write: async () => {} },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      http: { postJson: async () => ({}) },
    };
    await expect(run({ action: "list" }, bare)).rejects.toThrow(/Xcode/);
  });

  it("不认识的 action 直接报,不猜", async () => {
    await expect(run({ action: "explode" })).rejects.toThrow(/不认识的 action/);
  });

  it("list 把开着的那台标出来,并带上 udid", async () => {
    const out = await run({ action: "list" });
    expect(out).toContain("● iPhone 17 Pro");
    expect(out).toContain("U-1");
  });

  it("describe 给的坐标可以直接拿来 tap(中心点)", async () => {
    const out = await run({ action: "describe" });
    expect(out).toContain("[130,220] Button: 登录");
  });

  it("屏幕上一个元素都读不到时,给的是「下一步该干嘛」而不是空串", async () => {
    const out = await run({ action: "describe" }, fakeWorld({ describe: async () => [] }));
    expect(out).toMatch(/动画|无障碍标签|锁屏/);
  });

  it("screenshot 明说模型读不了像素 —— 免得它以为自己看过了", async () => {
    const out = await run({ action: "screenshot" });
    expect(out).toContain("480x1044");
    expect(out).toMatch(/describe/);
  });

  it("tap 把坐标原样交给能力层", async () => {
    const tap = vi.fn(async () => {});
    await run({ action: "tap", x: 12, y: 34 }, fakeWorld({ tap }));
    expect(tap).toHaveBeenCalledWith(12, 34);
  });

  it("坐标写成字符串也认(模型常这么干),但写成别的就报错", async () => {
    const tap = vi.fn(async () => {});
    await run({ action: "tap", x: "12", y: 34 }, fakeWorld({ tap }));
    expect(tap).toHaveBeenCalledWith(12, 34);
    await expect(run({ action: "tap", x: null, y: 1 })).rejects.toThrow(/必须是数字/);
  });

  it("swipe 缺终点时报的是缺哪个参数", async () => {
    await expect(run({ action: "swipe", x: 1, y: 2 })).rejects.toThrow(/x2/);
  });

  it("button 只收名单里的那几个", async () => {
    const pressButton = vi.fn(async () => {});
    await run({ action: "button", button: "home" }, fakeWorld({ pressButton }));
    expect(pressButton).toHaveBeenCalledWith("home");
    await expect(run({ action: "button", button: "volumeUp" })).rejects.toThrow(/home/);
  });

  it("能力层抛的错原样上浮(模型要看见真实原因)", async () => {
    const world = fakeWorld({
      tap: async () => {
        throw new Error("没有「辅助功能」权限");
      },
    });
    await expect(run({ action: "tap", x: 1, y: 1 }, world)).rejects.toThrow(/辅助功能/);
  });

  it("install / launch / terminate 走的是 bundle id 和路径,参数缺了就报", async () => {
    const launch = vi.fn(async () => {});
    await run({ action: "launch", bundle_id: "com.x.y" }, fakeWorld({ launch }));
    expect(launch).toHaveBeenCalledWith("com.x.y");
    await expect(run({ action: "install" })).rejects.toThrow(/app_path/);
  });

  it("不过审批门 —— 动作都落在模拟器里面(理由见工具文件头)", () => {
    expect(simulatorTool.requiresApproval).toBe(false);
  });
});
