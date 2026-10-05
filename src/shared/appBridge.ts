// appBridge —— 应用与宿主之间的消息桥（#1591，spec §3.2）的纯逻辑：注进 WebView 的那段 JS、一条请求怎么认、
// 回执怎么拼、这把能力清单里有没有声明。宿主（手机 MiniAppScreen）按它判，runtime 的静态检查按 apps.ts。
import type { AppCapability } from "./apps.js";

/** 注进 WebView 的 window.otto：每个调用带 id，走 postMessage；宿主用 __ottoReply(id, ok, value) 回。写成 ES5，WebView 里什么都认 */
export const APP_BRIDGE_JS = `(function(){
  if (window.otto) return;
  var seq = 0, pending = {};
  function call(method, args) {
    return new Promise(function (res, rej) {
      var id = "c" + (++seq);
      pending[id] = { res: res, rej: rej };
      window.ReactNativeWebView.postMessage(JSON.stringify({ id: id, method: method, args: args || [] }));
    });
  }
  window.__ottoReply = function (id, ok, value) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (ok) p.res(value); else p.rej(new Error(String(value)));
  };
  // 应用自己的脚本报错（#1591 真机）：报给宿主，宿主露一条「这个应用出错了 · 让管理员修」
  function report(msg) { try { window.ReactNativeWebView.postMessage(JSON.stringify({ error: String(msg).slice(0, 500) })); } catch (_) {} }
  window.addEventListener("error", function (e) { report((e && (e.message || (e.error && e.error.message))) || "出错了"); });
  window.addEventListener("unhandledrejection", function (e) { report((e && e.reason && (e.reason.message || e.reason)) || "出错了"); });
  // 宿主推下来的事件（#1675 房间）：宿主 injectJavaScript("window.__ottoEvent(name, payload)")，按名字分发给 otto.on 注册的回调
  // 没有原型的空表：事件名撞上 constructor / __proto__ / toString 也只是一格普通的键，otto.on 不会拿到原型上的函数去 push
  var handlers = Object.create(null);
  window.__ottoEvent = function (name, payload) {
    var hs = handlers[name];
    if (!hs) return;
    hs.slice().forEach(function (h) { try { h(payload); } catch (e) { report((e && e.message) || e); } });
  };
  window.otto = {
    storage: {
      get: function (k) { return call("storage.get", [k]); },
      set: function (k, v) { return call("storage.set", [k, v]); },
      list: function (p) { return call("storage.list", [p || ""]); },
      remove: function (k) { return call("storage.remove", [k]); }
    },
    ask: function (text, opts) { return call("ask", [text, opts || {}]); },
    share: function (opts) { return call("share", [opts || {}]); },
    nav: function (page) { return call("nav", [page]); },
    back: function () { return call("back", []); },
    haptic: function () { return call("haptic", []); },
    on: function (name, cb) { (handlers[name] = handlers[name] || []).push(cb); },
    off: function (name, cb) { var hs = handlers[name]; if (hs) handlers[name] = hs.filter(function (x) { return x !== cb; }); },
    room: {
      current: function () { return call("room.current", []); },
      create: function (o) { return call("room.create", [o || {}]); },
      invite: function () { return call("room.invite", []); },
      rooms: function () { return call("room.rooms", []); },
      open: function (id) { return call("room.open", [id]); },
      leave: function () { return call("room.leave", []); },
      get: function (k) { return call("room.get", [k]); },
      list: function (p) { return call("room.list", [p || ""]); },
      set: function (k, v, o) { return call("room.set", [k, v, o || {}]); },
      remove: function (k) { return call("room.remove", [k]); },
      send: function (m) { return call("room.send", [m]); },
      ping: function (t) { return call("room.ping", [t]); }
    }
  };
})(); true;`;

export type BridgeMethod =
  | "storage.get" | "storage.set" | "storage.list" | "storage.remove" | "ask" | "share" | "nav" | "back" | "haptic"
  | "room.current" | "room.create" | "room.invite" | "room.rooms" | "room.open" | "room.leave"
  | "room.get" | "room.list" | "room.set" | "room.remove" | "room.send" | "room.ping";
const METHODS: ReadonlySet<string> = new Set<BridgeMethod>([
  "storage.get", "storage.set", "storage.list", "storage.remove", "ask", "share", "nav", "back", "haptic",
  "room.current", "room.create", "room.invite", "room.rooms", "room.open", "room.leave",
  "room.get", "room.list", "room.set", "room.remove", "room.send", "room.ping",
]);

export interface BridgeRequest { id: string; method: BridgeMethod; args: unknown[] }

/** postMessage 过来的那一串：形状不对回 null（宿主不回、不抛——应用自己乱发的东西不该把宿主带崩） */
export function parseBridgeRequest(raw: unknown): BridgeRequest | null {
  if (typeof raw !== "string" || raw.length > 64 * 1024) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "" || r.id.length > 32) return null;
  if (typeof r.method !== "string" || !METHODS.has(r.method)) return null;
  return { id: r.id, method: r.method as BridgeMethod, args: Array.isArray(r.args) ? r.args : [] };
}

/** 这个方法要哪一项能力（清单里没声明的调了就拒） */
export function capabilityOf(method: BridgeMethod): AppCapability {
  if (method.startsWith("storage.")) return "storage";
  if (method.startsWith("room.")) return "room";
  if (method === "nav" || method === "back") return "nav";
  if (method === "ask") return "ask";
  if (method === "share") return "share";
  return "haptic";
}

/** 宿主推一个事件给应用（#1675）：名字与载荷都过 JSON；序列化不了的载荷推 null */
export function bridgeEventJs(name: string, payload: unknown): string {
  let v: string;
  try {
    v = JSON.stringify(payload === undefined ? null : payload) ?? "null";
  } catch {
    v = "null";
  }
  return `window.__ottoEvent(${JSON.stringify(name)}, ${v}); true;`;
}

export function bridgeDenied(method: BridgeMethod, capabilities: readonly AppCapability[]): string | null {
  const need = capabilityOf(method);
  return capabilities.includes(need) ? null : `这个应用没有声明「${need}」能力`;
}

/** 回执：注回 WebView 的那段 JS。value 经 JSON 序列化；序列化不了的回错 */
export function bridgeReplyJs(id: string, ok: boolean, value: unknown): string {
  let v: string;
  try {
    v = JSON.stringify(value === undefined ? null : value) ?? "null";
  } catch {
    return bridgeReplyJs(id, false, "回执序列化失败");
  }
  return `window.__ottoReply(${JSON.stringify(id)}, ${ok ? "true" : "false"}, ${v}); true;`;
}

/** ask 发到管理员私聊里的那句（spec §8 第 1 条「两边都有」的聊天那一半；plan 小修 3） */
export function appAskText(appName: string, text: unknown): string | null {
  const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 1000) : "";
  return t === "" ? null : `[应用「${appName.replace(/[\[\]]/g, "")}」]: ${t}`;
}

/** 应用报上来的错（{ error }）：不是这个形状回 null */
export function parseBridgeError(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const o = JSON.parse(raw) as unknown;
    if (typeof o === "object" && o !== null && typeof (o as { error?: unknown }).error === "string") return ((o as { error: string }).error).slice(0, 500);
  } catch {
    return null;
  }
  return null;
}

/** 「让管理员修」发到管理员私聊里的那句 */
export function appFixText(appName: string, version: number, error: string): string {
  return `[应用「${appName.replace(/[\[\]]/g, "")}」v${version} 出错了]: ${error.replace(/\s+/g, " ").slice(0, 400)}——让应用专员修一下、出下一版。`;
}
