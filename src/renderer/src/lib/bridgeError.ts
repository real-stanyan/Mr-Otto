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

export function bridgeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (SKEW.test(raw)) {
    return "主进程还是旧的一版（界面已经更新，主进程没有）。完全退出 Mr Otto 再打开即可——热更新换不掉主进程。";
  }
  return raw;
}
