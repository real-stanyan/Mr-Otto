// 终端面板用的 xterm 实例注册表的唯一实例。
//
// 单独拎出来(而不是留在 TerminalView.tsx 里)是因为 store.ts 的
// deleteSession 也要用它:会话被删,主进程那边的 pty 已经被
// terminalHub.killSession 杀掉(见 main/index.ts 的 CHANNELS.deleteSession 处理),
// 但渲染层这边的 xterm 实例(DOM 节点 / canvas / 键盘监听器)没人管——
// 不主动 dispose 就是纯粹的内存泄漏,而且这些实例属于一个已经不存在的会话,
// 不会再有任何 TerminalView 重新挂载它们去触发 dispose。
//
// store.ts 已经在依赖 ./lib/* 下的其他纯逻辑模块(staging.ts / identity.ts),
// 这里只是多一个;之所以敢让 store.ts 静态 import 一个牵扯 xterm.js 的模块,
// 是因为 new Terminal(...) 只发生在 factory 里,而 factory 只有真正 get()
// 到一个新 id 时才会被调用——store.ts 这边只调 dispose(),不会触碰 factory,
// 在没有 DOM 的 vitest(node 环境)里 import 这个模块本身是安全的
// (已用 tests/renderer/pendingAttention.test.ts 间接验证:它 import 整个
// store.ts,而 store.ts 现在静态 import 本模块)。

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createXtermRegistry } from "./xtermRegistry.js";

/** 一个终端在渲染层的全部家当:实例 + fit 插件 + 是否已经灌过快照 / 已经退出 */
export interface TerminalSlot {
  term: Terminal;
  fit: FitAddon;
  attached: boolean;
  /** 进程是否已退出——onData 拿它挡"进程死了还往里敲"的输入(Task 6 修复 finding 5) */
  exited: boolean;
  dispose(): void;
}

export const terminalRegistry = createXtermRegistry<TerminalSlot>(() => {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: 12,
    cursorBlink: true,
    // 取当前主题的底色/前景,别用 xterm 默认的纯黑——深色四色底盘里会显得脏
    theme: {
      background: "transparent",
      foreground: getComputedStyle(document.documentElement).getPropertyValue("--foreground") || "#e5e5e5",
    },
    allowTransparency: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit, attached: false, exited: false, dispose: () => term.dispose() };
});
