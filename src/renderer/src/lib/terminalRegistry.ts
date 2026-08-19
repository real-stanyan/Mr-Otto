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

let liveFeedStarted = false;

/** pty 全局直播的唯一订阅入口——调用方是 store.boot(),跟 app 同生共死。
    这段逻辑原来长在 TerminalView 的 useEffect 里,面板一关组件卸载,cleanup
    把订阅摘了;可 pty 没死,主进程照样在推 terminalData——渲染层这边没人在
    听,数据直接从 IPC 管道里消失,连 registry 里的 xterm 实例都没机会写进去。
    这不是"重开面板时缓冲没灌回去"那种能事后补救的丢失,是彻底丢了
    (ADR-0031 §3 的环形缓冲存在的前提就是"关面板不杀进程",但缓冲只解决
    "重开时一次性灌回去",解决不了"关着的时候直播管道被拔了"——这段窗口
    必须一直有人收)。所以订阅本身要跟 xterm 实例活得一样长:模块级,只订一次。

    只写进 peek 到的实例,不 get:这是进程全局广播(payload 没有 sessionId),
    不能替"渲染进程收到过的每个终端 id"都造一个从没被用户点开过的实例
    (同 xtermRegistry.ts 里 peek 的注释,道理一样)。 */
export function startTerminalLiveFeed(): void {
  if (liveFeedStarted) return;
  liveFeedStarted = true;
  window.otter.onTerminalData(({ id, data }) => {
    terminalRegistry.peek(id)?.term.write(data);
  });
  window.otter.onTerminalExit(({ id, exitCode }) => {
    const slot = terminalRegistry.peek(id);
    if (slot) {
      slot.exited = true;
      slot.term.write(`\r\n\x1b[2m[进程已退出，代码 ${exitCode}]\x1b[0m\r\n`);
    }
  });
}

/** 会话 -> 上次活跃标签 id 的记忆,模块级、活得比 TerminalView 组件久。
    展开/收起面板那颗按钮(App.tsx 的 panelWide)切的是两套结构不同的 JSX
    (纯 div vs ResizablePanelGroup),React 认不出是"同一棵树换了个壳",
    只能整个子树卸载重挂——TerminalView 里 useState 的 activeId 跟着归零,
    组件自己的挂载 effect 又总是兜底选 existing[0],于是三个标签开着、
    正停在第 3 个,按一下展开就被弹回第 1 个。挂到组件外面,重挂时才有
    地方找回"关之前到底停在哪个标签" */
const activeTerminalBySession = new Map<string, string>();

/** 记一下这个会话当前停在哪个标签;id 为 null 表示"没有活跃标签了"(标签页清空/
    最后一个标签被关掉),对应清掉记忆而不是留一个必然失效的旧值占位 */
export function rememberActiveTerminal(sessionId: string, id: string | null): void {
  if (id) activeTerminalBySession.set(sessionId, id);
  else activeTerminalBySession.delete(sessionId);
}

/** 取回记忆,调用方必须自己拿"这个会话现在到底有哪些标签"去验证一遍——
    这里存的可能是一个标签已经被关掉/会话已经被删掉之后的陈旧 id,
    这个模块不知道后端此刻的真实状态,不该替调用方断言它还存在 */
export function recallActiveTerminal(sessionId: string): string | null {
  return activeTerminalBySession.get(sessionId) ?? null;
}
