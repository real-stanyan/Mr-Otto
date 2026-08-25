// simulatorHub —— 主进程的 iOS 模拟器台账(issue #401)。
//
// 这里刻意不 import electron、也不 import child_process:真正跑 xcrun 的
// run、真正把 PNG 缩小的 capture 都从外面注入(browserHub 同款手法)。
// 好处还是那个:开机/关机/选设备/坐标换算/输入分发这一整套逻辑能在普通
// vitest 里跑,不用有 Xcode、不用有「辅助功能」授权、不用起 Electron。
//
// 一台机器只有一套模拟器,所以 hub 是 app 级的、不按会话分(与 browserHub
// 一个会话一个浏览器相反):agent 在会话 A 里点的那一下,和人在面板上点的
// 那一下,落的是同一台设备。
//
// 输入通道(Swift helper)可以缺席:缺了照样能看画面、能开关机、能装 app,
// 只是点不了——SimState.inputReady 就是这件事的对外投影。

import {
  pixelToScreen,
  screenToPixel,
  type SimButton,
  type SimDevice,
  type SimFrame,
  type SimState,
  type SimUiElement,
} from "../shared/simulator.js";
import type { SimulatorCapability } from "../world/executionWorld.js";
import type { SimInputBridge } from "./simInputBridge.js";

/** 跑一条外部命令。注入的实现负责真的 spawn;这里只关心三件事的结果 */
export type RunFn = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** 截一帧并编码好。注入的实现负责 simctl 落盘 + 缩放 + base64
    (缩放要解 PNG,那是 Electron nativeImage 的活,hub 不碰) */
export type CaptureFn = (
  udid: string
) => Promise<{ image: string; mime: "image/png" | "image/jpeg"; width: number; height: number }>;

/** 画面轮询的间隔。500ms 不是随手挑的:simctl 截一次 iPhone 全屏实测
    150~300ms,再快只是让 CPU 空转;再慢人会觉得"点了没反应" */
const FRAME_INTERVAL_MS = 500;

/** simctl list --json 里一台设备的样子(只挑用得上的字段) */
interface SimctlDevice {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-4" → "iOS 26.4" */
export function runtimeLabel(key: string): string {
  const tail = key.split(".").pop() ?? key;
  const m = /^([A-Za-z]+)-(.+)$/.exec(tail);
  if (!m) return tail;
  return `${m[1]} ${m[2]!.replace(/-/g, ".")}`;
}

/** simctl list devices --json 的输出 → SimDevice[]。
    解析单独拎成纯函数:这是最容易随 Xcode 版本变形的一块,值得单独测 */
export function parseDeviceList(stdout: string): SimDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const devices = (parsed as { devices?: Record<string, SimctlDevice[]> }).devices;
  if (!devices || typeof devices !== "object") return [];
  const out: SimDevice[] = [];
  for (const [runtimeKey, list] of Object.entries(devices)) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      if (typeof d.udid !== "string" || typeof d.name !== "string") continue;
      if (d.isAvailable === false) continue;
      const state = typeof d.state === "string" ? d.state : "Unknown";
      out.push({
        udid: d.udid,
        name: d.name,
        runtime: runtimeLabel(runtimeKey),
        state,
        booted: state === "Booted",
      });
    }
  }
  return out;
}

/** simctl 那句"已经开着了"不该当失败:boot 要幂等,重复开机是常态
    (人先在 Simulator.app 里开了,agent 再来一次) */
function isAlreadyBooted(stderr: string): boolean {
  return /current state: Booted|Unable to boot device in current state: Booted/i.test(stderr);
}

export interface SimulatorHub {
  capability(): SimulatorCapability;
  /** 渲染层要的那份状态,现算 */
  state(): Promise<SimState>;
  select(udid: string | null): Promise<void>;
  /** 面板开着才轮询画面:关了就停,别让一台没人看的设备一直吃 CPU */
  startStream(): void;
  stopStream(): void;
  /** 弹一次系统的「辅助功能」授权框(用户点面板上那颗按钮才走这条) */
  requestInputPermission(): Promise<boolean>;
  dispose(): void;
}

export function createSimulatorHub(opts: {
  run: RunFn;
  capture: CaptureFn;
  /** 输入通道。null = 这台机器上没有 helper 二进制(或非 macOS) */
  input: SimInputBridge | null;
  push: { state: (s: SimState) => void; frame: (f: SimFrame) => void };
  log?: (m: string) => void;
  /** 测试里换掉,免得真等。句柄类型用 unknown:Node 的 Timeout 和 DOM 的 number
      在同一个 tsconfig 下都在,写死哪个都会在另一边红 */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: unknown) => void;
}): SimulatorHub {
  const log = opts.log ?? (() => {});
  const setIntervalFn = opts.setIntervalFn ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearIntervalFn =
    opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));

  let selected: string | null = null;
  let devices: SimDevice[] = [];
  let lastError: string | undefined;
  let lastFrame: { width: number; height: number } | null = null;
  let inputReady = false;
  let timer: unknown = null;
  let capturing = false;

  const refreshDevices = async (): Promise<SimDevice[]> => {
    const r = await opts.run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
    devices = parseDeviceList(r.stdout);
    // 选中的那台没了(删设备/换 Xcode)就松手,别让后续操作打在一个不存在的 udid 上
    if (selected && !devices.some((d) => d.udid === selected)) selected = null;
    // 没选过就跟着"已经开着的那台"走:人多半刚在 Simulator.app 里开了一台
    if (!selected) selected = devices.find((d) => d.booted)?.udid ?? null;
    return devices;
  };

  /** 选中那台的 udid;没有就抛人话(工具层原样喂给模型) */
  const requireUdid = async (udid?: string): Promise<string> => {
    if (udid) return udid;
    if (selected) return selected;
    await refreshDevices();
    if (!selected) throw new Error("没有选中任何模拟器设备:先 list 看有哪些,再 boot 一台");
    return selected;
  };

  const requireInput = (): SimInputBridge => {
    if (!opts.input) {
      throw new Error(
        "这台机器上没有模拟器输入通道(helper 二进制缺失,或不是 macOS):画面能看,点击/打字用不了"
      );
    }
    return opts.input;
  };

  const projectState = async (): Promise<SimState> => {
    await refreshDevices();
    const sel = devices.find((d) => d.udid === selected) ?? null;
    return {
      devices,
      selectedUdid: selected,
      booted: !!sel?.booted,
      streaming: timer !== null,
      inputReady,
      ...(lastError ? { lastError } : {}),
    };
  };

  const pushState = () => {
    void projectState().then(opts.push.state).catch((e) => log(`模拟器状态投影失败:${String(e)}`));
  };

  /** 出错落 lastError 并推一次:面板上要看得见,不能只在 agent 那边报 */
  const fail = (e: unknown): never => {
    lastError = e instanceof Error ? e.message : String(e);
    pushState();
    throw e;
  };

  const ok = () => {
    if (lastError !== undefined) {
      lastError = undefined;
      pushState();
    }
  };

  const shoot = async (udid?: string): Promise<SimFrame> => {
    const id = await requireUdid(udid);
    const shot = await opts.capture(id);
    lastFrame = { width: shot.width, height: shot.height };
    return {
      udid: id, image: shot.image, mime: shot.mime,
      width: shot.width, height: shot.height, ts: Date.now(),
    };
  };

  /** 几何:这次要用的截图尺寸 + 设备屏在 macOS 屏幕上的矩形。
      两个必须成对拿——坐标换算是这两者之间的比例,拿一半没有意义。
      矩形每次现问 helper,不缓存:窗口随时可能被拖走,缓存旧值的代价是
      点歪,而且歪得没有症状(点到了别的控件上),最难查 */
  const geometry = async (): Promise<{
    shot: { width: number; height: number };
    rect: { x: number; y: number; width: number; height: number };
  }> => {
    const bridge = requireInput();
    let shot = lastFrame;
    if (!shot) {
      const f = await shoot();
      shot = { width: f.width, height: f.height };
    }
    const r = await bridge.send({ type: "windowRect", shotWidth: shot.width, shotHeight: shot.height });
    if (!r.ok || !r.rect) throw new Error(r.error ?? "拿不到模拟器窗口位置");
    return { shot, rect: r.rect };
  };

  const capability: SimulatorCapability = {
    async list() {
      try {
        const d = await refreshDevices();
        ok();
        return d;
      } catch (e) {
        return fail(e);
      }
    },

    async boot(udid?: string) {
      try {
        const id = await requireUdid(udid);
        const r = await opts.run("xcrun", ["simctl", "boot", id], { timeoutMs: 120_000 });
        if (r.code !== 0 && !isAlreadyBooted(r.stderr)) {
          throw new Error(`开机失败:${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
        }
        // Simulator.app 必须在前台开着那台设备:画面是从它那儿截的,
        // 点击也是发给它的窗口。simctl boot 只起后台设备,不开窗
        await opts.run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", id]);
        await opts.run("xcrun", ["simctl", "bootstatus", id, "-b"], { timeoutMs: 180_000 });
        selected = id;
        await refreshDevices();
        ok();
        pushState();
        const dev = devices.find((d) => d.udid === id);
        if (!dev) throw new Error(`开机后找不到这台设备:${id}`);
        return dev;
      } catch (e) {
        return fail(e);
      }
    },

    async shutdown(udid?: string) {
      try {
        const id = await requireUdid(udid);
        const r = await opts.run("xcrun", ["simctl", "shutdown", id], { timeoutMs: 60_000 });
        if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) {
          throw new Error(`关机失败:${r.stderr.trim() || `exit ${r.code}`}`);
        }
        await refreshDevices();
        ok();
        pushState();
      } catch (e) {
        return fail(e);
      }
    },

    async screenshot() {
      try {
        const f = await shoot();
        ok();
        return f;
      } catch (e) {
        return fail(e);
      }
    },

    async describe(): Promise<SimUiElement[]> {
      try {
        const bridge = requireInput();
        // 先截一帧再问几何:元素框要换算进"当前这一帧"的像素空间,
        // 用一帧陈旧的尺寸换算,设备转屏之后就全错了
        await shoot();
        const { shot, rect } = await geometry();
        const r = await bridge.send({ type: "describe" });
        if (!r.ok) throw new Error(r.error ?? "读不到无障碍树");
        const els = (r.elements ?? []).map((e) => ({
          role: e.role,
          label: e.label,
          ...(e.value ? { value: e.value } : {}),
          frame: screenToPixel(e, shot, rect),
        }));
        ok();
        return els;
      } catch (e) {
        return fail(e);
      }
    },

    async tap(x, y) {
      try {
        const bridge = requireInput();
        const { shot, rect } = await geometry();
        const p = pixelToScreen({ x, y }, shot, rect);
        const r = await bridge.send({ type: "tap", x: p.x, y: p.y });
        if (!r.ok) throw new Error(r.error ?? "点击失败");
        ok();
      } catch (e) {
        return fail(e);
      }
    },

    async swipe(from, to, durationMs) {
      try {
        const bridge = requireInput();
        const { shot, rect } = await geometry();
        const a = pixelToScreen(from, shot, rect);
        const b = pixelToScreen(to, shot, rect);
        const r = await bridge.send({
          type: "swipe",
          x: a.x, y: a.y, x2: b.x, y2: b.y,
          ...(durationMs !== undefined ? { duration: durationMs } : {}),
        });
        if (!r.ok) throw new Error(r.error ?? "划动失败");
        ok();
      } catch (e) {
        return fail(e);
      }
    },

    async typeText(text) {
      try {
        const r = await requireInput().send({ type: "text", text });
        if (!r.ok) throw new Error(r.error ?? "打字失败");
        ok();
      } catch (e) {
        return fail(e);
      }
    },

    async pressButton(button: SimButton) {
      try {
        const r = await requireInput().send({ type: "key", button });
        if (!r.ok) throw new Error(r.error ?? "按键失败");
        ok();
      } catch (e) {
        return fail(e);
      }
    },

    async openUrl(url) {
      try {
        const id = await requireUdid();
        const r = await opts.run("xcrun", ["simctl", "openurl", id, url], { timeoutMs: 30_000 });
        if (r.code !== 0) throw new Error(`打开链接失败:${r.stderr.trim() || `exit ${r.code}`}`);
        ok();
      } catch (e) {
        return fail(e);
      }
    },

    async install(appPath) {
      try {
        const id = await requireUdid();
        const r = await opts.run("xcrun", ["simctl", "install", id, appPath], { timeoutMs: 300_000 });
        if (r.code !== 0) throw new Error(`安装失败:${r.stderr.trim() || `exit ${r.code}`}`);
        ok();
      } catch (e) {
        return fail(e);
      }
    },

    async launch(bundleId) {
      try {
        const id = await requireUdid();
        const r = await opts.run("xcrun", ["simctl", "launch", id, bundleId], { timeoutMs: 60_000 });
        if (r.code !== 0) throw new Error(`启动失败:${r.stderr.trim() || `exit ${r.code}`}`);
        ok();
      } catch (e) {
        return fail(e);
      }
    },

    async terminate(bundleId) {
      try {
        const id = await requireUdid();
        const r = await opts.run("xcrun", ["simctl", "terminate", id, bundleId], { timeoutMs: 30_000 });
        if (r.code !== 0) throw new Error(`结束失败:${r.stderr.trim() || `exit ${r.code}`}`);
        ok();
      } catch (e) {
        return fail(e);
      }
    },

    inputReady() {
      return inputReady;
    },
  };

  // 开局问一次 helper:有没有二进制、有没有授权。答案进 SimState,
  // 面板据此决定要不要显示那颗「去授权」按钮
  if (opts.input) {
    void opts.input
      .send({ type: "probe" })
      .then((r) => {
        inputReady = r.ok && r.trusted === true;
        pushState();
      })
      .catch((e) => log(`模拟器输入通道探测失败:${String(e)}`));
  }

  return {
    capability: () => capability,
    state: projectState,

    async select(udid) {
      selected = udid;
      lastFrame = null; // 换设备 = 换分辨率,旧尺寸不能拿来算坐标
      pushState();
    },

    startStream() {
      if (timer) return;
      timer = setIntervalFn(() => {
        if (capturing || !selected) return;
        capturing = true;
        void shoot()
          .then((f) => {
            opts.push.frame(f);
            ok();
          })
          .catch((e) => {
            // 轮询里的失败不抛(没人接):落 lastError 让面板看得见。
            // 常见原因是设备关机了——这不是异常,是状态变了
            lastError = e instanceof Error ? e.message : String(e);
            pushState();
          })
          .finally(() => {
            capturing = false;
          });
      }, FRAME_INTERVAL_MS);
      pushState();
    },

    stopStream() {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
      pushState();
    },

    async requestInputPermission() {
      const r = await requireInput().send({ type: "requestPermission" });
      inputReady = r.ok && r.trusted === true;
      pushState();
      return inputReady;
    },

    dispose() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
  };
}
