// 应用连接卡（#1666）：目录解析、折叠与状态、手机侧按钮判断、文案
import { describe, expect, it } from "vitest";
import {
  APP_CONNECT_BUTTON, APP_CONNECT_TTL_MS, appConnectAction, appConnectActionFor, appConnectCardTitle, appConnectFoldOf, appConnectNeutralTitle,
  appConnectStatus, appConnectTitle,
  appConnectedOpening, appDeclinedOpening, catalogIdOfServer, cloudServerIdOf, openCardFor, resolveConnectApp,
} from "../../src/shared/appConnect.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { CloudViewItem } from "../../src/shared/remote/pxCloud.js";

let seq = 0;
const ev = (o: Record<string, unknown>): SessionEvent =>
  ({ seq: seq++, sessionId: "s1", ts: 1000, type: "app_connect", fromAgentId: "admin", ignorable: true, ...o }) as unknown as SessionEvent;
const offered = (connectId: string, catalogId: string, ts = 1000) =>
  ev({ connectId, phase: "offered", catalogId, appName: catalogId === "supabase" ? "Supabase" : catalogId, why: "查表", reason: "missing", ts });

describe("resolveConnectApp", () => {
  it("目录 id 精确命中；名字不分大小写命中", () => {
    expect(resolveConnectApp("supabase")).toMatchObject({ kind: "ok", entry: { id: "supabase" } });
    expect(resolveConnectApp("  SupaBase ")).toMatchObject({ kind: "ok", entry: { id: "supabase" } });
  });
  it("手机接不了的（实测回调被拒）回 blocked 带原因；目录外 / 本机工具回 unknown", () => {
    expect(resolveConnectApp("vercel")).toMatchObject({ kind: "blocked", entry: { id: "vercel" } });
    expect(resolveConnectApp("不存在的应用")).toEqual({ kind: "unknown" });
  });
});

describe("serverId ↔ catalogId", () => {
  it("cloud- 前缀互转；别的形状回 null", () => {
    expect(cloudServerIdOf("supabase")).toBe("cloud-supabase");
    expect(catalogIdOfServer("cloud-supabase")).toBe("supabase");
    expect(catalogIdOfServer("github")).toBeNull();
    expect(catalogIdOfServer("cloud-")).toBeNull();
  });
});

describe("折叠与状态", () => {
  it("offered → open；connected / dismissed 落了就是结局", () => {
    seq = 0;
    const f = appConnectFoldOf([offered("c1", "supabase"), offered("c2", "github"), ev({ connectId: "c2", phase: "dismissed" })]);
    expect(appConnectStatus(f.get("c1")!, 1000)).toBe("open");
    expect(appConnectStatus(f.get("c2")!, 1000)).toBe("dismissed");
    expect(f.get("c1")).toMatchObject({ catalogId: "supabase", appName: "Supabase", why: "查表", reason: "missing" });
  });
  it("24 小时没动算过期；同一应用来了新卡，旧卡算过期；别的应用的卡不顶", () => {
    seq = 0;
    const f = appConnectFoldOf([offered("c1", "supabase"), offered("c2", "github"), offered("c3", "supabase")]);
    expect(appConnectStatus(f.get("c1")!, 1000)).toBe("expired");
    expect(appConnectStatus(f.get("c2")!, 1000)).toBe("open");
    expect(appConnectStatus(f.get("c3")!, 1000 + APP_CONNECT_TTL_MS + 1)).toBe("expired");
  });
  it("openCardFor：同一应用此刻开着的那张；没有回 null", () => {
    seq = 0;
    const f = appConnectFoldOf([offered("c1", "supabase")]);
    expect(openCardFor(f, "supabase", 1000)?.connectId).toBe("c1");
    expect(openCardFor(f, "github", 1000)).toBeNull();
    expect(openCardFor(f, "supabase", 1000 + APP_CONNECT_TTL_MS + 1)).toBeNull();
  });
  it("结局事件找不到开头（窗口裁掉）就忽略", () => {
    seq = 0;
    expect(appConnectFoldOf([ev({ connectId: "x", phase: "connected" })]).size).toBe(0);
  });
});

describe("appConnectAction（手机判断该给哪个按钮）", () => {
  const item = (o: Partial<CloudViewItem>): CloudViewItem =>
    ({ serverId: "cloud-supabase", catalogId: "supabase", status: "ok", tools: [], grants: ["home1"], connectedTs: 0, ...o });
  it("四种情况", () => {
    expect(appConnectAction([], "supabase", "home1")).toBe("connect");
    expect(appConnectAction([item({ status: "needs_login" })], "supabase", "home1")).toBe("relogin");
    expect(appConnectAction([item({ grants: [] })], "supabase", "home1")).toBe("grant");
    expect(appConnectAction([item({})], "supabase", "home1")).toBe("ready");
  });
  it("标题与按钮字", () => {
    expect(appConnectTitle("connect", "Supabase")).toBe("要连上 Supabase 才能办");
    expect(appConnectTitle("relogin", "Supabase")).toBe("Supabase 的登录过期了");
    expect(appConnectTitle("grant", "Supabase")).toBe("Supabase 还没开给这里");
    expect(appConnectTitle("ready", "Supabase")).toBe("Supabase 已经连好了");
    expect(APP_CONNECT_BUTTON).toEqual({ connect: "去连接", relogin: "重新登录", grant: "打开", ready: "好了，接着办" });
  });
});

describe("appConnectActionFor（卡与弹窗共用：带上卡的 reason、视图还没拉到算不知道）", () => {
  const item = (o: Partial<CloudViewItem>): CloudViewItem =>
    ({ serverId: "cloud-supabase", catalogId: "supabase", status: "ok", tools: [], grants: ["home1"], connectedTs: 0, ...o });
  it("视图还没拉到（null）：不知道，回 null——卡上主按钮不给点、弹窗不弹", () => {
    expect(appConnectActionFor(null, "supabase", "home1", "missing")).toBeNull();
    expect(appConnectActionFor(null, "supabase", "home1", "needs_login")).toBeNull();
  });
  it("missing：照 appConnectAction", () => {
    expect(appConnectActionFor([], "supabase", "home1", "missing")).toBe("connect");
    expect(appConnectActionFor([item({})], "supabase", "home1", "missing")).toBe("ready");
    expect(appConnectActionFor([item({ grants: [] })], "supabase", "home1", "missing")).toBe("grant");
  });
  it("needs_login：视图说好着（edge 回 409 之前拉的旧视图）也给重新登录——卡本身就是登录失效的证据", () => {
    expect(appConnectActionFor([item({})], "supabase", "home1", "needs_login")).toBe("relogin");
    expect(appConnectActionFor([item({ grants: [] })], "supabase", "home1", "needs_login")).toBe("relogin");
    expect(appConnectActionFor([item({ status: "needs_login" })], "supabase", "home1", "needs_login")).toBe("relogin");
  });
  it("needs_login 但视图里根本没有这个应用（已经删了）：去连接", () => {
    expect(appConnectActionFor([], "supabase", "home1", "needs_login")).toBe("connect");
  });
});

describe("卡片标题（关了的卡 / 客人 / 还不知道该给哪个按钮时用中性标题）", () => {
  it("中性标题", () => {
    expect(appConnectNeutralTitle("Supabase")).toBe("要用 Supabase");
  });
  it("开着、我点得了、知道按钮：跟按钮走；否则中性", () => {
    expect(appConnectCardTitle({ status: "open", canAct: true, appName: "Supabase" }, "relogin")).toBe("Supabase 的登录过期了");
    expect(appConnectCardTitle({ status: "open", canAct: true, appName: "Supabase" }, null)).toBe("要用 Supabase");
    expect(appConnectCardTitle({ status: "open", canAct: false, appName: "Supabase" }, "ready")).toBe("要用 Supabase");
    for (const status of ["connected", "dismissed", "expired"] as const) {
      expect(appConnectCardTitle({ status, canAct: true, appName: "Supabase" }, "ready")).toBe("要用 Supabase");
    }
  });
});

describe("开场白", () => {
  it("连上 / 没连各一句，点名应用", () => {
    expect(appConnectedOpening("Supabase")).toContain("连上了 Supabase");
    expect(appDeclinedOpening("Supabase")).toContain("没连 Supabase");
  });
});
