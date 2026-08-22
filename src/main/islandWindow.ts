// 灵动岛:第二个 BrowserWindow,贴主屏顶部居中。它和主窗一样只是日志的投影窗口
// (ADR-0059),主进程推送两边都到(createSend 多目标),审批/发消息走同一套 IPC。
// 为什么不是原生 NSPanel:引 native 构建链,签名分发翻倍,透明 alwaysOnTop 已够用。
import { BrowserWindow, screen } from "electron";

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
  win.setFocusable(focusable);
  if (focusable) win.focus();
}
