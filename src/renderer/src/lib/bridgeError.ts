// 桥报错 → 人能执行的一句话。
//
// 起因是一条真实的求助："Error invoking remote method 'otter:listOllamaModels':
// No handler registered for 'otter:listOllamaModels'"。这句话对用户零信息量，
// 但它其实指向一个很具体的状态：**渲染层和主进程不是同一版**。
// Electron 里这两边的更新节奏本来就不一样——渲染层热更新，主进程只有重启才换——
// 所以每加一个 IPC 通道，都会有一段窗口期是"渲染层认得、主进程不认"。
// 与其让每个调用点各自处理，不如在这里一次性翻译。

/** 渲染层认得这个通道、主进程不认 = 两边版本对不上 */
const SKEW = /No handler registered/i;

/** Electron 给每一条从 handler 里抛出来的错都套上这层壳：
    `Error invoking remote method 'otter:saveSubagent': Error: 只读的定义改不了`。
    前半截对用户零信息量——通道名是我们自己的实现细节，"invoking remote method"
    说的是 IPC 这件事本身，而用户看到的那句话本来就是主进程写给他的中文提示。
    全仓每个 handler 都从这条路出来，所以剥壳只该做一次，做在这里（issue #141）。
    两层都剥：外壳，以及紧跟着的那个 `Error: `（Electron 拼的是 String(err)）*/
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

export function bridgeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (SKEW.test(raw)) {
    return "主进程还是旧的一版（界面已经更新，主进程没有）。完全退出 Mr Otto 再打开即可——热更新换不掉主进程。";
  }
  // 剥壳放在版本错配之后：那条分支根本不看原文，先剥是白剥
  return raw.replace(IPC_WRAPPER, "");
}
