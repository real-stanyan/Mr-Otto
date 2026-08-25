// simulator —— agent 操控 iOS 模拟器的那一把(issue #401)。
//
// 一把工具带 action 分发,而不是十三把独立工具:它们共用同一台设备、同一套
// 坐标系,拆开只会让模型的工具表膨胀十三行,而每一行都要重复解释一遍
// "坐标是截图像素"这件事。
//
// 不要审批(requiresApproval: false)的理由:所有动作都落在模拟器**里面**——
// 那是一台随时能抹掉重建的虚拟设备,不是用户的机器。唯一摸到宿主的是
// install 的那个路径,而它只是读一个 agent 本来就能用 read_file 读的目录。
// 真正危险的动作(rm、改配置)在 bash 那边,那把仍然过审批门。
//
// 「看」的主力是 describe(无障碍树),不是 screenshot:模型读不了像素,
// 而无障碍树给的是带标签和坐标的元素表——点击可以照着标签点,不用猜。

import { formatElement, type SimButton } from "../shared/simulator.js";
import type { Tool } from "./tool.js";

const ACTIONS = [
  "list", "boot", "shutdown", "screenshot", "describe",
  "tap", "swipe", "type", "button", "open_url", "install", "launch", "terminate",
] as const;
type Action = (typeof ACTIONS)[number];

const BUTTONS: SimButton[] = ["home", "lock", "siri", "shake"];

/** 数字参数的统一校验:模型偶尔会把坐标写成字符串,报清楚比默默 NaN 好 */
function num(v: unknown, name: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`simulator: 参数 ${name} 必须是数字,拿到的是 ${JSON.stringify(v)}`);
  }
  return n;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "") {
    throw new Error(`simulator: 参数 ${name} 必须是非空字符串`);
  }
  return v;
}

export const simulatorTool: Tool = {
  def: {
    name: "simulator",
    description:
      "操控本机的 iOS 模拟器(macOS + Xcode)。这块屏和用户共用:你点的和他在右侧栏面板里点的是同一台设备。\n" +
      "坐标一律是**截图像素**(describe 给的元素坐标可以直接拿来 tap)。\n" +
      "动作:\n" +
      "- list:列出可用设备\n" +
      "- boot / shutdown:开关机(udid 省略 = 当前选中那台)\n" +
      "- describe:读屏幕上的无障碍元素(带标签和中心坐标)。**这是你「看屏幕」的主力手段**\n" +
      "- screenshot:截一帧(推给用户的面板看)。你读不了像素,要知道屏上有什么用 describe\n" +
      "- tap / swipe / type / button:点、划、打字、按键(home/lock/siri/shake)。" +
      "type 打进当前焦点,所以先 tap 那个输入框\n" +
      "- open_url:开深链或网址;install:装 .app 目录;launch / terminate:起/杀某个 bundle id\n" +
      "点完等一下再 describe:界面有动画,立刻读会读到过渡中的那一帧。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "要做的事" },
        udid: { type: "string", description: "设备 udid(boot/shutdown 用;省略 = 当前选中那台)" },
        x: { type: "number", description: "tap/swipe 起点 x(截图像素)" },
        y: { type: "number", description: "tap/swipe 起点 y(截图像素)" },
        x2: { type: "number", description: "swipe 终点 x" },
        y2: { type: "number", description: "swipe 终点 y" },
        duration_ms: { type: "number", description: "swipe 时长,缺省 300" },
        text: { type: "string", description: "type 要打的文字" },
        button: { type: "string", enum: BUTTONS, description: "button 要按的键" },
        url: { type: "string", description: "open_url 的链接" },
        app_path: { type: "string", description: "install 的 .app 目录路径" },
        bundle_id: { type: "string", description: "launch / terminate 的 bundle id" },
      },
      required: ["action"],
    },
  },
  requiresApproval: false,

  async run(args, world) {
    const a = (args ?? {}) as Record<string, unknown>;
    const action = a["action"] as Action;
    if (!ACTIONS.includes(action)) {
      throw new Error(`simulator: 不认识的 action ${JSON.stringify(a["action"])}`);
    }
    const sim = world.simulator;
    if (!sim) {
      throw new Error(
        "simulator: 这个世界没有 iOS 模拟器(需要 macOS + 装了 Xcode 的机器)"
      );
    }

    switch (action) {
      case "list": {
        const devices = await sim.list();
        if (devices.length === 0) return "没有可用的模拟器设备(Xcode 里还没下载任何运行时?)";
        return devices
          .map((d) => `${d.booted ? "● " : "○ "}${d.name} — ${d.runtime} — ${d.state}\n  ${d.udid}`)
          .join("\n");
      }

      case "boot": {
        const udid = a["udid"];
        const d = await sim.boot(typeof udid === "string" ? udid : undefined);
        return `已开机:${d.name}(${d.runtime})\nudid ${d.udid}`;
      }

      case "shutdown": {
        const udid = a["udid"];
        await sim.shutdown(typeof udid === "string" ? udid : undefined);
        return "已关机";
      }

      case "screenshot": {
        const f = await sim.screenshot();
        return (
          `已截图 ${f.width}x${f.height},画面已推给用户的面板。\n` +
          "你读不了图里的像素——要知道屏幕上有什么,用 action:describe。"
        );
      }

      case "describe": {
        const els = await sim.describe();
        if (els.length === 0) {
          return (
            "无障碍树上一个元素都没有。可能是:屏幕还在动画中(等一下重试)、" +
            "当前 app 没给控件设无障碍标签、或者停在锁屏/开机画面上。"
          );
        }
        return (
          `屏幕上的元素(坐标 = 截图像素,可直接用于 tap):\n` + els.map(formatElement).join("\n")
        );
      }

      case "tap": {
        const x = num(a["x"], "x");
        const y = num(a["y"], "y");
        await sim.tap(x, y);
        return `已点击 (${Math.round(x)}, ${Math.round(y)})`;
      }

      case "swipe": {
        const from = { x: num(a["x"], "x"), y: num(a["y"], "y") };
        const to = { x: num(a["x2"], "x2"), y: num(a["y2"], "y2") };
        const ms = a["duration_ms"] === undefined ? undefined : num(a["duration_ms"], "duration_ms");
        await sim.swipe(from, to, ms);
        return `已划动 (${Math.round(from.x)}, ${Math.round(from.y)}) → (${Math.round(to.x)}, ${Math.round(to.y)})`;
      }

      case "type": {
        const text = str(a["text"], "text");
        await sim.typeText(text);
        return `已输入 ${JSON.stringify(text)}(打进的是当前焦点;没反应就先 tap 那个输入框)`;
      }

      case "button": {
        const b = a["button"];
        if (typeof b !== "string" || !BUTTONS.includes(b as SimButton)) {
          throw new Error(`simulator: button 只能是 ${BUTTONS.join(" / ")}`);
        }
        await sim.pressButton(b as SimButton);
        return `已按 ${b}`;
      }

      case "open_url": {
        const url = str(a["url"], "url");
        await sim.openUrl(url);
        return `已在模拟器里打开 ${url}`;
      }

      case "install": {
        const p = str(a["app_path"], "app_path");
        await sim.install(p);
        return `已安装 ${p}(接着用 launch 起它)`;
      }

      case "launch": {
        const id = str(a["bundle_id"], "bundle_id");
        await sim.launch(id);
        return `已启动 ${id}`;
      }

      case "terminate": {
        const id = str(a["bundle_id"], "bundle_id");
        await sim.terminate(id);
        return `已结束 ${id}`;
      }
    }
  },
};
