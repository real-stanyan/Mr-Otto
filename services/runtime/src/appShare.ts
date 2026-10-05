// appShare —— 好友点「添加」把分享来的应用复制到自己名下（#1648）。判断住这儿、接线在 daemon（它握着 service role）。
// 认的是那条私信本身（发的人 / 收的人 / 正文现读），不认客户端报的任何一格：卡里的 appId 只是引用，
// 复制前核对——这条私信是发给你的、发的人就是卡上的人、你们还是好友、发的人确实有这个应用的这一版。
import { decodeAppCard, appShareMarker, freeSlug } from "../../../src/shared/appCard.js";
import { appObjectPath, type AppFileEntry, type AppManifest, type AppRow } from "../../../src/shared/apps.js";

export interface AppShareDeps {
  /** 那条私信；没有回 null */
  message(id: number): Promise<{ sender: string; recipient: string; body: string } | null>;
  areFriends(a: string, b: string): Promise<boolean>;
  homeOf(uid: string): Promise<string | null>;
  /** 发的人那一行应用（按 id），以及那一版的清单与文件表 */
  sourceApp(appId: string): Promise<AppRow | null>;
  sourceVersion(appId: string, version: number): Promise<{ manifest: AppManifest; files: AppFileEntry[] } | null>;
  /** 收的人主场里的应用（找已经添加过的、挑 slug） */
  appsOf(workspaceId: string): Promise<AppRow[]>;
  create(o: { workspaceId: string; ownerUid: string; slug: string; name: string; icon: string; description: string; createdByAgent: string }): Promise<AppRow>;
  recordVersion(o: { appId: string; version: number; manifest: AppManifest; files: AppFileEntry[]; builtByAgent: string; note: string; name: string; icon: string; description: string }): Promise<void>;
  copyObject(from: string, to: string): Promise<void>;
}

export type AppShareResult = { ok: true; appId: string; already: boolean } | { ok: false; message: string };

export async function acceptAppShare(d: AppShareDeps, byUid: string, messageId: number): Promise<AppShareResult> {
  const m = await d.message(messageId);
  if (m === null || m.recipient !== byUid) return { ok: false, message: "这条分享不是发给你的" };
  const card = decodeAppCard(m.body);
  if (card === null) return { ok: false, message: "这不是一条应用分享" };
  if (card.from.uid !== m.sender) return { ok: false, message: "这张卡对不上发的人" };
  if (!(await d.areFriends(m.sender, byUid))) return { ok: false, message: "你们已经不是好友了，添加不了" };
  const home = await d.homeOf(byUid);
  if (home === null) return { ok: false, message: "你还没有主场，先打开一次 App" };
  const mine = await d.appsOf(home);
  const marker = appShareMarker(card.appId);
  const existing = mine.find((a) => a.createdByAgent === marker);
  if (existing !== undefined) return { ok: true, appId: existing.id, already: true };
  const src = await d.sourceApp(card.appId);
  if (src === null || src.ownerUid !== m.sender) return { ok: false, message: "对方已经没有这个应用了" };
  const ver = await d.sourceVersion(card.appId, card.version);
  if (ver === null) return { ok: false, message: "对方的这一版已经没有了，让 TA 重新分享一次" };
  const slug = freeSlug(src.slug, (s) => mine.some((a) => a.slug === s));
  const row = await d.create({ workspaceId: home, ownerUid: byUid, slug, name: src.name, icon: src.icon, description: src.description, createdByAgent: marker });
  // 先把文件复制过去再记版本（记了版本手机就会去下，文件得先在；同 build_app）
  for (const f of ver.files) {
    await d.copyObject(appObjectPath(m.sender, card.appId, card.version, f.path), appObjectPath(byUid, row.id, 1, f.path));
  }
  await d.recordVersion({
    appId: row.id, version: 1, manifest: { ...ver.manifest, slug }, files: ver.files, builtByAgent: marker,
    note: `${card.from.name} 分享的「${src.name}」`, name: src.name, icon: src.icon, description: src.description,
  });
  return { ok: true, appId: row.id, already: false };
}

export interface AppDeleteDeps {
  app(appId: string): Promise<AppRow | null>;
  /** 这个应用每一版的文件表（删桶里的对象用） */
  versions(appId: string): Promise<{ version: number; files: AppFileEntry[] }[]>;
  removeObjects(paths: string[]): Promise<void>;
  /** 删那一行（app_versions / app_data 级联） */
  deleteRow(appId: string): Promise<void>;
}

/** 删掉我的一个应用（#1648）：只认主人。先删行（列表立刻没有它），再尽力删桶里的文件（删不掉只是占地方） */
export async function deleteApp(d: AppDeleteDeps, byUid: string, appId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const a = await d.app(appId);
  if (a === null) return { ok: true };
  if (a.ownerUid !== byUid) return { ok: false, message: "这不是你的应用" };
  const vs = await d.versions(appId);
  await d.deleteRow(appId);
  const paths = vs.flatMap((v) => v.files.map((f) => appObjectPath(byUid, appId, v.version, f.path)));
  if (paths.length > 0) await d.removeObjects(paths).catch(() => undefined);
  return { ok: true };
}
