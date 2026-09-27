// mobileMachine 的用例（#1356 A5）。时间只用「刚刚」那一档与注入的 NOW，不碰本机时区
import { describe, expect, it } from "vitest";
import type { BillingMe, WorkspaceUsage } from "../../src/shared/billing.js";
import {
  APPS_EMPTY, APPS_FOOTER, FILES_FOOTER, FILES_SEARCH_PLACEHOLDER, MACHINE_FOOTER, USAGE_EMPTY, WIKI_ABSENT, WIKI_EMPTY, WIKI_FOOTER,
  appRows, baseName, machineRows, machineShareText, usageAfterError, usageErrorText, usageHeroText, usageNote, usageTone,
  wikiEditError, wikiGroupTitle, wikiGroupsOf, wikiIndexAfterError, wikiIndexFrom, wikiLinkRows, wikiMatches, wikiMetaLine,
  wikiPageCount, wikiPageFrom, workEntryRows, workFileText, workFolderText, workFolderTruncated, workHitRows, workIcon,
  type UsageLoad, type WikiIndexState,
} from "../../src/shared/mobileMachine.js";
import type { CsWorkEntry } from "../../src/shared/remote/cloudSession.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";
import { serializeWikiPage, type WikiIndexGroup, type WikiPage } from "../../src/shared/wiki.js";
import { entryMeta } from "../../src/shared/workFilesView.js";
import { usageScale, usageWindowText } from "../../src/shared/workspaceUsageView.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const NOW = 1_800_000_000_000;

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
});
const HOME: WorkspaceSnapshot = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }],
  connectors: [
    { workspaceId: "home1", hostUid: "me", serverId: "github", label: "GitHub", tools: [] },
    { workspaceId: "home1", hostUid: "me", serverId: "shopify", label: "  ", tools: ["orders", "stock"] },
  ],
  sessions: [],
  agents: [agent("admin", "管理员"), agent("a_000000000001", "开发"), agent("a_000000000002", "运维")],
};

const GROUPS: WikiIndexGroup[] = [
  { name: "常驻", entries: [{ path: "team.md", title: "团队口径", summary: "每轮都带着", pinned: true }] },
  { name: "agents", entries: [{ path: "agents/a_000000000001.md", title: "开发", summary: "", pinned: false }] },
  { name: "customers", entries: [{ path: "customers/acme.md", title: "Acme 这家客户", summary: "按月结", pinned: false }] },
];

const usage = (over: Partial<WorkspaceUsage> = {}): WorkspaceUsage => ({
  workspaceId: "home1", ownerUid: "me", weekStartAt: NOW - 3 * 86_400_000, weekEndAt: NOW + 4 * 86_400_000,
  weekLimitMicro: 1_000_000,
  rows: [{ agentId: "a_000000000001", costMicro: 380_000, calls: 12, promptTokens: 1000, cachedTokens: 0, completionTokens: 500 }],
  ...over,
});

const billingMe = (): BillingMe => ({
  plan: "pro", status: "active", plans: [],
  windows: {
    h5: { usedMicro: 0, limitMicro: 1_000_000, resetAt: NOW + 60_000 },
    week: { usedMicro: 83_000, limitMicro: 1_000_000, resetAt: NOW + 86_400_000 },
  },
  addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: [], imageModels: [], ttsModels: [], modelPlatforms: {},
});
const snap = (me: BillingMe): BillingSnapshotView => ({ me, fetchedAt: NOW, exhausted: null });

const page = (over: Partial<WikiPage["front"]> = {}, body = ""): WikiPage => ({
  path: "team.md",
  front: { title: "团队口径", summary: "每轮都带着", pinned: false, updatedBy: "开发", updatedAt: new Date(NOW - 30_000).toISOString(), sources: [], ...over },
  body,
});

describe("目录", () => {
  it("页顶那一句：几只共用这一台（不写「一直开着」——空闲会停）", () => {
    expect(machineShareText(HOME)).toBe("3 只智能体共用这一台");
    expect(MACHINE_FOOTER).toBe("这台电脑在云端。一阵子没活干它会自己睡着，有活时再醒——文件都还在。");
  });
  it("四行：文件不报数；还在读的格子不写字", () => {
    const rows = machineRows({ apps: 0, wiki: { kind: "loading" }, usage: { kind: "loading" } });
    expect(rows.map((r) => [r.key, r.title, r.value])).toEqual([
      ["files", "文件", null], ["apps", "应用", "还没有"], ["wiki", "记忆", null], ["usage", "这周用了多少", null],
    ]);
    expect(rows.map((r) => r.detail)).toEqual(["它们干活留下的东西", "它们能拿你的身份去用的那几个", "它们自己写、互相看得见", "按智能体分"]);
  });
  it("读到了：应用几个、记忆几页、这周占了百分之几", () => {
    const rows = machineRows({ apps: 2, wiki: { kind: "ok", groups: GROUPS }, usage: { kind: "ok", usage: usage() } });
    expect(rows.map((r) => r.value)).toEqual([null, "2 个", "3 页", "38.0%"]);
  });
  it("电脑还没开过：记忆写「还没有」；读不到但手上有上一份就照上一份报", () => {
    expect(machineRows({ apps: 1, wiki: { kind: "absent" }, usage: { kind: "loading" } })[2]?.value).toBe("还没有");
    expect(machineRows({ apps: 1, wiki: { kind: "error", message: "x", groups: GROUPS }, usage: { kind: "error", message: "x", usage: usage() } }).map((r) => r.value)).toEqual([null, "1 个", "3 页", "38.0%"]);
    expect(machineRows({ apps: 1, wiki: { kind: "error", message: "x", groups: null }, usage: { kind: "error", message: "x", usage: null } }).map((r) => r.value)).toEqual([null, "1 个", null, null]);
  });
  it("分母读不到时这周那一格不报数", () => {
    expect(machineRows({ apps: 0, wiki: { kind: "loading" }, usage: { kind: "ok", usage: usage({ weekLimitMicro: null }) } })[3]?.value).toBeNull();
  });
});

describe("记忆", () => {
  it("索引读回来：电脑没开过 / 没有索引 = 一页没有 / 读到了 / 读不出来", () => {
    expect(wikiIndexFrom({ kind: "absent" })).toEqual({ kind: "absent" });
    expect(wikiIndexFrom({ kind: "missing" })).toEqual({ kind: "ok", groups: [] });
    const ok = wikiIndexFrom({ kind: "file", text: "# 索引\n\n## 常驻\n- [[team]] 团队口径 — 每轮都带着\n", truncated: false, size: 40 });
    expect(ok.kind).toBe("ok");
    expect(wikiIndexFrom({ kind: "binary", size: 3 })).toEqual({ kind: "error", message: "记忆的索引读不出来。", groups: null });
  });
  it("读不到 ≠ 空：上一份清单留在原地", () => {
    const prev: WikiIndexState = { kind: "ok", groups: GROUPS };
    expect(wikiIndexAfterError(prev, "断了")).toEqual({ kind: "error", message: "断了", groups: GROUPS });
    expect(wikiIndexAfterError({ kind: "loading" }, "断了")).toEqual({ kind: "error", message: "断了", groups: null });
    expect(wikiGroupsOf({ kind: "absent" })).toBeNull();
    expect(wikiGroupsOf(prev)).toBe(GROUPS);
  });
  it("页数按路径去重；agents 那一组换个人话的名字", () => {
    expect(wikiPageCount([...GROUPS, { name: "又一组", entries: [GROUPS[0]!.entries[0]!] }])).toBe(3);
    expect(wikiGroupTitle("agents")).toBe("各只自己那一页");
    expect(wikiGroupTitle("customers")).toBe("customers");
  });
  it("一页读回来的几种结局", () => {
    const p = page();
    const ok = wikiPageFrom("team.md", { kind: "file", text: serializeWikiPage(p), truncated: false, size: 100 });
    expect(ok.ok && ok.page.front.title).toBe("团队口径");
    expect(wikiPageFrom("x.md", { kind: "missing" })).toEqual({ ok: false, message: "这一页不在了，可能刚被删掉或改名了。" });
    expect(wikiPageFrom("x.md", { kind: "absent" })).toEqual({ ok: false, message: WIKI_ABSENT });
    expect(wikiPageFrom("x.md", { kind: "binary", size: 1 })).toEqual({ ok: false, message: "这一页读不出来（不是文本）。" });
  });
  it("页头那一行：谁写的 · 什么时候 · 常驻；读不出时间就不写那一段", () => {
    expect(wikiMetaLine(page(), NOW)).toBe("开发 · 刚刚");
    expect(wikiMetaLine(page({ pinned: true }), NOW)).toBe("开发 · 刚刚 · 常驻");
    expect(wikiMetaLine(page({ updatedAt: "", updatedBy: "  " }), NOW)).toBe("—");
  });
  it("它提到的：按索引认出标题，链坏的与自己链自己不列", () => {
    const p = page({}, "见 [[customers/acme]] 与 [[customers/acme|Acme]]，还有 [[nope]]，以及 [[team]]");
    expect(wikiLinkRows(p, GROUPS).map((e) => e.path)).toEqual(["customers/acme.md"]);
  });
  it("名册搜索里记忆那一半：标题 / 摘要 / 路径，不分大小写，同一页只出一次，封顶", () => {
    expect(wikiMatches(GROUPS, "")).toEqual([]);
    expect(wikiMatches(GROUPS, "acme").map((e) => e.path)).toEqual(["customers/acme.md"]);
    expect(wikiMatches(GROUPS, "按月").map((e) => e.path)).toEqual(["customers/acme.md"]);
    expect(wikiMatches([...GROUPS, GROUPS[2]!], "ACME").length).toBe(1);
    expect(wikiMatches(GROUPS, ".md", 2).length).toBe(2);
  });
  it("改一页之前的校验：字段名说中文", () => {
    expect(wikiEditError({ title: "团队口径", summary: "", pinned: false, sources: [] })).toBeNull();
    expect(wikiEditError({ title: " ", summary: "", pinned: false, sources: [] })).toBe("标题必填，且不能是空白");
    expect(wikiEditError({ title: "a [[b]]", summary: "", pinned: false, sources: [] })).toBe("标题不能含 [[ 或 ]]");
  });
  it("几句固定话", () => {
    expect(WIKI_FOOTER).toBe("你也能改——存了之后，它们下一次开口就按新的来。");
    expect(WIKI_EMPTY).toBe("它们还没记下什么。干活时记下的口径、习惯会出现在这里。");
    expect(WIKI_ABSENT).toBe("它们的电脑还没开过——第一次让它们干活时才会建，记忆也在那时候生成。");
  });
});

describe("文件", () => {
  const e = (name: string, kind: CsWorkEntry["kind"], size = 0): CsWorkEntry => ({ name, kind, size, mtimeMs: NOW - 86_400_000 });
  it("一层 → 行：目录在前、再按名字；路径拼好；other 点不开", () => {
    const rows = workEntryRows("docs", [e("b.md", "file", 2048), e("z-dir", "dir"), e("a.png", "file", 10), e("link", "other"), e("a-dir", "dir")], NOW);
    expect(rows.map((r) => r.name)).toEqual(["a-dir", "z-dir", "a.png", "b.md", "link"]);
    expect(rows[0]).toEqual({ key: "docs/a-dir", path: "docs/a-dir", name: "a-dir", icon: "folder", meta: entryMeta(e("a-dir", "dir"), NOW), opens: "dir" });
    expect(rows[2]).toMatchObject({ icon: "image", opens: "file" });
    expect(rows[4]).toMatchObject({ icon: "file", opens: null });
    expect(workEntryRows("", [e("x.txt", "file")], NOW)[0]?.path).toBe("x.txt");
  });
  it("图标按扩展名认图片，目录一律是文件夹", () => {
    expect(workIcon("A.JPEG", "file")).toBe("image");
    expect(workIcon("photos", "dir")).toBe("folder");
    expect(workIcon("notes.md", "file")).toBe("file");
  });
  it("三种「空」分开说", () => {
    expect(workFolderText({ kind: "absent" })).toBe("它们的电脑还没开过——第一次让它们干活时才会建。");
    expect(workFolderText({ kind: "missing" })).toBe("这个位置现在没有东西，可能刚被删掉或改名了。");
    expect(workFolderText({ kind: "dir", entries: [], truncated: false })).toBe("还是空的。它们做出来的东西会出现在这里。");
    expect(workFolderText({ kind: "dir", entries: [e("a", "file")], truncated: false })).toBeNull();
    expect(workFolderTruncated({ kind: "dir", entries: [e("a", "file")], truncated: true })).toBe("这一层东西太多，只列了前一部分。");
    expect(workFolderTruncated({ kind: "dir", entries: [], truncated: false })).toBeNull();
  });
  it("一个文件底下那一句", () => {
    expect(workFileText({ kind: "binary", size: 2048 })).toBe("这是一个二进制文件（2.0 KB），手机上显示不出内容。");
    expect(workFileText({ kind: "file", text: "abc", truncated: true, size: 200_000 })).toBe("文件有 195.3 KB，这里只显示了开头一段。");
    expect(workFileText({ kind: "file", text: "", truncated: false, size: 0 })).toBe("这是一个空文件。");
    expect(workFileText({ kind: "file", text: "abc", truncated: false, size: 3 })).toBeNull();
    expect(workFileText({ kind: "missing" })).toBe("这个文件现在不在了，可能刚被删掉或改名了。");
  });
  it("搜索结果：按名的写它在哪个文件夹，按内容的写第几行", () => {
    expect(workHitRows([{ rel: "notes/todo.md", line: null, text: null }, { rel: "logo.png", line: null, text: null }, { rel: "a/b.ts", line: 12, text: "  // TODO  " }])).toEqual([
      { key: "notes/todo.md::0", path: "notes/todo.md", title: "todo.md", detail: "notes", icon: "file" },
      { key: "logo.png::1", path: "logo.png", title: "logo.png", detail: "最外层", icon: "image" },
      { key: "a/b.ts:12:2", path: "a/b.ts", title: "b.ts", detail: "第 12 行：// TODO", icon: "file" },
    ]);
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(baseName("")).toBe("");
  });
  it("两句固定话", () => {
    expect(FILES_FOOTER).toBe("文件在云端那台电脑上，下不到手机上；要看哪一份就点开，或者让它们在聊天里念给你。");
    expect(FILES_SEARCH_PLACEHOLDER).toBe("找文件；打 ? 搜内容");
  });
});

describe("应用", () => {
  it("名字空着退回 serverId；第二行与桌面同一句", () => {
    expect(appRows(HOME)).toEqual([
      { key: "me:github", title: "GitHub", detail: "全部工具" },
      { key: "me:shopify", title: "shopify", detail: "2 个工具" },
    ]);
    expect(APPS_EMPTY).toBe("还没有接应用。");
    expect(APPS_FOOTER).toBe("新的应用要在电脑上的 Mr Otto 里接；要登录的也在那台电脑上登，凭据不经过这个手机。它们此刻连没连上，这里看不出来。");
  });
});

describe("用量页", () => {
  it("大数字底下那一行：分母 + 哪一周；知道本周那扇窗时补一句还剩多少", () => {
    const u = usage();
    expect(usageHeroText(u, null, NOW)).toBe(`占你这一周额度的比例 · ${usageWindowText(u)}`);
    expect(usageHeroText(u, snap(billingMe()), NOW)).toBe(`占你这一周额度的比例 · ${usageWindowText(u)} · 本周还剩 91.7%`);
    expect(usageHeroText(usage({ weekLimitMicro: null }), null, NOW)).toBe(`这一周它们调了几次模型 · ${usageWindowText(u)}`);
  });
  it("大数字那根条的色档：分母在时按已用判，不在时一律 neutral", () => {
    expect(usageTone(usage())).toBe("neutral");
    expect(usageTone(usage({ rows: [{ agentId: "a", costMicro: 800_000, calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }] }))).toBe("warn");
    expect(usageTone(usage({ rows: [{ agentId: "a", costMicro: 950_000, calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }] }))).toBe("deny");
    expect(usageTone(usage({ weekLimitMicro: null }))).toBe("neutral");
  });
  it("组尾那句：分母是什么（主场里所有者就是你）", () => {
    expect(usageNote(usageScale(usage()))).toBe("百分比 = 占你本周额度的比例，与账号页「本周」那扇窗同一把尺子；条是各自在这几只里的比重。");
    expect(usageNote(usageScale(usage({ weekLimitMicro: null })))).toBe("读不到你的额度上限（没有活跃订阅，或服务端还不报这一格），所以百分比暂时按这一周它们的合计算——不是占额度的比例。");
    expect(USAGE_EMPTY).toBe("这一周它们还没用额度。");
  });
  it("读不到 ≠ 空：上一份用量留着；断网说人话", () => {
    const prev: UsageLoad = { kind: "ok", usage: usage() };
    expect(usageAfterError(prev, "x")).toEqual({ kind: "error", message: "x", usage: usage() });
    expect(usageAfterError({ kind: "loading" }, "x")).toEqual({ kind: "error", message: "x", usage: null });
    expect(usageErrorText("Network request failed")).toBe("连不上服务端——网络不通，或者对面暂时没响应。");
    expect(usageErrorText("not_member")).toBe("not_member");
  });
});
