// 应用与宿主之间的桥（#1591）：请求怎么认、能力怎么拦、回执怎么拼、ask 那句怎么写。
import { describe, expect, it } from "vitest";
import { APP_BRIDGE_JS, appAskText, appFixText, bridgeDenied, bridgeReplyJs, capabilityOf, parseBridgeError, parseBridgeRequest } from "../../src/shared/appBridge.js";
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
