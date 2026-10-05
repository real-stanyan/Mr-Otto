// 应用与宿主之间的桥（#1591）：请求怎么认、能力怎么拦、回执怎么拼、ask 那句怎么写。
import { describe, expect, it } from "vitest";
import { APP_BRIDGE_JS, appAskText, appFixText, bridgeDenied, bridgeEventJs, bridgeReplyJs, capabilityOf, parseBridgeError, parseBridgeRequest } from "../../src/shared/appBridge.js";
import { APP_CAPABILITIES } from "../../src/shared/apps.js";
import { appPageOk } from "../../src/shared/appsApi.js";

describe("appBridge", () => {
  it("注进去的 JS 定义 window.otto 的四件 + haptic，回执入口是 __ottoReply", () => {
    for (const s of ["window.otto", "storage", "ask", "share", "nav", "back", "haptic", "__ottoReply", "ReactNativeWebView.postMessage"]) expect(APP_BRIDGE_JS).toContain(s);
  });
  it("parseBridgeRequest：只认 {id, method, args}，方法要在白名单里；坏形状回 null 不抛", () => {
    expect(parseBridgeRequest(JSON.stringify({ id: "c1", method: "storage.get", args: ["k"] }))).toEqual({ id: "c1", method: "storage.get", args: ["k"] });
    expect(parseBridgeRequest(JSON.stringify({ id: "c1", method: "fetch", args: [] }))).toBeNull();
    expect(parseBridgeRequest(JSON.stringify({ method: "ask" }))).toBeNull();
    expect(parseBridgeRequest("{nope")).toBeNull();
    expect(parseBridgeRequest(42)).toBeNull();
    expect(parseBridgeRequest(JSON.stringify({ id: "c1", method: "back" }))).toEqual({ id: "c1", method: "back", args: [] });
  });
  it("能力：清单里没声明的拒；方法 → 能力的映射", () => {
    expect(capabilityOf("storage.list")).toBe("storage");
    expect(capabilityOf("back")).toBe("nav");
    expect(bridgeDenied("ask", ["storage"])).toContain("ask");
    expect(bridgeDenied("storage.get", ["storage"])).toBeNull();
  });
  it("回执：JSON 化；undefined 当 null；序列化不了回错", () => {
    expect(bridgeReplyJs("c1", true, { a: 1 })).toBe('window.__ottoReply("c1", true, {"a":1}); true;');
    expect(bridgeReplyJs("c1", true, undefined)).toContain("null");
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(bridgeReplyJs("c1", true, cyc)).toContain("false");
  });
  it("ask 那句带应用名；空的回 null；页面要在文件表里且是 html", () => {
    expect(appAskText("记事本", "  帮我把今天的记成一条 ")).toBe("[应用「记事本」]: 帮我把今天的记成一条");
    expect(appAskText("记事本", "")).toBeNull();
    const files = [{ path: "index.html", size: 1, sha256: "x" }, { path: "pages/day.html", size: 1, sha256: "x" }, { path: "app.js", size: 1, sha256: "x" }];
    expect(appPageOk(files, "pages/day.html")).toBe(true);
    expect(appPageOk(files, "app.js")).toBe(false);
    expect(appPageOk(files, "../x.html")).toBe(false);
  });
});

describe("应用报错（#1591 真机）", () => {
  it("桥里接了 error / unhandledrejection；宿主只认 {error}；让管理员修那句带名字、版本、报错", () => {
    expect(APP_BRIDGE_JS).toContain('addEventListener("error"');
    expect(APP_BRIDGE_JS).toContain('addEventListener("unhandledrejection"');
    expect(parseBridgeError(JSON.stringify({ error: "TypeError: x" }))).toBe("TypeError: x");
    expect(parseBridgeError(JSON.stringify({ id: "c1", method: "back" }))).toBeNull();
    expect(parseBridgeError("nope")).toBeNull();
    expect(appFixText("日历记事本", 1, "Cannot read  properties")).toBe("[应用「日历记事本」v1 出错了]: Cannot read properties——让应用专员修一下、出下一版。");
  });
});

describe("房间（#1675）", () => {
  it("能力清单有 room；room.* 归 room；没声明就拒", () => {
    expect(APP_CAPABILITIES).toContain("room");
    expect(capabilityOf("room.set")).toBe("room");
    expect(capabilityOf("room.rooms")).toBe("room");
    expect(bridgeDenied("room.send", ["storage"])).toMatch("room");
    expect(bridgeDenied("room.send", ["room"])).toBeNull();
  });
  it("请求白名单认 room.*", () => {
    for (const m of ["room.current", "room.create", "room.invite", "room.rooms", "room.open", "room.leave", "room.get", "room.list", "room.set", "room.remove", "room.send", "room.ping"]) {
      expect(parseBridgeRequest(JSON.stringify({ id: "c1", method: m, args: [] }))?.method).toBe(m);
    }
  });
  it("注进去的 JS：otto.room 十二件 + on/off + __ottoEvent；事件分发到注册的回调、off 之后不再收", () => {
    const posted: string[] = [];
    const w: Record<string, unknown> = { ReactNativeWebView: { postMessage: (s: string) => posted.push(s) }, addEventListener: () => {} };
    new Function("window", APP_BRIDGE_JS)(w);
    const otto = w.otto as { room: Record<string, unknown>; on(n: string, cb: (p: unknown) => void): void; off(n: string, cb: (p: unknown) => void): void };
    for (const k of ["current", "create", "invite", "rooms", "open", "leave", "get", "list", "set", "remove", "send", "ping"]) expect(typeof otto.room[k]).toBe("function");
    const got: unknown[] = [];
    const cb = (p: unknown): void => { got.push(p); };
    otto.on("room.change", cb);
    (w.__ottoEvent as (n: string, p: unknown) => void)("room.change", { key: "b" });
    otto.off("room.change", cb);
    (w.__ottoEvent as (n: string, p: unknown) => void)("room.change", { key: "c" });
    expect(got).toEqual([{ key: "b" }]);
    void (otto.room.set as (k: string, v: unknown, o: unknown) => Promise<unknown>)("board", { x: 1 }, { ifRev: 2 });
    expect(JSON.parse(posted.at(-1)!)).toMatchObject({ method: "room.set", args: ["board", { x: 1 }, { ifRev: 2 }] });
  });
  it("事件名撞上 Object 原型上的名字（constructor / __proto__ / toString）也照常注册、分发，不抛", () => {
    const w: Record<string, unknown> = { ReactNativeWebView: { postMessage: () => {} }, addEventListener: () => {} };
    new Function("window", APP_BRIDGE_JS)(w);
    const otto = w.otto as { on(n: string, cb: (p: unknown) => void): void; off(n: string, cb: (p: unknown) => void): void };
    const fire = w.__ottoEvent as (n: string, p: unknown) => void;
    const got: unknown[] = [];
    for (const n of ["constructor", "__proto__", "toString"]) {
      expect(() => fire(n, 0)).not.toThrow();
      expect(() => otto.off(n, () => {})).not.toThrow();
      expect(() => otto.on(n, (p) => got.push([n, p]))).not.toThrow();
      fire(n, 1);
    }
    expect(got).toEqual([["constructor", 1], ["__proto__", 1], ["toString", 1]]);
  });
  it("bridgeEventJs：名字与载荷都过 JSON", () => {
    expect(bridgeEventJs("room.message", { from: "u", msg: "hi" })).toBe(`window.__ottoEvent("room.message", {"from":"u","msg":"hi"}); true;`);
  });
});
