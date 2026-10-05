// 添加分享来的应用（#1648）：认那条私信本身，核对收件人 / 发的人 / 好友 / 来源；复制文件再记版本；添加过的不重复。
import { describe, expect, it } from "vitest";
import { acceptAppShare, deleteApp, type AppShareDeps } from "../../services/runtime/src/appShare.js";
import { encodeAppCard } from "../../src/shared/appCard.js";
import type { AppRow } from "../../src/shared/apps.js";

const A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const B = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const SRC = "11111111-2222-3333-4444-555555555555";
const row = (o: Partial<AppRow>): AppRow => ({ id: SRC, workspaceId: "wa", ownerUid: A, slug: "notes", name: "记事本", icon: "📝", description: "随手记", currentVersion: 2, createdByAgent: "a_apps", updatedTs: 0, ...o });
const body = encodeAppCard({ appId: SRC, version: 2, name: "记事本", icon: "📝", slug: "notes", description: "随手记", from: { uid: A, name: "继爸" } });

function rig(o: { msg?: { sender: string; recipient: string; body: string } | null; friends?: boolean; mine?: AppRow[]; src?: AppRow | null } = {}) {
  const copies: string[][] = [];
  const created: unknown[] = [];
  const versions: unknown[] = [];
  const deps: AppShareDeps = {
    message: async () => (o.msg === undefined ? { sender: A, recipient: B, body } : o.msg),
    areFriends: async () => o.friends ?? true,
    homeOf: async () => "wb",
    sourceApp: async () => (o.src === undefined ? row({}) : o.src),
    sourceVersion: async () => ({ manifest: { name: "记事本", slug: "notes", icon: "📝", entry: "index.html", capabilities: ["storage"], description: "随手记" }, files: [{ path: "index.html", size: 1, sha256: "x" }, { path: "app.js", size: 1, sha256: "y" }] }),
    appsOf: async () => o.mine ?? [],
    create: async (c) => { created.push(c); return row({ id: "new-app", workspaceId: "wb", ownerUid: B, slug: c.slug, createdByAgent: c.createdByAgent, currentVersion: 0 }); },
    recordVersion: async (v) => { versions.push(v); },
    copyObject: async (from, to) => { copies.push([from, to]); },
  };
  return { deps, copies, created, versions };
}

describe("acceptAppShare", () => {
  it("正常：在收的人主场建一行（记来源）、逐个复制文件到收的人的路径、记 v1", async () => {
    const r = rig();
    expect(await acceptAppShare(r.deps, B, 7)).toEqual({ ok: true, appId: "new-app", already: false });
    expect(r.created[0]).toMatchObject({ workspaceId: "wb", ownerUid: B, slug: "notes", createdByAgent: `share:${SRC}` });
    expect(r.copies).toEqual([[`${A}/${SRC}/2/index.html`, `${B}/new-app/1/index.html`], [`${A}/${SRC}/2/app.js`, `${B}/new-app/1/app.js`]]);
    expect(r.versions[0]).toMatchObject({ appId: "new-app", version: 1, manifest: { slug: "notes" } });
  });
  it("添加过的直接回那一个；slug 撞了换 -2", async () => {
    expect(await acceptAppShare(rig({ mine: [row({ id: "had", ownerUid: B, createdByAgent: `share:${SRC}` })] }).deps, B, 7)).toEqual({ ok: true, appId: "had", already: true });
    const r = rig({ mine: [row({ id: "other", ownerUid: B, slug: "notes", createdByAgent: "a_apps" })] });
    await acceptAppShare(r.deps, B, 7);
    expect(r.created[0]).toMatchObject({ slug: "notes-2" });
  });
  it("拒：不是发给你的 / 不是应用卡 / 卡上的人对不上 / 不是好友了 / 对方没有这个应用了", async () => {
    expect(await acceptAppShare(rig({ msg: { sender: A, recipient: "someone", body } }).deps, B, 7)).toMatchObject({ ok: false, message: "这条分享不是发给你的" });
    expect(await acceptAppShare(rig({ msg: { sender: A, recipient: B, body: "你好" } }).deps, B, 7)).toMatchObject({ ok: false });
    expect(await acceptAppShare(rig({ msg: { sender: B, recipient: B, body } }).deps, B, 7)).toMatchObject({ ok: false, message: "这张卡对不上发的人" });
    expect(await acceptAppShare(rig({ friends: false }).deps, B, 7)).toMatchObject({ ok: false, message: "你们已经不是好友了，添加不了" });
    expect(await acceptAppShare(rig({ src: row({ ownerUid: "x" }) }).deps, B, 7)).toMatchObject({ ok: false, message: "对方已经没有这个应用了" });
  });
});

describe("deleteApp（#1648）", () => {
  it("只认主人；先删行再删每一版的文件；没有这个应用当删过了", async () => {
    const removed: string[][] = [];
    const deleted: string[] = [];
    const deps = {
      app: async (id: string) => (id === "gone" ? null : row({ id, ownerUid: B })),
      versions: async () => [{ version: 1, files: [{ path: "index.html", size: 1, sha256: "x" }] }, { version: 2, files: [{ path: "index.html", size: 1, sha256: "x" }, { path: "a.js", size: 1, sha256: "y" }] }],
      removeObjects: async (p: string[]) => { removed.push(p); },
      deleteRow: async (id: string) => { deleted.push(id); },
    };
    expect(await deleteApp(deps, A, "x1")).toEqual({ ok: false, message: "这不是你的应用" });
    expect(deleted).toEqual([]);
    expect(await deleteApp(deps, B, "x1")).toEqual({ ok: true });
    expect(deleted).toEqual(["x1"]);
    expect(removed[0]).toEqual([`${B}/x1/1/index.html`, `${B}/x1/2/index.html`, `${B}/x1/2/a.js`]);
    expect(await deleteApp(deps, B, "gone")).toEqual({ ok: true });
  });
});
