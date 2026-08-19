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

/** "还没打开过任何页面"的两种长相:view 刚造出来 getURL() 是空串,
    Chromium 有时给的是 about:blank。两个都不是"一个页面" */
function isNoPage(url: string): boolean {
  return url === "" || url === "about:blank";
}

/** 比 URL 前先规整一道:new URL("https://a.com").href === "https://a.com/"。
    Chromium 会把裸域名补上尾斜杠,拿原样字符串比会把这种纯写法差异
    误判成"跑到别的页面去了" */
function canonicalUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** loadURL 的 reject 是不是"这次导航被中途换掉了"。
    Electron 把 net error 挂在 error 对象上:errno = -3 / code = "ERR_ABORTED",
    但不同来源不一定两个字段都在,所以连 message 一起认。
    与 did-fail-load 里滤掉 -3 是同一条理由:用户连按两下回车,
    第一次被中止是预期行为,报成"打不开"是假警报 */
function isAbortedNavigation(e: unknown): boolean {
  const err = e as { errno?: unknown; code?: unknown; message?: unknown } | null;
  if (!err) return false;
  if (err.errno === -3) return true;
  if (err.code === "ERR_ABORTED") return true;
  return typeof err.message === "string" && err.message.includes("ERR_ABORTED");
}

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

    /** 后来者赢,不加锁:agent 和人抢同一块屏是特性——人看得见它去了哪。
        失败不外抛:面板是 void 调它的,原样 reject 只会变成没人接的
        unhandled rejection,连带下面那次状态推送也被跳过,人对着一块
        静默不动的面板猜。失败改落 lastError——这条通道渲染层已经在显示了 */
    async navigate(sessionId: string, url: string): Promise<void> {
      const r = ensure(sessionId);
      const target = normalizeUrl(url);
      delete r.lastError;
      try {
        await r.view.loadURL(target);
      } catch (e) {
        // 用户自己中途换页导致的中止不是错(见 isAbortedNavigation)
        if (!isAbortedNavigation(e)) {
          r.lastError = `${e instanceof Error ? e.message : String(e)}: ${target}`;
        }
      }
      // close() 可能就发生在上面这段 await 里(用户按了工具栏的电源键)。
      // 那之后 r.view 已经销毁,snapshot() 里的 getURL() 会在一个死掉的
      // webContents 上抛;异常穿过 ipcMain.handle 变成 invoke 的 reject,
      // 而面板是 void 调 browserNavigate 的——没人接。
      // "记录还在表里且还是同一条"是唯一可靠的"这个 view 还活着"判据
      // (同一会话 close 后再 open 会换一条新记录,身份比较能连这种情况一起挡住)
      if (browsers.get(sessionId) !== r) return;
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
      const target = opts?.url ? normalizeUrl(opts.url) : null;
      // 这条判断必须在 ensure() 之前:不给 url 又没有页面是条死路,
      // 先 ensure 出一个 view 再抛,等于每次都白留一个没人管的 Chromium 渲染进程。
      // 而这条路模型自己就能反复触发(人还没开过浏览器时的任意一次 browser_read),
      // 是真泄漏不是偶发。
      // 判据用 browsers.get() 而不是 ensure 后的 getURL():ensure 会顺手造一个
      // 停在 about:blank 的新 view,造完再看就分不清"本来就没浏览器"和"人开着一张白页"
      if (target === null) {
        const opened = browsers.get(sessionId);
        // 照直抽下去会给模型一份"正文为空"的成功结果——它会当成"这页没内容",
        // 而事实是"压根没开页面"。这正是这个 hub 存在的理由(见文件头),
        // 空字符串比报错难查一个数量级
        if (!opened || isNoPage(opened.view.getURL())) {
          throw new Error("browser_read: 当前没有打开任何页面，请用 url 参数指定要读的网址");
        }
      }
      const r = ensure(sessionId);
      // close() 之后的活性判据,同 navigate:每个 await 点之后都要重认一次,
      // 这块屏是人和 agent 共用的,人随时可能在读取途中把浏览器整个结束掉
      const stillLive = () => browsers.get(sessionId) === r;

      if (target !== null) {
        // 清错要在造 promise 之前:executor 是同步跑的,里面已经发出了 loadURL。
        // 放在后面只是靠"Electron 的事件下一个 tick 才到"侥幸没出事
        delete r.lastError;
        // 先挂好监听再发起导航:loadURL 之后才订阅的话,
        // 快到离谱的本地页面(localhost 常见)可能在订阅前就 loaded 完了
        //
        // loadURL 本身也会在导航失败时直接 reject——不是只靠 failed 事件通知的
        // (Electron 对失败导航就是这样)。所以 loadURL 挪进了 executor 内部,
        // 用 .catch 把它接进同一条 finish 管线:不管是 loaded/failed 事件、
        // 超时、外部中断,还是 loadURL 自己 reject,都走同一份一次性 teardown——
        // 否则某条路径会漏掉监听器/定时器/abort 监听器,孤儿定时器之后触发
        // 还会 reject 一个没人等的 promise(unhandled rejection)
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
          r.view.loadURL(target).catch((err: unknown) => finish(() => reject(err)));
        });
        await settled;
        if (!stillLive()) throw new Error("读取被中断：浏览器在读取途中被结束了");
      }

      const raw = await r.view.executeJavaScript(EXTRACT_JS);
      // 抽取也是个 await 点。下面还要 getURL() 取权威地址,view 死了会在那儿抛
      // 一个 Electron 的内部错("Object has been destroyed"),对模型毫无意义
      if (!stillLive()) throw new Error("读取被中断：浏览器在读取途中被结束了");
      let parsed: { title?: unknown; url?: unknown; text?: unknown };
      try {
        parsed = JSON.parse(String(raw)) as typeof parsed;
      } catch {
        throw new Error("读取页面失败：抽取脚本没有返回预期的 JSON");
      }
      if (typeof parsed.text !== "string" || typeof parsed.url !== "string") {
        throw new Error("读取页面失败：抽取脚本返回的形状不对");
      }
      // url 只认主进程这一份。EXTRACT_JS 跑在页面的 main world 里,一个有恶意的
      // 页面完全可以把 JSON.stringify 换掉,让 parsed.url 说自己是任何域名——
      // 模型就会把攻击者写的正文记在一个可信来源的账上。正文是页面控制的没办法,
      // 出处不该也跟着交出去。parsed.url 只留作形状校验(它证明脚本真跑了)
      const actualUrl = r.view.getURL();
      // 人和 agent 抢同一块屏时,临时订阅是认"任意一次 loaded"就 resolve 的:
      // 人在 agent 读 A 的途中导去 B,B 的 loaded 会把 A 的等待放行。
      // 屏幕归后来者是特性,答案归谁却不能含糊——这里拿实际地址和请求地址对一遍。
      //
      // 选"标注"而不是"报错":重定向是常态(补尾斜杠已在 canonicalUrl 里吸收掉,
      // 但 http→https、加 www、跳语言目录都会让最终地址和请求地址不同),
      // 一律报错等于把正常浏览也判死。标注则两头都不丢:正文照给,
      // 出处写实际地址,再额外挂一条 requestedUrl 让工具层把差异摆到模型眼前
      const requestedUrl =
        target !== null && canonicalUrl(actualUrl) !== canonicalUrl(target) ? target : undefined;
      const truncated = parsed.text.length > MAX_TEXT_CHARS;
      return {
        url: actualUrl,
        title: typeof parsed.title === "string" ? parsed.title : "",
        text: truncated ? parsed.text.slice(0, MAX_TEXT_CHARS) : parsed.text,
        truncated,
        ...(requestedUrl !== undefined ? { requestedUrl } : {}),
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
