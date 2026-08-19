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
  const handle: BrowserViewHandle = {
    loadURL: async (u) => { loaded.push(u); url = u; },
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
    get loaded() { return loaded; },
    get boundsLog() { return boundsLog; },
    get destroyed() { return destroyed; },
    get nav() { return nav; },
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
    hub.close("s1");
    expect(views[0]!.destroyed).toBe(true);
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
    const r = await hub.read("s1");
    expect(views[0]!.loaded).toEqual([]);
    expect(r).toEqual({ url: "https://x.com", title: "T", text: "正文", truncated: false });
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
    views[0]!.setScript(async () => "not json");
    await expect(hub.read("s1")).rejects.toThrow();
  });
});
