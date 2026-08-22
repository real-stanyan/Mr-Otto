// 往渲染层推送的唯一出口。
//
// 起因(issue #53):窗口被 Cmd+W 销毁后(mac 惯例:关窗不退 app),还在跑的 turn
// 继续往 webContents 上推 delta,撞上已销毁的对象抛 "Object has been destroyed",
// 整个 turn 就此失败——工具执行到一半被打断,得重开。
//
// 这个坑此前踩过一次、也修过一次,但只修了当时踩到的那三条好友通道
// (index.ts 里那句 `if (!win.isDestroyed())`)。剩下十几处照旧裸 send。
// 「有的加了有的没加」本身就是下一次同类 bug 的温床,所以收敛成一个函数:
// 主进程里所有 send 都走它,漏不掉。
//
// 窗口没了就静默丢弃,不报错不重试——推送是投影,不是事实。
// 事实在 append-only 日志里(而且永远先落盘再推),窗口再开时 UI 从日志重新投影,
// 丢掉的这一帧本来就不该有人看。

/** BrowserWindow 的最小面(单测注入假窗口,不起 Electron) */
export interface SendTarget {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

export type Send = (channel: string, ...args: unknown[]) => void;

/** 多目标:主窗 + 岛窗都是日志的投影窗口,每条推送两边都要到。
    每个目标各自查 destroyed —— 主窗 Cmd+W 关了,岛照常收 */
export function createSend(...targets: SendTarget[]): Send {
  return (channel, ...args) => {
    for (const win of targets) {
      // 两个都查:窗口还在但 webContents 先没了是可能的(崩溃/重载),
      // 只查 win.isDestroyed() 挡不住那一种
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, ...args);
    }
  };
}
