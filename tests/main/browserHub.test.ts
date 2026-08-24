import { describe, it, expect, vi } from "vitest";
import { createBrowserHub, type BrowserViewHandle, type BrowserViewEvent } from "../../src/main/browserHub.js";
import type { BrowserBounds } from "../../src/shared/browser.js";

/** 假 view:能被导航、能被外部驱动着发事件、能被摘下来/销毁 */
function fakeView() {
  const subs = new Set<(e: BrowserViewEvent) => void>();
  const loaded: string[] = [];
  // pick/cancel 走的都是 executeJavaScript,不记下代码本身就没法断言"发的是哪段脚本"
  const scriptCalls: string[] = [];
  const boundsLog: Array<BrowserBounds | null> = [];
  let url = "";
  let title = "";
  let destroyed = false;
  const assertAlive = () => {
    if (destroyed) throw new Error("Object has been destroyed");
  };
  let backable = false;
  const nav = { back: 0, forward: 0, reload: 0 };
  let script: () => Promise<unknown> = async () =>
    JSON.stringify({ title: "T", url: "https://x.com", text: "正文" });
  // 供"loadURL 自身 reject"那条路径的测试用:Electron 对失败导航常常
  // 直接 reject loadURL,不只靠 failed 事件通知
  let loadURLError: Error | null = null;
  const handle: BrowserViewHandle = {
    loadURL: async (u) => {
      loaded.push(u);
      if (loadURLError) {
        const err = loadURLError;
        loadURLError = null;
        throw err;
      }
      url = u;
    },
    // 真 WebContentsView 销毁之后再碰就抛 "Object has been destroyed"。
    // 假 view 得学着点,否则"close 之后还给死 view 推状态"这类 bug
    // 在测试里是静默通过的
    getURL: () => { assertAlive(); return url; },
    getTitle: () => { assertAlive(); return title; },
    canGoBack: () => { assertAlive(); return backable; },
    canGoForward: () => { assertAlive(); return false; },
    goBack: () => { nav.back++; },
    goForward: () => { nav.forward++; },
    reload: () => { nav.reload++; },
    executeJavaScript: (code) => { scriptCalls.push(code); return script(); },
    setBounds: (b) => { boundsLog.push(b); },
    // 支持多订阅者:read() 在 hub 常驻监听还挂着的时候,
    // 会临时再订一份自己的——单回调的假实现会把常驻监听挤掉
    on: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    destroy: () => { destroyed = true; },
  };
  return {
    handle,
    // 真 WebContentsView 触发 "navigated" 时,getURL() 早就是新地址了——
    // 假 view 得学着点,不然这里测的只是自己接的假线
    fire: (e: BrowserViewEvent) => {
      if (e.type === "navigated") url = e.url;
      for (const cb of [...subs]) cb(e);
    },
    setTitle: (t: string) => { title = t; },
    setBackable: (v: boolean) => { backable = v; },
    setScript: (f: () => Promise<unknown>) => { script = f; },
    setLoadURLError: (err: Error | null) => { loadURLError = err; },
    get loaded() { return loaded; },
    get scriptCalls() { return scriptCalls; },
    get boundsLog() { return boundsLog; },
    get destroyed() { return destroyed; },
    get nav() { return nav; },
    // read() 的临时订阅收尾之后,这个数应该回到只剩 hub 常驻监听那一个
    get subscriberCount() { return subs.size; },
  };
}

function makeHub() {
  const views: ReturnType<typeof fakeView>[] = [];
  const state = vi.fn();
  const hub = createBrowserHub({
    createView: () => { const v = fakeView(); views.push(v); return v.handle; },
    push: { state },
  });
  return { hub, views, state };
}

describe("browserHub 注册表", () => {
  it("open 是幂等的:同一会话只造一个 view", () => {
    const { hub, views } = makeHub();
    const a = hub.open("s1");
    const b = hub.open("s1");
    expect(views).toHaveLength(1);
    expect(b.id).toBe(a.id);
  });

  it("会话隔离:两个会话各有各的 view", () => {
    const { hub, views } = makeHub();
    expect(hub.open("s1").id).not.toBe(hub.open("s2").id);
    expect(views).toHaveLength(2);
  });

  it("navigate 归一化后加载", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    await hub.navigate("s1", "example.com");
    expect(views[0]!.loaded).toEqual(["https://example.com"]);
  });

  it("navigate 会自己 ensure:没 open 过也能直接导航(agent 先到的情况)", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "example.com");
    expect(views).toHaveLength(1);
  });

  it("后来者赢:连发两次导航,最终 URL 是后一个", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "a.com");
    await hub.navigate("s1", "b.com");
    expect(views[0]!.loaded).toEqual(["https://a.com", "https://b.com"]);
    expect(hub.info("s1")!.url).toBe("https://b.com");
  });

  it("navigate 失败不外抛,落进 lastError 推给渲染层 —— 面板是 void 调它的,"
     + "往外抛只会变成没人接的 unhandled rejection", async () => {
    const { hub, views, state } = makeHub();
    hub.open("s1");
    views[0]!.setLoadURLError(new Error("ERR_CONNECTION_REFUSED"));
    await expect(hub.navigate("s1", "a.com")).resolves.toBeUndefined();
    expect(hub.info("s1")!.lastError).toContain("ERR_CONNECTION_REFUSED");
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastError: expect.stringContaining("ERR_CONNECTION_REFUSED") })
    );
  });

  it("用户自己中途换页导致的 ERR_ABORTED 不算错 —— 连按两下回车不该报'打不开'", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    const aborted = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://a.com'"), { errno: -3 });
    views[0]!.setLoadURLError(aborted);
    await hub.navigate("s1", "a.com");
    expect(hub.info("s1")!.lastError).toBeUndefined();
  });

  it("导航途中浏览器被结束:不抛,也不给已经销毁的 view 推状态", async () => {
    const { hub, views, state } = makeHub();
    hub.open("s1");
    const pending = hub.navigate("s1", "a.com");
    hub.close("s1"); // 用户在加载途中按了工具栏的电源键
    const pushes = state.mock.calls.length;
    // 往死 view 上 snapshot 会抛,异常穿过 ipcMain.handle 变成 invoke 的 reject,
    // 而面板是 void 调它的——没人接
    await expect(pending).resolves.toBeUndefined();
    expect(views[0]!.destroyed).toBe(true);
    expect(state.mock.calls.length).toBe(pushes);
  });

  it("视图事件变成状态推送", () => {
    const { hub, views, state } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "loading", loading: true });
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s1", loading: true }));
    views[0]!.fire({ type: "navigated", url: "https://x.com" });
    views[0]!.setTitle("X 站");
    views[0]!.fire({ type: "title", title: "X 站" });
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https://x.com", title: "X 站" })
    );
  });

  it("加载失败落进 lastError 并推给渲染层——静默白屏是最难查的那种坏", () => {
    const { hub, views, state } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "failed", errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", url: "https://nope.invalid" });
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ loading: false, lastError: expect.stringContaining("NAME_NOT_RESOLVED") })
    );
    expect(hub.info("s1")!.lastError).toContain("-105");
  });

  it("下一次导航开始时清掉上一次的错——错误是状态不是历史", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "failed", errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", url: "https://nope.invalid" });
    views[0]!.fire({ type: "loading", loading: true });
    expect(hub.info("s1")!.lastError).toBeUndefined();
  });

  it("失败之后那一发 loaded 不算翻篇 —— 加载失败时 Chromium 还会把自己的错误页" +
     "加载完,再补一个 did-finish-load;当成\"成功一次\"处理的话,错误条会在" +
     "面板重新挂上来的那一刻莫名消失(实测:关着面板时失败,重开就看不到错了)", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "failed", errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", url: "https://nope.invalid" });
    views[0]!.fire({ type: "loaded" });
    expect(hub.info("s1")!.lastError).toContain("-105");
  });

  it("setBounds 透传;null = 摘下来但不销毁(关面板不杀页面)", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    hub.setBounds("s1", { x: 10, y: 20, width: 300, height: 400 });
    hub.setBounds("s1", null);
    expect(views[0]!.boundsLog).toEqual([{ x: 10, y: 20, width: 300, height: 400 }, null]);
    expect(views[0]!.destroyed).toBe(false);
    expect(hub.info("s1")).not.toBeNull();
  });

  it("setBounds 对不存在的会话是静默 no-op —— 面板卸载时的收尾调用" +
     "可能晚于 close 到达,不该炸", () => {
    const { hub } = makeHub();
    expect(() => hub.setBounds("ghost", null)).not.toThrow();
  });

  it("back/forward/reload 透传", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    hub.back("s1"); hub.forward("s1"); hub.reload("s1");
    expect(views[0]!.nav).toEqual({ back: 1, forward: 1, reload: 1 });
  });

  it("canGoBack 跟着视图走", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.setBackable(true);
    views[0]!.fire({ type: "navigated", url: "https://x.com" });
    expect(hub.info("s1")!.canGoBack).toBe(true);
  });

  it("close 销毁 view、解监听、从表里摘掉", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    expect(views[0]!.subscriberCount).toBe(1); // 常驻监听已经挂上
    hub.close("s1");
    expect(views[0]!.destroyed).toBe(true);
    // 解监听要真解掉:挂着监听器的死 view 就是泄漏(destroy 掉的 view
    // 不会再发事件是实现细节,不能拿它当"不用退订"的理由)
    expect(views[0]!.subscriberCount).toBe(0);
    expect(hub.info("s1")).toBeNull();
  });

  it("closeAll 清场(窗口关闭时用)", () => {
    const { hub, views } = makeHub();
    hub.open("s1"); hub.open("s2");
    hub.closeAll();
    expect(views.every((v) => v.destroyed)).toBe(true);
    expect(hub.info("s1")).toBeNull();
  });

  it("close 之后再 open 是一个新 view,不复活旧的", () => {
    const { hub, views } = makeHub();
    const first = hub.open("s1").id;
    hub.close("s1");
    expect(hub.open("s1").id).not.toBe(first);
    expect(views).toHaveLength(2);
  });
});

describe("browserHub.read", () => {
  it("不给 url = 读当前页,不导航", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "navigated", url: "https://x.com" }); // 人已经开着一页了
    const r = await hub.read("s1");
    expect(views[0]!.loaded).toEqual([]);
    expect(r).toEqual({ url: "https://x.com", title: "T", text: "正文", truncated: false });
  });

  it("不给 url 且这个会话根本没浏览器 = 抛,且一个 view 都不造", async () => {
    const { hub, views } = makeHub();
    await expect(hub.read("s1")).rejects.toThrow(/没有打开任何页面/);
    // 造了再抛 = 每次白留一个没人管的 Chromium 渲染进程,而这条路
    // 模型自己就能反复触发(人还没开过浏览器时的任意一次 browser_read)
    expect(views).toHaveLength(0);
  });

  it("不给 url,面板开着但一页没加载过(about:blank)= 同样抛", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "navigated", url: "about:blank" });
    await expect(hub.read("s1")).rejects.toThrow(/没有打开任何页面/);
  });

  it("给了 url = 先导航,等 loaded 再读", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "a.com" });
    await Promise.resolve(); // 让 loadURL 落地
    expect(views[0]!.loaded).toEqual(["https://a.com"]);
    views[0]!.fire({ type: "loaded" });
    await expect(pending).resolves.toMatchObject({ text: "正文" });
  });

  it("agent 先到时自己 ensure 出 view —— 面板没开过也要能读", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "a.com" });
    await Promise.resolve();
    views[0]!.fire({ type: "loaded" });
    await pending;
    expect(views).toHaveLength(1);
  });

  it("加载失败 = 抛,不返回假装成功的空字符串", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "nope.invalid" });
    await Promise.resolve();
    views[0]!.fire({ type: "failed", errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", url: "https://nope.invalid" });
    await expect(pending).rejects.toThrow(/-105|NAME_NOT_RESOLVED/);
  });

  it("超时 = 抛", async () => {
    vi.useFakeTimers();
    const { hub } = makeHub();
    const pending = hub.read("s1", { url: "slow.com" });
    const assertion = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    vi.useRealTimers();
  });

  it("中断 = reject,且不伪装成加载失败(ADR-0006 语义)", async () => {
    const { hub } = makeHub();
    const ac = new AbortController();
    const pending = hub.read("s1", { url: "a.com", signal: ac.signal });
    const assertion = expect(pending).rejects.toThrow(/中断/);
    ac.abort();
    await assertion;
  });

  it("已经 abort 的信号:立刻 reject,不发起导航", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    await expect(hub.read("s1", { url: "a.com", signal: AbortSignal.abort() })).rejects.toThrow(/中断/);
    expect(views[0]!.loaded).toEqual([]);
  });

  it("读取途中浏览器被结束 = 报一句人话,而不是 Electron 的 '已销毁'", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "a.com" });
    await Promise.resolve(); // 让 loadURL 落地
    hub.close("s1");
    // 临时订阅还挂在这个 view 上(off 的是 hub 的常驻监听),
    // 页面加载完照样会放行 settled——之后的 getURL/抽取全在死 view 上
    views[0]!.fire({ type: "loaded" });
    await expect(pending).rejects.toThrow(/浏览器在读取途中被结束/);
  });

  it("超上限截断,并在结果里明说截了", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "navigated", url: "https://x.com" });
    views[0]!.setScript(async () =>
      JSON.stringify({ title: "T", url: "https://x.com", text: "字".repeat(60_000) })
    );
    const r = await hub.read("s1");
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(50_000);
  });

  it("页面脚本返回的不是预期形状 = 抛,而不是把 undefined 当正文喂给模型", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "navigated", url: "https://x.com" });
    views[0]!.setScript(async () => "not json");
    await expect(hub.read("s1")).rejects.toThrow();
  });

  it("url 以主进程为准 —— 页面自报的地址不采信(它能改掉 JSON.stringify)", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "navigated", url: "https://real.example" });
    views[0]!.setScript(async () =>
      JSON.stringify({ title: "假冒", url: "https://bank.example", text: "攻击者写的正文" })
    );
    const r = await hub.read("s1");
    // 采信页面的话,这段正文就被记在 bank.example 头上了
    expect(r.url).toBe("https://real.example");
  });

  it("人在 agent 读取途中把屏导去别处:正文归实际地址,并把差异摆出来", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "a.com" });
    await Promise.resolve(); // 让 loadURL 落地
    // 人抢屏:导去 b.com 并加载完。临时订阅认的是"任意一次 loaded",
    // 于是 b 的 loaded 放行了 a 的等待——屏归后来者可以,答案不能跟着糊
    views[0]!.fire({ type: "navigated", url: "https://b.com" });
    views[0]!.setScript(async () =>
      JSON.stringify({ title: "B", url: "https://b.com", text: "B 的正文" })
    );
    views[0]!.fire({ type: "loaded" });
    const r = await pending;
    expect(r.url).toBe("https://b.com");
    expect(r.requestedUrl).toBe("https://a.com");
    expect(r.text).toBe("B 的正文");
  });

  it("落点和请求地址一致(含补尾斜杠)不算跑偏,不挂 requestedUrl", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "a.com" });
    await Promise.resolve();
    views[0]!.fire({ type: "navigated", url: "https://a.com/" }); // Chromium 补的尾斜杠
    views[0]!.fire({ type: "loaded" });
    expect((await pending).requestedUrl).toBeUndefined();
  });

  it("loadURL 自身 reject(Electron 对失败导航常这样,不只靠 failed 事件)——" +
     "照样要抛,且不留监听器泄漏", async () => {
    const { hub, views } = makeHub();
    hub.open("s1"); // 先建 view,拿到只有常驻监听时的基线订阅数
    const baseline = views[0]!.subscriberCount;
    views[0]!.setLoadURLError(new Error("ERR_CONNECTION_REFUSED"));
    await expect(hub.read("s1", { url: "a.com" })).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
    expect(views[0]!.subscriberCount).toBe(baseline);
  });
});

describe("browserHub 选取元素(pickElement)", () => {
  const pagePayload = () =>
    JSON.stringify({
      selector: "#app > button",
      tag: "button",
      html: "<button>提交</button>",
      text: "提交",
    });

  it("没开过页面就抛:选取的前提是屏上有一张页面", async () => {
    const { hub } = makeHub();
    hub.open("s1");
    await expect(hub.pickElement("s1")).rejects.toThrow(/没有打开任何页面/);
  });

  it("页面 resolve 出 payload,解析后带上主进程的权威 url", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "a.com");
    views[0]!.setScript(async () => pagePayload());
    const r = await hub.pickElement("s1");
    expect(r).toMatchObject({
      selector: "#app > button",
      tag: "button",
      url: "https://a.com",
    });
  });

  it("页面 resolve null(Esc)= 取消,返回 null", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "a.com");
    views[0]!.setScript(async () => null);
    expect(await hub.pickElement("s1")).toBeNull();
  });

  it("选取途中页面开始导航 = 取消:脚本随旧页面死了,promise 不该跟着悬着", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "a.com");
    views[0]!.setScript(() => new Promise(() => {})); // 永不 settle,逼 hub 靠事件收尾
    const picking = hub.pickElement("s1");
    views[0]!.fire({ type: "loading", loading: true });
    expect(await picking).toBeNull();
  });

  it("executeJavaScript reject(view 中途被销毁)= 取消而不是报错", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "a.com");
    views[0]!.setScript(async () => { throw new Error("Object has been destroyed"); });
    expect(await hub.pickElement("s1")).toBeNull();
  });

  it("cancelPick 往页面发取消脚本;没浏览器时静默返回", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "a.com");
    hub.cancelPick("s1");
    expect(views[0]!.scriptCalls.some((c) => c.includes("__ottoPickCancel"))).toBe(true);
    hub.cancelPick("没有这个会话"); // 不抛即可
  });

  it("pick 的临时订阅在收尾后退订干净", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "a.com");
    const baseline = views[0]!.subscriberCount;
    views[0]!.setScript(async () => pagePayload());
    await hub.pickElement("s1");
    expect(views[0]!.subscriberCount).toBe(baseline);
  });
});
