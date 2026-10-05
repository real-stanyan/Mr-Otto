import { describe, expect, it } from "vitest";
import { MCP_CATALOG } from "../../src/shared/mcpCatalog.js";
import {
  APP_GONE, CATALOG_FOOTER, DESKTOP_APPS_FOOTER, DISCONNECT_LEAD, LEND_FOOTER, MOBILE_OAUTH_BLOCKED, PHONE_APPS_EMPTY,
  PHONE_APPS_FOOTER, TOOLS_PREVIEW, appDetail, catalogEmpty, connectCatalog, connectIntro, connectKind, connectedToast,
  disconnectTitle, lendRows, lendToast, paramFormError, phoneAppRows, reloginIntro, reloginToast,
  CONNECTED_MARK, allToolsLabel, appInitial, connectDialogText, connectParams, disconnectedToast, landedApp, toolCountText,
} from "../../src/shared/mobileConnectors.js";
import type { CloudViewItem } from "../../src/shared/remote/pxCloud.js";

const byId = (id: string) => MCP_CATALOG.find((e) => e.id === id)!;
const item = (over: Partial<CloudViewItem> = {}): CloudViewItem => ({
  serverId: "cloud-notion", catalogId: "notion", status: "ok", tools: ["search", "create_page"], grants: ["home"], connectedTs: 0, ...over,
});
const DAY = 86_400_000;

describe("目录", () => {
  it("Gmail 在手机目录里：去浏览器登录，不置灰（预置客户端，#1619）", () => {
    const g = connectCatalog(null, "gmail", "stanhavenoidea@gmail.com").flatMap((x) => x.items).find((i) => i.id === "gmail")!;
    expect(g).toMatchObject({ kind: "browser", blocked: null, category: "协作与项目" });
  });
  it("preview 条目（Gmail，#1636）：只有内测账号看得见；已接上的照常列出", () => {
    const ids = (email: string | null, view: CloudViewItem[] | null = null) =>
      connectCatalog(view, "gmail", email).flatMap((x) => x.items).map((i) => i.id);
    expect(ids("stan@mrotto.agency")).toContain("gmail");
    expect(ids("someone@example.com")).not.toContain("gmail");
    expect(ids(null)).not.toContain("gmail");
    expect(ids(null, [item({ serverId: "cloud-gmail", catalogId: "gmail" })])).toContain("gmail");
  });
  it("只列 http；没有「本机工具」分组；已接的标出来", () => {
    const groups = connectCatalog([item()], "");
    const all = groups.flatMap((g) => g.items);
    expect(all.every((i) => byId(i.id).transport === "http")).toBe(true);
    expect(groups.some((g) => g.category === "本机工具")).toBe(false);
    expect(all.find((i) => i.id === "notion")!.connected).toBe(true);
    expect(all.find((i) => i.id === "github")!.connected).toBe(false);
  });
  it("搜索命中名字 / 描述；没命中的分组不出现；view 为 null 时都算没接", () => {
    const groups = connectCatalog(null, "notion");
    expect(groups.flatMap((g) => g.items).map((i) => i.id)).toContain("notion");
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
    expect(groups.flatMap((g) => g.items).every((i) => !i.connected)).toBe(true);
    expect(connectCatalog(null, "zzzz-没有这个").length).toBe(0);
  });
  it("blocked：目录条目自带的 / 手机专属表里的，都带出原因；没有就是 null", () => {
    const all = connectCatalog(null, "").flatMap((g) => g.items);
    expect(all.every((i) => i.blocked === (byId(i.id).blocked ?? MOBILE_OAUTH_BLOCKED[i.id] ?? null))).toBe(true);
  });
  it("探针（2026-10-05，#1607）拒收 edge 回调的 7 个：手机上置灰并指去电脑；键都是目录里真有的 oauth 条目", () => {
    const refused = ["vercel", "monday", "shortcut", "dropbox", "cal", "intercom", "square"];
    expect(Object.keys(MOBILE_OAUTH_BLOCKED).sort()).toEqual([...refused].sort());
    for (const id of refused) expect(byId(id).auth).toBe("oauth");
    const sq = connectCatalog(null, "square").flatMap((g) => g.items).find((i) => i.id === "square")!;
    expect(sq.blocked).toContain("去电脑上接");
    // 真连上了以现实为准：已接的不受影响
    const connected = connectCatalog([item({ serverId: "cloud-square", catalogId: "square" })], "square")
      .flatMap((g) => g.items).find((i) => i.id === "square")!;
    expect(connected.connected).toBe(true);
  });
  it("接入方式：有参数 = 表单；oauth 无参数 = 浏览器；none 无参数 = 直接", () => {
    expect(connectKind(byId("notion"))).toBe("browser");
    expect(connectKind(byId("github"))).toBe("form");
    const none = MCP_CATALOG.find((e) => e.transport === "http" && e.auth === "none" && e.params.length === 0);
    if (none) expect(connectKind(none)).toBe("direct");
    expect(connectCatalog(null, "").flatMap((g) => g.items).find((i) => i.id === "github")!.kind).toBe("form");
  });
  it("接入前那段话：点明以你的身份；oauth 多一句密码不经过 Mr Otto，去登录；其余连接", () => {
    const n = connectIntro(byId("notion"));
    expect(n.lead).toBe(byId("notion").description);
    expect(n.note).toBe("接好后，你的智能体会以你的身份操作它。登录在 Notion 自己的页面上完成，密码不经过 Mr Otto。");
    expect(n.action).toBe("去登录");
    const g = connectIntro(byId("github"));
    expect(g.note).toBe("接好后，你的智能体会以你的身份操作它。");
    expect(g.action).toBe("连接");
  });
  it("重新登录的那段话", () => {
    expect(reloginIntro(byId("notion"))).toEqual({ title: "重新登录 Notion", lead: "登录过期了。登录之后，借给团队的设置都还在。", action: "去登录" });
    expect(reloginIntro(byId("github")).action).toBe("连接");
  });
  it("参数表单：缺必填说出是哪一格", () => {
    expect(paramFormError(byId("github"), {})).toBe("还缺：github_token");
    expect(paramFormError(byId("github"), { github_token: "x" })).toBeNull();
  });
});

describe("应用列表与详情", () => {
  it("手机上接的：正常行尾不画东西；needs_login 写「点一下重新登录」", () => {
    const rows = phoneAppRows([item(), item({ serverId: "cloud-linear", catalogId: "linear", status: "needs_login" })], "home");
    expect(rows[0]).toMatchObject({ serverId: "cloud-notion", title: "Notion", detail: "2 个工具", trailing: null, needsLogin: false });
    expect(rows[1]).toMatchObject({ trailing: "点一下重新登录", needsLogin: true });
  });
  it("第二行：借给了别的团队时补一句（主场不算）；没有工具写没有工具", () => {
    expect(phoneAppRows([item({ grants: ["home", "t1", "t2"] })], "home")[0]!.detail).toBe("2 个工具 · 借给了 2 个团队");
    expect(phoneAppRows([item({ grants: ["t1"] })], null)[0]!.detail).toBe("2 个工具 · 借给了 1 个团队");
    expect(phoneAppRows([item({ tools: [] })], "home")[0]!.detail).toBe("没有工具");
  });
  it("目录里已经没有的条目：名字退回 catalogId", () => {
    expect(phoneAppRows([item({ serverId: "cloud-gone", catalogId: "gone" })], "home")[0]!.title).toBe("gone");
  });
  it("借给团队：只列团队，开关读授权", () => {
    const rows = lendRows([{ id: "t1", name: "奶茶店" }, { id: "t2", name: "工作室" }], item({ grants: ["home", "t2"] }));
    expect(rows).toEqual([{ workspaceId: "t1", name: "奶茶店", on: false }, { workspaceId: "t2", name: "工作室", on: true }]);
  });
  it("详情：完整工具清单（预览条数由屏切）；状态行", () => {
    const tools = Array.from({ length: 9 }, (_, i) => `t${i}`);
    const d = appDetail(item({ tools }), 3 * DAY);
    expect(d).toMatchObject({ serverId: "cloud-notion", title: "Notion", description: byId("notion").description, needsLogin: false });
    expect(d.tools).toEqual(tools);
    expect(TOOLS_PREVIEW).toBe(6);
    expect(d.statusText).toBe("你的智能体能用 · 3 天前接入");
    expect(appDetail(item(), DAY - 1).statusText).toBe("你的智能体能用 · 今天接入");
    expect(appDetail(item({ status: "needs_login" }), 3 * DAY)).toMatchObject({ needsLogin: true, statusText: "登录过期了，智能体暂时用不了" });
  });
});

describe("文案", () => {
  it("常量逐字", () => {
    // #1671：Apple 健康进了这一组，组尾要两头都说清（健康要 Otto 开着）
    expect(PHONE_APPS_FOOTER).toBe("接好的应用凭据存在云端，手机关机也能用；Apple 健康只在 Otto 开着时读这台手机。");
    expect(DESKTOP_APPS_FOOTER).toBe("在电脑上的 Mr Otto 里接的，要在电脑上管。");
    expect(LEND_FOOTER).toBe("借给团队后，团队里的智能体会以你的身份用它。随时能关。");
    expect(PHONE_APPS_EMPTY).toBe("手机上还没接应用。\n接好之后，你的智能体会以你的身份用它。");
    expect(CATALOG_FOOTER).toBe("只列能在云端跑的应用；要装在电脑上的那几类（本机工具）在电脑上接。");
    expect(DISCONNECT_LEAD).toBe("断开后，你的智能体和借到它的团队都用不了它，云端存的登录凭据会一起删掉。");
    expect(APP_GONE).toBe("这个应用已经断开了。");
  });
  it("带参数的文案", () => {
    expect(catalogEmpty("abc")).toBe("没找到「abc」。\n目录外的应用要在电脑上接。");
    expect(disconnectTitle("Notion")).toBe("断开 Notion？");
    expect(connectedToast("Notion")).toBe("接好了。你的智能体现在能用 Notion");
    expect(reloginToast("Notion")).toBe("Notion 重新登录好了");
    expect(lendToast("奶茶店", true)).toBe("借给了「奶茶店」");
    expect(lendToast("奶茶店", false)).toBe("不再借给「奶茶店」");
  });
});

describe("弹窗与接入之后", () => {
  it("弹窗文字：接入带「以你的身份」那句；重新登录不带", () => {
    const n = connectDialogText(byId("notion"), false);
    expect(n).toEqual({ title: "接入 Notion", lead: byId("notion").description, note: connectIntro(byId("notion")).note, action: "去登录" });
    expect(connectDialogText(byId("notion"), true)).toEqual({ ...reloginIntro(byId("notion")), note: null });
  });
  it("参数：只带条目认的格子，去空白，空的不带", () => {
    expect(connectParams(byId("github"), { github_token: "  abc ", other: "x" })).toEqual({ github_token: "abc" });
    expect(connectParams(byId("github"), { github_token: "   " })).toEqual({});
  });
  it("接上了没有看重拉的视图：serverId、目录条目、状态三样都要对上", () => {
    const ok = item();
    expect(landedApp([ok], "notion", "cloud-notion")).toBe(ok);
    expect(landedApp(null, "notion", "cloud-notion")).toBeNull();
    expect(landedApp([ok], "notion", "cloud-linear")).toBeNull();
    expect(landedApp([ok], "linear", "cloud-notion")).toBeNull();
    expect(landedApp([item({ status: "needs_login" })], "notion", "cloud-notion")).toBeNull();
  });
  it("首字母方块：按码点取、大写；空名字给问号", () => {
    expect(appInitial("notion")).toBe("N");
    expect(appInitial(" 飞书")).toBe("飞");
    expect(appInitial("\u{1F600}x")).toBe("\u{1F600}");
    expect(appInitial("")).toBe("?");
  });
  it("短文案", () => {
    expect(CONNECTED_MARK).toBe("已接入");
    expect(toolCountText(0)).toBe("没有工具");
    expect(toolCountText(12)).toBe("12 个工具");
    expect(allToolsLabel(12)).toBe("全部 12 个");
    expect(disconnectedToast("Notion")).toBe("已断开 Notion");
  });
});
