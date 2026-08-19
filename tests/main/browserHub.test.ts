import { describe, it, expect, vi } from "vitest";
import { createBrowserHub, type BrowserViewHandle, type BrowserViewEvent } from "../../src/main/browserHub.js";
import type { BrowserBounds } from "../../src/shared/browser.js";

/** 假 view:能被导航、能被外部驱动着发事件、能被摘下来/销毁 */
function fakeView() {
  const subs = new Set<(e: BrowserViewEvent) => void>();
  const loaded: string[] = [];
  const boundsLog: Array<BrowserBounds | null> = [];
  let url = "";
  let title = "";
  let destroyed = false;
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
    getURL: () => url,
    getTitle: () => title,
    canGoBack: () => backable,
    canGoForward: () => false,
    goBack: () => { nav.back++; },
    goForward: () => { nav.forward++; },
    reload: () => { nav.reload++; },
    executeJavaScript: () => script(),
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

  it("加载成功清掉上一次的错——错误是状态不是历史", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0]!.fire({ type: "failed", errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", url: "https://nope.invalid" });
    views[0]!.fire({ type: "loaded" });
    expect(hub.info("s1")!.lastError).toBeUndefined();
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

  it("不给 url 且这个会话根本没浏览器 = 抛,不返回一份'这页是空的'", async () => {
    const { hub, views } = makeHub();
    await expect(hub.read("s1")).rejects.toThrow(/没有打开任何页面/);
    // 报错也别把 about:blank 抽一遍:模型拿到空正文会当成"这页没内容"
    expect(views[0]!.loaded).toEqual([]);
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
