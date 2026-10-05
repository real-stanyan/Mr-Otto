// build_app（#1591，spec §3.3）：从沙箱目录到一版应用的那条线——列 / 读 / 校验 / 上传 / 记版本 / 落卡，每一步的判据。
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import { APP_CHECK_JS, createBuildAppTool, type BuildAppDeps } from "../../services/runtime/src/buildAppTool.js";
import { createInMemoryAppStore } from "../../services/runtime/src/appStore.js";

const world = {} as ExecutionWorld;

const MANIFEST = { name: "记事本", slug: "notes", icon: "📝", entry: "index.html", capabilities: ["storage"], description: "随手记", design: { accent: "#0a0" } };

/** 一个假的 /work：按 exec 的脚本形状回 find 的清单或 base64 的文件 */
function fakeWork(files: Record<string, string | Uint8Array>) {
  const calls: string[] = [];
  const exec: BuildAppDeps["exec"] = async (script) => {
    calls.push(script);
    const dir = /cd \/work\/'([^']+)'/.exec(script)?.[1];
    if (dir !== undefined) {
      const prefix = `${dir}/`;
      const rows = Object.entries(files).filter(([p]) => p.startsWith(prefix)).map(([p, v]) => `${p.slice(prefix.length)}\t${Buffer.from(v).length}`);
      if (rows.length === 0 && Object.keys(files).every((p) => !p.startsWith(prefix))) return { stdout: "", stderr: "", exitCode: 3 };
      return { stdout: rows.join("\n") + "\n", stderr: "", exitCode: 0 };
    }
    const path = /base64 -w0 -- \/work\/'([^']+)'/.exec(script)?.[1];
    if (path !== undefined) {
      const v = files[path];
      if (v === undefined) return { stdout: "", stderr: "no such file", exitCode: 1 };
      return { stdout: Buffer.from(v).toString("base64"), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${script}`, exitCode: 2 };
  };
  return { exec, calls };
}

function setup(files: Record<string, string | Uint8Array>, agentId = "a_apps") {
  const work = fakeWork(files);
  const store = createInMemoryAppStore();
  const uploads: { path: string; bytes: Uint8Array; contentType: string }[] = [];
  const cards: Parameters<BuildAppDeps["card"]>[0][] = [];
  const tool = createBuildAppTool({
    agentId, workspaceId: "w1", ownerUid: "owner",
    exec: work.exec,
    upload: async (path, bytes, contentType) => { uploads.push({ path, bytes, contentType }); },
    store,
    card: (e) => cards.push(e),
  });
  return { tool, store, uploads, cards, calls: work.calls };
}

const GOOD = {
  "apps/notes/manifest.json": JSON.stringify(MANIFEST),
  "apps/notes/index.html": "<html><body><script src='app.js'></script></body></html>",
  "apps/notes/app.js": "window.otto.storage.get('notes')",
  "apps/notes/icon.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
};

describe("build_app", () => {
  it("合规的目录：建应用行、传每个文件、记 v1（带 sha256）、落一张卡；回执给模型说清楚", async () => {
    const s = setup(GOOD);
    const out = await s.tool.run({ dir: "apps/notes", note: "第一版" }, world);
    expect(out).toContain("「记事本」v1");
    expect(out).toContain("4 个文件");
    const [app] = s.store.rows();
    expect(app).toMatchObject({ slug: "notes", name: "记事本", icon: "📝", currentVersion: 1, createdByAgent: "a_apps", workspaceId: "w1", ownerUid: "owner" });
    // 对象路径：<uid>/<appId>/<version>/<path>；二进制原样、content-type 按扩展名
    expect(s.uploads.map((u) => u.path).sort()).toEqual([`owner/${app!.id}/1/app.js`, `owner/${app!.id}/1/icon.png`, `owner/${app!.id}/1/index.html`, `owner/${app!.id}/1/manifest.json`]);
    const png = s.uploads.find((u) => u.path.endsWith("icon.png"))!;
    expect([...png.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    expect(png.contentType).toBe("image/png");
    expect(s.uploads.find((u) => u.path.endsWith("index.html"))!.contentType).toBe("text/html; charset=utf-8");
    const [v] = s.store.versions();
    expect(v).toMatchObject({ appId: app!.id, version: 1, note: "第一版", manifest: { slug: "notes", capabilities: ["storage"], design: { accent: "#0a0" } } });
    const js = v!.files.find((f) => f.path === "app.js")!;
    expect(js.sha256).toBe(createHash("sha256").update(GOOD["apps/notes/app.js"]).digest("hex"));
    expect(js.size).toBe(Buffer.from(GOOD["apps/notes/app.js"]).length);
    expect(s.cards).toEqual([{ appId: app!.id, version: 1, name: "记事本", icon: "📝", note: "第一版" }]);
  });

  it("同一个 slug 再打一次 = 同一应用的 v2：不新建行，版本号 +1，卡上也是 v2", async () => {
    const s = setup(GOOD);
    await s.tool.run({ dir: "apps/notes" }, world);
    await s.tool.run({ dir: "/work/apps/notes/", note: "改了配色" }, world);
    expect(s.store.rows()).toHaveLength(1);
    expect(s.store.rows()[0]!.currentVersion).toBe(2);
    expect(s.store.versions().map((v) => v.version)).toEqual([1, 2]);
    expect(s.uploads.filter((u) => u.path.includes("/2/"))).toHaveLength(4);
    expect(s.cards[1]).toMatchObject({ version: 2, note: "改了配色" });
  });

  it("先传文件再记版本：上传失败就不记版本、不落卡（手机不会去下一份不存在的包）", async () => {
    const work = fakeWork(GOOD);
    const store = createInMemoryAppStore();
    const cards: unknown[] = [];
    const tool = createBuildAppTool({
      agentId: "a_apps", workspaceId: "w1", ownerUid: "owner", exec: work.exec, store, card: (e) => cards.push(e),
      upload: async (path) => { if (path.endsWith("app.js")) throw new Error("storage down"); },
    });
    await expect(tool.run({ dir: "apps/notes" }, world)).rejects.toThrow("storage down");
    expect(store.versions()).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("dir 必须是 apps/<slug>：别的目录、越界、空都拒", async () => {
    const s = setup(GOOD);
    await expect(s.tool.run({ dir: "notes" }, world)).rejects.toThrow("apps/<slug>");
    await expect(s.tool.run({ dir: "apps/../etc" }, world)).rejects.toThrow("apps/<slug>");
    await expect(s.tool.run({}, world)).rejects.toThrow("apps/<slug>");
    expect(s.calls).toEqual([]);
  });

  it("目录不存在 / 没有 manifest / manifest 不是 JSON / 清单形状不对 / 静态检查不过——每条都是一句能照着改的话，且不碰上传", async () => {
    const miss = setup(GOOD);
    await expect(miss.tool.run({ dir: "apps/todo" }, world)).rejects.toThrow("/work/apps/todo 不存在");

    const noMf = setup({ "apps/x/index.html": "<html></html>" });
    await expect(noMf.tool.run({ dir: "apps/x" }, world)).rejects.toThrow("manifest.json");

    const badJson = setup({ "apps/x/manifest.json": "{nope", "apps/x/index.html": "<html></html>" });
    await expect(badJson.tool.run({ dir: "apps/x" }, world)).rejects.toThrow("不是合法的 JSON");

    const badShape = setup({ "apps/x/manifest.json": JSON.stringify({ ...MANIFEST, slug: "Bad Slug" }), "apps/x/index.html": "<html></html>" });
    await expect(badShape.tool.run({ dir: "apps/x" }, world)).rejects.toThrow("manifest.slug");

    const net = setup({ "apps/notes/manifest.json": JSON.stringify(MANIFEST), "apps/notes/index.html": "<script>fetch('https://x')</script>" });
    await expect(net.tool.run({ dir: "apps/notes" }, world)).rejects.toThrow("没有外网");
    for (const s of [miss, noMf, badJson, badShape, net]) {
      expect(s.uploads).toEqual([]);
      expect(s.store.rows()).toEqual([]);
    }
  });

  it("单文件超限在读之前就拦（find 的字节数），不会先把一个大文件 base64 读回来", async () => {
    const big = setup({ "apps/notes/manifest.json": JSON.stringify(MANIFEST), "apps/notes/index.html": "<html></html>", "apps/notes/video.webp": new Uint8Array(600 * 1024) });
    await expect(big.tool.run({ dir: "apps/notes" }, world)).rejects.toThrow("太大");
    expect(big.calls.filter((c) => c.includes("base64"))).toEqual([]);
  });

  it("不要审批、直接露给模型；工具名是 build_app", () => {
    const s = setup(GOOD);
    expect(s.tool.def.name).toBe("build_app");
    expect(s.tool.requiresApproval).toBe(false);
    expect(s.tool.exposure).toBe("direct");
  });
});

describe("build_app 打包前在沙箱里试开每一页（#1591 真机）", () => {
  function withCheck(result: { stdout: string; stderr: string; exitCode: number }) {
    const work = fakeWork(GOOD);
    const scripts: string[] = [];
    const store = createInMemoryAppStore();
    const uploads: string[] = [];
    const tool = createBuildAppTool({
      agentId: "a_apps", workspaceId: "w1", ownerUid: "owner", store, card: () => {},
      upload: async (path) => { uploads.push(path); },
      exec: async (script) => {
        if (script.includes("check.js")) { scripts.push(script); return result; }
        return work.exec(script);
      },
    });
    return { tool, scripts, store, uploads };
  }
  it("页面报错（退出码 4）：不打包、把报错原样给模型", async () => {
    const r = withCheck({ stdout: JSON.stringify(["index.html：Cannot read properties of undefined (reading 'addEventListener')"]), stderr: "", exitCode: 4 });
    await expect(r.tool.run({ dir: "apps/notes" }, world)).rejects.toThrow("页面一打开就报错");
    await expect(r.tool.run({ dir: "apps/notes" }, world)).rejects.toThrow("addEventListener");
    expect(r.uploads).toEqual([]);
    expect(r.store.rows()).toEqual([]);
  });
  it("检查脚本装 jsdom、跑 check.js、带上每一页；没报错照常打包", async () => {
    const r = withCheck({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(await r.tool.run({ dir: "apps/notes" }, world)).toContain("试开过、没报错");
    expect(r.scripts[0]).toContain("npm i jsdom");
    expect(r.scripts[0]).toContain("'index.html'");
    expect(r.uploads.length).toBeGreaterThan(0);
  });
  it("检查本身没跑起来（装不上 jsdom 等）：不拦，回执里说一句", async () => {
    const r = withCheck({ stdout: "", stderr: "npm ERR", exitCode: 5 });
    expect(await r.tool.run({ dir: "apps/notes" }, world)).toContain("没能在沙箱里试开页面");
  });
});

describe("房间（#1675）", () => {
  it("jsdom 假桥：room.list / room.rooms 与 storage.list 一样回 []（用了房间的应用试开不因 null.map 报错）", () => {
    expect(APP_CHECK_JS).toContain(`["storage.list", "room.list", "room.rooms"].includes(m.method) ? [] : null`);
  });
  it("工具说明写了房间 API", () => {
    const def = createBuildAppTool({ agentId: "a", workspaceId: "w", ownerUid: "u", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), upload: async () => {}, store: createInMemoryAppStore(), card: () => {} }).def;
    for (const s of ["otto.room", "ifRev", "room.change", "ping"]) expect(def.description).toContain(s);
    // #1675 终审：限速回 false、不在房间拒、current() 的形状、删除也走 room.change、from 是自报的
    for (const s of ["回 false", "还没进房间", "me:{uid,name}", "members:[{uid,name,status}]", "{key, removed:true}", "自己的写也会收到", "from 是对方自报的", "胜负结果要写进 set"]) expect(def.description).toContain(s);
  });
});
