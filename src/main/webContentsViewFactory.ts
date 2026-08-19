// 全项目唯一 import WebContentsView 的地方。
// 职责只有一件:把 Electron 的 webContents 包成 browserHub 认的窄接口,
// 顺手把它那一堆事件翻译成 BrowserViewEvent 五件套。
// 隔离这一层的收益很实在——browserHub 那边整套逻辑因此能脱离 Electron 跑测试。

import { WebContentsView, type BrowserWindow } from "electron";
import type { BrowserViewHandle, BrowserViewEvent } from "./browserHub.js";
import type { BrowserBounds } from "../shared/browser.js";

export function createWebContentsViewHandle(win: BrowserWindow, partition: string): BrowserViewHandle {
  const view = new WebContentsView({
    webPreferences: {
      // 独立 partition:登录态跨会话跨重启活着(痛点之一),
      // 且与 app 自己的 session 分家——网页的 cookie 不该和 Otto 的搅在一起
      partition,
      // 网页是不可信内容,一律关到最紧
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const wc = view.webContents;
  let attached = false;

  // 新窗口一律拦下,在当前 view 里打开:内置浏览器只有一块屏,
  // 放任 window.open 会飘出一个 Otto 管不着的裸窗口
  wc.setWindowOpenHandler(({ url }) => {
    void wc.loadURL(url);
    return { action: "deny" };
  });

  return {
    loadURL: (url) => wc.loadURL(url),
    getURL: () => wc.getURL(),
    getTitle: () => wc.getTitle(),
    canGoBack: () => wc.navigationHistory.canGoBack(),
    canGoForward: () => wc.navigationHistory.canGoForward(),
    goBack: () => wc.navigationHistory.goBack(),
    goForward: () => wc.navigationHistory.goForward(),
    reload: () => wc.reload(),
    executeJavaScript: (code) => wc.executeJavaScript(code, true),

    setBounds: (b: BrowserBounds | null) => {
      if (!b || b.width <= 0 || b.height <= 0) {
        if (attached) {
          win.contentView.removeChildView(view);
          attached = false;
        }
        return;
      }
      if (!attached) {
        win.contentView.addChildView(view);
        attached = true;
      }
      view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
    },

    on: (cb: (e: BrowserViewEvent) => void) => {
      const onNavigate = (_e: unknown, url: string) => cb({ type: "navigated", url });
      const onInPageNavigate = (_e: unknown, url: string) => cb({ type: "navigated", url });
      const onTitle = (_e: unknown, title: string) => cb({ type: "title", title });
      const onStart = () => cb({ type: "loading", loading: true });
      const onStop = () => cb({ type: "loading", loading: false });
      const onFinish = () => cb({ type: "loaded" });
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => {
        // 子框架(广告 iframe 之类)加载失败不是这一页失败,报上去只会误导人
        if (!isMainFrame) return;
        // -3 = ABORTED,用户/我们自己中途换页触发的,不是错
        if (errorCode === -3) return;
        cb({ type: "failed", errorCode, errorDescription, url: validatedURL });
      };
      wc.on("did-navigate", onNavigate);
      wc.on("did-navigate-in-page", onInPageNavigate);
      wc.on("page-title-updated", onTitle);
      wc.on("did-start-loading", onStart);
      wc.on("did-stop-loading", onStop);
      wc.on("did-finish-load", onFinish);
      wc.on("did-fail-load", onFail);
      return () => {
        wc.off("did-navigate", onNavigate);
        wc.off("did-navigate-in-page", onInPageNavigate);
        wc.off("page-title-updated", onTitle);
        wc.off("did-start-loading", onStart);
        wc.off("did-stop-loading", onStop);
        wc.off("did-finish-load", onFinish);
        wc.off("did-fail-load", onFail);
      };
    },

    destroy: () => {
      if (attached) {
        win.contentView.removeChildView(view);
        attached = false;
      }
      wc.close();
    },
  };
}
