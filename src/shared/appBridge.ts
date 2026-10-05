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
    haptic: function () { return call("haptic", []); }
  };
})(); true;`;

export type BridgeMethod = "storage.get" | "storage.set" | "storage.list" | "storage.remove" | "ask" | "share" | "nav" | "back" | "haptic";
const METHODS: ReadonlySet<string> = new Set<BridgeMethod>(["storage.get", "storage.set", "storage.list", "storage.remove", "ask", "share", "nav", "back", "haptic"]);

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
  if (method === "nav" || method === "back") return "nav";
  if (method === "ask") return "ask";
  if (method === "share") return "share";
  return "haptic";
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
