// 全项目唯一 import WebContentsView 的地方。
// 职责只有一件:把 Electron 的 webContents 包成 browserHub 认的窄接口,
// 顺手把它那一堆事件翻译成 BrowserViewEvent 五件套。
// 隔离这一层的收益很实在——browserHub 那边整套逻辑因此能脱离 Electron 跑测试。

import { WebContentsView, type BrowserWindow } from "electron";
import type { BrowserViewHandle, BrowserViewEvent } from "./browserHub.js";
import {
  isAllowedPopupTarget,
  isAllowedTopLevelNavigation,
  shouldReportLoadFailure,
} from "./browserNavigationPolicy.js";
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

  // 门之一:window.open。新窗口一律拦下,在当前 view 里打开——内置浏览器只有一块屏,
  // 放任 window.open 会飘出一个 Otto 管不着的裸窗口。放行判断见
  // browserNavigationPolicy.isAllowedPopupTarget(那里写了为什么只认 http(s))
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedPopupTarget(url)) void wc.loadURL(url);
    return { action: "deny" };
  });

  // 门之二:页面把顶层框架自己导走(location.href = …、<a>、meta refresh)。
  // 上面那扇门只管 window.open,这一扇之前是敞着的。要关的是自定义协议:
  // app 注册了 mrotto:// 协议处理器(index.ts 的 setAsDefaultProtocolClient
  // + open-url 监听),回调 URL 里的 code 会被直接喂进登录流程(account.ts);
  // 一个不可信页面若能把顶层框架导向 mrotto://auth-callback?code=…,
  // 就等于隔着浏览器往 Otto 的认证流里塞参数——关的就是这扇门。
  //
  // 不影响正常浏览:服务端 3xx 重定向走的是 will-redirect 且落点还是 http(s);
  // 我们自己 loadURL() 发起的导航是 API 发起的,根本不经过 will-navigate
  wc.on("will-navigate", (event, url) => {
    if (!isAllowedTopLevelNavigation(url)) event.preventDefault();
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
    // 不带 userGesture:抽取脚本不需要用户激活,而白送一个不可信页面一次
    // transient activation(弹窗/全屏/自动播放的门票)没有任何好处。
    // BrowserViewHandle 的签名里本来也没有这个参数
    executeJavaScript: (code) => wc.executeJavaScript(code),

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
        if (!shouldReportLoadFailure(errorCode, isMainFrame)) return;
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
