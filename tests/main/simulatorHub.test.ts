import { describe, it, expect, vi } from "vitest";
import {
  createSimulatorHub,
  parseDeviceList,
  runtimeLabel,
  type RunFn,
} from "../../src/main/simulatorHub.js";
import type { SimInputBridge, SimInputRequest, SimInputResponse } from "../../src/main/simInputBridge.js";
import type { SimFrame, SimState } from "../../src/shared/simulator.js";

const LIST_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      { udid: "U-1", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true },
      { udid: "U-2", name: "iPhone Air", state: "Booted", isAvailable: true },
      { udid: "U-3", name: "老设备", state: "Shutdown", isAvailable: false },
    ],
  },
});

/** 假 xcrun:记下每条命令,按前缀给不同结果 */
function fakeRun(overrides: Record<string, { stdout?: string; stderr?: string; code?: number }> = {}) {
  const calls: string[][] = [];
  const run: RunFn = async (file, args) => {
    calls.push([file, ...args]);
    const key = args.slice(0, 2).join(" ");
    const o = overrides[key] ?? overrides[args[1] ?? ""] ?? {};
    if (args.includes("list")) return { stdout: o.stdout ?? LIST_JSON, stderr: "", code: 0 };
    return { stdout: o.stdout ?? "", stderr: o.stderr ?? "", code: o.code ?? 0 };
  };
  return { run, calls };
}

/** 假输入 helper:记下每条请求,窗口矩形固定 */
function fakeInput(handler?: (r: SimInputRequest) => SimInputResponse) {
  const sent: SimInputRequest[] = [];
  const bridge: SimInputBridge = {
    async send(req) {
      sent.push(req);
      if (handler) return handler(req);
      if (req.type === "probe") return { id: 0, ok: true, trusted: true, simulatorRunning: true };
      if (req.type === "windowRect") {
        return { id: 0, ok: true, rect: { x: 600, y: 60, width: 240, height: 522 }, rectSource: "screen" };
      }
      return { id: 0, ok: true };
    },
    dispose() {},
  };
  return { bridge, sent };
}

/** 假截图:480x1044(实测 iPhone 缩略图的样子) */
const capture = vi.fn(async (_udid: string) => ({
  image: "AAAA",
  mime: "image/jpeg" as const,
  width: 480,
  height: 1044,
}));

function makeHub(o: { run?: RunFn; input?: SimInputBridge | null } = {}) {
  const states: SimState[] = [];
  const frames: SimFrame[] = [];
  const timers: (() => void)[] = [];
  const hub = createSimulatorHub({
    run: o.run ?? fakeRun().run,
    capture,
    input: o.input === undefined ? fakeInput().bridge : o.input,
    push: { state: (s) => states.push(s), frame: (f) => frames.push(f) },
    setIntervalFn: (cb) => {
      timers.push(cb);
      return timers.length;
    },
    clearIntervalFn: () => void timers.pop(),
  });
  return { hub, states, frames, tick: () => timers.forEach((t) => t()) };
}

describe("simctl 输出解析", () => {
  it("运行时 key 变人话", () => {
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-26-4")).toBe("iOS 26.4");
    expect(runtimeLabel("watchOS-11-0")).toBe("watchOS 11.0");
  });

  it("不可用的设备被滤掉,Booted 变成 booted 标记", () => {
    const d = parseDeviceList(LIST_JSON);
    expect(d.map((x) => x.udid)).toEqual(["U-1", "U-2"]);
    expect(d.find((x) => x.udid === "U-2")!.booted).toBe(true);
    expect(d[0]!.runtime).toBe("iOS 26.4");
  });

  it("simctl 吐了非 JSON(换版本/报错)不炸,给空列表", () => {
    expect(parseDeviceList("xcrun: error: blah")).toEqual([]);
  });
});

describe("模拟器 hub", () => {
  it("没选过设备时跟着「已经开着的那台」走", async () => {
    const { hub } = makeHub();
    await hub.capability().list();
    expect((await hub.state()).selectedUdid).toBe("U-2");
  });

  it("一台都没开机时也要选中一台 —— 停在 null 会让开机按钮永远是灰的", async () => {
    const allShutdown = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
          { udid: "U-1", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true },
          { udid: "U-2", name: "iPhone Air", state: "Shutdown", isAvailable: true },
        ],
      },
    });
    const f = fakeRun({ list: { stdout: allShutdown } });
    const { hub } = makeHub({ run: f.run });
    await hub.capability().list();
    const st = await hub.state();
    expect(st.selectedUdid).toBe("U-1");
    expect(st.booted).toBe(false);
  });

  it("boot:simctl 说「已经开着了」不算失败,并且顺带把 Simulator.app 切过去", async () => {
    const f = fakeRun({ boot: { code: 164, stderr: "Unable to boot device in current state: Booted" } });
    const { hub } = makeHub({ run: f.run });
    const d = await hub.capability().boot("U-1");
    expect(d.udid).toBe("U-1");
    expect(f.calls.some((c) => c[0] === "open" && c.includes("-CurrentDeviceUDID"))).toBe(true);
    expect(f.calls.some((c) => c.includes("bootstatus"))).toBe(true);
  });

  it("boot 真失败时抛人话,并且把原因推给面板", async () => {
    const f = fakeRun({ boot: { code: 1, stderr: "device not found" } });
    const { hub, states } = makeHub({ run: f.run });
    await expect(hub.capability().boot("U-1")).rejects.toThrow(/device not found/);
    expect(states.at(-1)!.lastError).toMatch(/device not found/);
  });

  it("tap:截图像素按窗口矩形换算成屏幕点再发给 helper", async () => {
    const inp = fakeInput();
    const { hub } = makeHub({ input: inp.bridge });
    await hub.capability().list();
    await hub.capability().tap(240, 522); // 帧正中
    const t = inp.sent.find((r) => r.type === "tap")!;
    // 矩形 (600,60) 240x522 的正中 = (720, 321)
    expect(t.x).toBeCloseTo(720, 6);
    expect(t.y).toBeCloseTo(321, 6);
  });

  it("窗口矩形每次现问 —— 窗口被拖走之后点的是新位置", async () => {
    let x = 600;
    const inp = fakeInput((r) => {
      if (r.type === "windowRect") {
        return { id: 0, ok: true, rect: { x, y: 60, width: 240, height: 522 } };
      }
      return { id: 0, ok: true, trusted: true };
    });
    const { hub } = makeHub({ input: inp.bridge });
    await hub.capability().list();
    await hub.capability().tap(0, 0);
    x = 900; // 人把窗口拖到别处
    await hub.capability().tap(0, 0);
    const taps = inp.sent.filter((r) => r.type === "tap");
    expect(taps[0]!.x).toBe(600);
    expect(taps[1]!.x).toBe(900);
  });

  it("describe:元素框从屏幕坐标换算回截图像素", async () => {
    const inp = fakeInput((r) => {
      if (r.type === "windowRect") return { id: 0, ok: true, rect: { x: 600, y: 60, width: 240, height: 522 } };
      if (r.type === "describe") {
        return {
          id: 0, ok: true,
          elements: [{ role: "AXButton", label: "登录", x: 660, y: 321, width: 120, height: 26.1 }],
        };
      }
      return { id: 0, ok: true, trusted: true };
    });
    const { hub } = makeHub({ input: inp.bridge });
    await hub.capability().list();
    const els = await hub.capability().describe();
    // 屏幕上的 (660,321) 相对矩形原点是 (60,261),缩放系数 480/240 = 2
    expect(els[0]!.frame.x).toBeCloseTo(120, 6);
    expect(els[0]!.frame.y).toBeCloseTo(522, 6);
    expect(els[0]!.frame.width).toBeCloseTo(240, 6);
  });

  it("helper 缺席:画面照常,点击给的是「这台机器没有输入通道」而不是静默失败", async () => {
    const { hub } = makeHub({ input: null });
    await hub.capability().list();
    await expect(hub.capability().screenshot()).resolves.toMatchObject({ width: 480 });
    await expect(hub.capability().tap(1, 1)).rejects.toThrow(/输入通道/);
    expect((await hub.state()).inputReady).toBe(false);
  });

  it("轮询:开了才推帧,关了就不推;streaming 反映在状态里", async () => {
    const { hub, frames, tick } = makeHub();
    await hub.capability().list();
    hub.startStream();
    expect((await hub.state()).streaming).toBe(true);
    tick();
    await vi.waitFor(() => expect(frames.length).toBe(1));
    hub.stopStream();
    tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(frames.length).toBe(1);
    expect((await hub.state()).streaming).toBe(false);
  });

  it("轮询里截图失败不抛(没人接),而是落进面板看得见的 lastError", async () => {
    const boom = vi.fn(async () => {
      throw new Error("设备关机了");
    });
    const states: SimState[] = [];
    const timers: (() => void)[] = [];
    const hub = createSimulatorHub({
      run: fakeRun().run,
      capture: boom,
      input: fakeInput().bridge,
      push: { state: (s) => states.push(s), frame: () => {} },
      setIntervalFn: (cb) => (timers.push(cb), 1),
      clearIntervalFn: () => {},
    });
    await hub.capability().list();
    hub.startStream();
    timers[0]!();
    await vi.waitFor(() => expect(states.at(-1)!.lastError).toMatch(/设备关机了/));
    hub.dispose();
  });

  it("换设备清掉上一帧的尺寸 —— 不同分辨率的坐标不能混用", async () => {
    const inp = fakeInput();
    const { hub } = makeHub({ input: inp.bridge });
    await hub.capability().list();
    await hub.capability().screenshot();
    capture.mockClear();
    await hub.select("U-1");
    await hub.capability().tap(1, 1);
    // 换了设备,tap 之前必须重新截一帧拿尺寸
    expect(capture).toHaveBeenCalled();
  });
});
