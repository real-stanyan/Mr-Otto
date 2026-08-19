import { describe, it, expect, vi } from "vitest";
import { createBrowserHub, type BrowserViewHandle, type BrowserViewEvent } from "../../src/main/browserHub.js";
import type { BrowserBounds } from "../../src/shared/browser.js";

/** 假 view:能被导航、能被外部驱动着发事件、能被摘下来/销毁 */
function fakeView() {
  let emit: ((e: BrowserViewEvent) => void) | null = null;
  const loaded: string[] = [];
  const boundsLog: Array<BrowserBounds | null> = [];
  let url = "";
  let title = "";
  let destroyed = false;
  let backable = false;
  const nav = { back: 0, forward: 0, reload: 0 };
  const handle: BrowserViewHandle = {
    loadURL: async (u) => { loaded.push(u); url = u; },
    getURL: () => url,
    getTitle: () => title,
    canGoBack: () => backable,
    canGoForward: () => false,
    goBack: () => { nav.back++; },
    goForward: () => { nav.forward++; },
    reload: () => { nav.reload++; },
    executeJavaScript: async () => "{}",
    setBounds: (b) => { boundsLog.push(b); },
    on: (cb) => { emit = cb; return () => { emit = null; }; },
    destroy: () => { destroyed = true; },
  };
  return {
    handle,
    // 真 WebContentsView 触发 "navigated" 时,getURL() 早就是新地址了——
    // 假 view 得学着点,不然这里测的只是自己接的假线
    fire: (e: BrowserViewEvent) => {
      if (e.type === "navigated") url = e.url;
      emit?.(e);
    },
    setTitle: (t: string) => { title = t; },
    setBackable: (v: boolean) => { backable = v; },
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
