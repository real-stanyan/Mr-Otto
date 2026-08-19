// browserHub —— 主进程的浏览器注册表(一个会话一个)。
//
// 这里刻意不 import electron:真 WebContentsView 由 webContentsViewFactory 包成
// BrowserViewHandle 注入进来。好处不是"解耦"这种漂亮话,是这一整套逻辑
// (幂等 ensure / 状态投影 / 失败落 lastError / 摘下来但不销毁)全部能在
// 普通 vitest 里跑,不用起 Electron。
//
// 人的浏览不进事件日志、不进模型上下文(ADR-0031 终端先例的延伸):
// 它是人的旁路工具,不是某个事实的投影。agent 的 read() 是工具调用,照旧落盘。

import { randomUUID } from "node:crypto";
import { normalizeUrl, type BrowserBounds, type BrowserTabInfo } from "../shared/browser.js";
import type { BrowserReadOptions, BrowserReadResult } from "../world/executionWorld.js";

const READ_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 50_000;

/** 页面里跑的抽取脚本。
    直接用 innerText 而不是先克隆再删 script/style:innerText 按渲染结果取文本,
    未渲染的节点天然不在里面;而克隆出来的游离节点没有 layout,innerText 恒为空串
    ——照"先摘掉 script/style"的字面写法反而会读出一片空白。 */
export const EXTRACT_JS = `JSON.stringify({
  title: document.title || "",
  url: location.href,
  text: (document.body && document.body.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim()
})`;

/** 视图往外发的事件。窄联合而不是照搬 webContents 的事件名:
    hub 只关心这四件事,适配层负责把 Electron 那一堆翻译过来 */
export type BrowserViewEvent =
  | { type: "navigated"; url: string }
  | { type: "title"; title: string }
  | { type: "loading"; loading: boolean }
  | { type: "loaded" }
  | { type: "failed"; errorCode: number; errorDescription: string; url: string };

/** hub 眼里的一个视图。真身是 WebContentsView,测试里是个普通对象 */
export interface BrowserViewHandle {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  executeJavaScript(code: string): Promise<unknown>;
  /** null = 从窗口上摘下来(不销毁) */
  setBounds(bounds: BrowserBounds | null): void;
  /** 返回退订函数(与 TerminalSession 的订阅同构) */
  on(cb: (e: BrowserViewEvent) => void): () => void;
  destroy(): void;
}

export interface BrowserHubDeps {
  createView(): BrowserViewHandle;
  push: { state(info: BrowserTabInfo): void };
}

interface BrowserRecord {
  id: string;
  sessionId: string;
  view: BrowserViewHandle;
  title: string;
  loading: boolean;
  lastError?: string;
  off: () => void;
}

export function createBrowserHub(deps: BrowserHubDeps) {
  const browsers = new Map<string, BrowserRecord>();

  // 快照每次现算:url / canGoBack 这些的事实在 view 里,
  // 在 record 里再存一份就会有两个真相,而它们迟早对不上
  const snapshot = (r: BrowserRecord): BrowserTabInfo => ({
    id: r.id,
    sessionId: r.sessionId,
    url: r.view.getURL(),
    title: r.title || r.view.getTitle(),
    loading: r.loading,
    canGoBack: r.view.canGoBack(),
    canGoForward: r.view.canGoForward(),
    ...(r.lastError ? { lastError: r.lastError } : {}),
  });

  function ensure(sessionId: string): BrowserRecord {
    const existing = browsers.get(sessionId);
    if (existing) return existing;
    const view = deps.createView();
    const record: BrowserRecord = {
      id: randomUUID(),
      sessionId,
      view,
      title: "",
      loading: false,
      off: () => {},
    };
    record.off = view.on((e) => {
      switch (e.type) {
        case "navigated":
          record.title = "";
          break;
        case "title":
          record.title = e.title;
          break;
        case "loading":
          record.loading = e.loading;
          break;
        case "loaded":
          record.loading = false;
          // 成功一次就把上次的错抹掉:lastError 是状态不是历史
          delete record.lastError;
          break;
        case "failed":
          record.loading = false;
          record.lastError = `${e.errorDescription}（${e.errorCode}）: ${e.url}`;
          break;
      }
      deps.push.state(snapshot(record));
    });
    browsers.set(sessionId, record);
    return record;
  }

  const api = {
    /** 幂等:已有就返回已有的快照(面板挂载时调,agent 可能已经先开着某页了) */
    open(sessionId: string): BrowserTabInfo {
      return snapshot(ensure(sessionId));
    },

    /** 后来者赢,不加锁:agent 和人抢同一块屏是特性——人看得见它去了哪 */
    async navigate(sessionId: string, url: string): Promise<void> {
      const r = ensure(sessionId);
      const target = normalizeUrl(url);
      delete r.lastError;
      await r.view.loadURL(target);
      deps.push.state(snapshot(r));
    },

    /** null = 面板收起。摘下来但不销毁——照终端"关面板不杀进程"的前提:
        重开时页面还在,登录态还在。会话不存在时静默返回:
        面板卸载的收尾调用可能晚于 close 到达 */
    setBounds(sessionId: string, bounds: BrowserBounds | null): void {
      browsers.get(sessionId)?.view.setBounds(bounds);
    },

    back(sessionId: string): void { browsers.get(sessionId)?.view.goBack(); },
    forward(sessionId: string): void { browsers.get(sessionId)?.view.goForward(); },
    reload(sessionId: string): void { browsers.get(sessionId)?.view.reload(); },

    /** 关 = 销毁。解监听再销毁——挂着监听器的死 view 就是泄漏 */
    close(sessionId: string): void {
      const r = browsers.get(sessionId);
      if (!r) return;
      r.off();
      r.view.destroy();
      browsers.delete(sessionId);
    },

    /** 窗口关闭时清场 */
    closeAll(): void {
      for (const id of [...browsers.keys()]) api.close(id);
    },

    /** agent 的读。导航失败/超时/中断一律抛——
        返回一个假装成功的空字符串,会让模型以为"这页没内容",
        比报错难查一个数量级 */
    async read(sessionId: string, opts?: BrowserReadOptions): Promise<BrowserReadResult> {
      const signal = opts?.signal;
      if (signal?.aborted) throw new Error("读取被中断：用户停止了 turn");
      const r = ensure(sessionId);

      if (opts?.url) {
        const target = normalizeUrl(opts.url);
        // 先挂好监听再发起导航:loadURL 之后才订阅的话,
        // 快到离谱的本地页面(localhost 常见)可能在订阅前就 loaded 完了
        const settled = new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = (fn: () => void) => {
            if (done) return;
            done = true;
            off();
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            fn();
          };
          const off = r.view.on((e) => {
            if (e.type === "loaded") finish(resolve);
            else if (e.type === "failed") {
              finish(() => reject(new Error(`页面加载失败：${e.errorDescription}（${e.errorCode}）: ${e.url}`)));
            }
          });
          const timer = setTimeout(
            () => finish(() => reject(new Error(`页面加载超时（${READ_TIMEOUT_MS / 1000}s）：${target}`))),
            READ_TIMEOUT_MS
          );
          const onAbort = () => finish(() => reject(new Error("读取被中断：用户停止了 turn")));
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        delete r.lastError;
        await r.view.loadURL(target);
        await settled;
      }

      const raw = await r.view.executeJavaScript(EXTRACT_JS);
      let parsed: { title?: unknown; url?: unknown; text?: unknown };
      try {
        parsed = JSON.parse(String(raw)) as typeof parsed;
      } catch {
        throw new Error("读取页面失败：抽取脚本没有返回预期的 JSON");
      }
      if (typeof parsed.text !== "string" || typeof parsed.url !== "string") {
        throw new Error("读取页面失败：抽取脚本返回的形状不对");
      }
      const truncated = parsed.text.length > MAX_TEXT_CHARS;
      return {
        url: parsed.url,
        title: typeof parsed.title === "string" ? parsed.title : "",
        text: truncated ? parsed.text.slice(0, MAX_TEXT_CHARS) : parsed.text,
        truncated,
      };
    },

    info(sessionId: string): BrowserTabInfo | null {
      const r = browsers.get(sessionId);
      return r ? snapshot(r) : null;
    },
  };

  return api;
}

export type BrowserHub = ReturnType<typeof createBrowserHub>;
