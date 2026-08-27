// 「动效:始终开启」是怎么实现的(issue #604)。
//
// 系统层的「减弱动效」(Windows 设置 → 辅助功能 → 视觉效果 → 动画效果;
// macOS 的 Reduce Motion)会让 Chromium 把 prefers-reduced-motion 报成 reduce,
// 而本 app 从上到下都认这条媒体查询:Tailwind 的 motion-reduce: 变体、app.css 里
// 十几个 @media 块、跑 turn 时那颗 canvas 球(thinking-orbs 在 reduce 下只画一帧
// 静止的)。于是那台机器上整个界面纹丝不动,人看到的是"卡死了"。
//
// 覆盖的手段是 CDP 的 Emulation.setEmulatedMedia —— DevTools 那套。为什么不用
// Chromium 的 --force-prefers-no-reduced-motion 启动开关:它得在 app ready 前挂,
// 改完要重启,而且实测它压不过 --force-prefers-reduced-motion,对系统设置能不能
// 压得住无从验证(这台 mac 的系统开关我没法替用户去开)。CDP 这条路当场可验:
// 同一个 API 能把没减弱的机器强行变成 reduce,反向是同一条代码路径。
//
// 代价是挂着调试器时 DevTools 开不了(同一个通道只容一个客户端)。所以只在
// **真的需要**时挂:pref = always 且渲染层此刻确实报 reduce。系统本来就没减弱的
// 机器(mac、绝大多数 Windows)一行调试器都不挂。

import type { MotionPref } from "../shared/shellBridge.js";

/** 覆盖动作要用到的那点能力。抽成接口是为了能测——真身在 index.ts 里
    由 webContents 拼出来(executeJavaScript + debugger) */
export interface MotionOverrideHost {
  /** 渲染层此刻的 prefers-reduced-motion。已经挂了覆盖的话它就是 false */
  prefersReduce(): Promise<boolean>;
  /** 钉住这条媒体查询;null = 撤掉覆盖,还给系统 */
  emulate(value: "no-preference" | null): Promise<void>;
  log(msg: string): void;
}

/** 这一次动作干了什么。返回值本身没有副作用,是给日志和测试看的 */
export type MotionOverrideOutcome =
  /** pref = always,但系统本来就没减弱——什么都不用做,别挂调试器 */
  | "not-needed"
  /** 挂上了覆盖:界面从此照常播动效 */
  | "overridden"
  /** pref = system:撤掉覆盖(没挂过就是空操作) */
  | "cleared"
  /** 挂不上(最常见:DevTools 正开着,调试器通道被占)。不抛——动效这件事
      再重要也不该让窗口起不来 */
  | "failed";

export async function applyMotionPref(
  pref: MotionPref,
  host: MotionOverrideHost
): Promise<MotionOverrideOutcome> {
  try {
    if (pref === "system") {
      await host.emulate(null);
      return "cleared";
    }
    if (!(await host.prefersReduce())) return "not-needed";
    await host.emulate("no-preference");
    return "overridden";
  } catch (e) {
    host.log(`动效覆盖没挂上(${pref}):${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
