// 灵动岛:第二个 BrowserWindow,贴主屏顶部居中。它和主窗一样只是日志的投影窗口
// (ADR-0059),主进程推送两边都到(createSend 多目标),审批/发消息走同一套 IPC。
// 为什么不是原生 NSPanel:引 native 构建链,签名分发翻倍,透明 alwaysOnTop 已够用。
import { app, BrowserWindow, screen } from "electron";

/** 纯函数:给显示器工作区和内容尺寸,算窗体位置。单测只测这个 */
export function islandBounds(
  display: { x: number; y: number; width: number },
  size: { w: number; h: number }
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(display.x + (display.width - size.w) / 2),
    y: display.y,
    width: size.w,
    height: size.h,
  };
}

const INITIAL = { w: 220, h: 40 };

export function createIslandWindow(opts: {
  preload: string;
  rendererUrl?: string;
  rendererFile?: string;
}): BrowserWindow {
  const { bounds } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...islandBounds(bounds, INITIAL),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    // 折叠态不抢焦点;进输入态时由 islandResize 的调用方 setFocusable(true)
    focusable: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // screen-saver 级:压过全屏 app 和菜单栏
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.once("ready-to-show", () => win.showInactive());
  // 显示器拔插 / 分辨率变 → 重新贴顶居中,尺寸沿用当前
  const relayout = () => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    win.setBounds(islandBounds(screen.getPrimaryDisplay().bounds, { w: width, h: height }));
  };
  screen.on("display-metrics-changed", relayout);
  win.on("closed", () => screen.removeListener("display-metrics-changed", relayout));

  if (opts.rendererUrl) void win.loadURL(`${opts.rendererUrl}/island.html`);
  else if (opts.rendererFile) void win.loadFile(opts.rendererFile);
  return win;
}

/** islandResize 的主进程侧:改尺寸并保持贴顶居中;输入态顺便放开焦点 */
export function resizeIsland(win: BrowserWindow, size: { w: number; h: number }, focusable: boolean): void {
  if (win.isDestroyed()) return;
  win.setBounds(islandBounds(screen.getPrimaryDisplay().bounds, size));
  if (focusable) {
    // 进输入态:光抢窗焦点不够 —— app 本身可能不在前台(岛是常驻置顶的,用户多半正
    // 在别的 app 里),那时 win.focus() 敲不进键盘。同 index.ts 的 focusMainWindow
    win.setFocusable(true);
    win.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
  } else {
    // 退出输入态:macOS 上 setFocusable(false) 不会把已经拿着的焦点交出去
    // (Electron 文档明说),不显式 blur 的话岛会一直吃着键盘,用户回到刚才那个
    // app 里打字打不进去 —— 一个常驻置顶窗把整台机器的输入扣住(#175 I3)
    win.setFocusable(false);
    win.blur();
  }
}
