// appStore —— apps / app_versions 两张表在 runtime 这一侧（#1591，spec §3）。接口 + 内存实现（测试）+ 真库实现（service role）。
// 文件本体不在这里（那是 Storage，build_app 的 upload 依赖）；这里只管索引与投影两张表。
import type { SupabaseClient } from "@supabase/supabase-js";
import { appRowOf, type AppFileEntry, type AppManifest, type AppRow } from "../../../src/shared/apps.js";

export interface AppStore {
  /** 按 slug 找这个主场里已有的应用；没有回 null */
  findBySlug(workspaceId: string, slug: string): Promise<AppRow | null>;
  /** 建一行（version 0，还没有任何版本） */
  create(o: { workspaceId: string; ownerUid: string; slug: string; name: string; icon: string; description: string; createdByAgent: string }): Promise<AppRow>;
  /** 记一版并把 current_version 推到它；回这一版的号 */
  recordVersion(o: { appId: string; version: number; manifest: AppManifest; files: AppFileEntry[]; builtByAgent: string; note: string; name: string; icon: string; description: string }): Promise<void>;
}

export function createInMemoryAppStore(): AppStore & { rows: () => AppRow[]; versions: () => { appId: string; version: number; manifest: AppManifest; files: AppFileEntry[]; note: string }[] } {
  const apps: AppRow[] = [];
  const versions: { appId: string; version: number; manifest: AppManifest; files: AppFileEntry[]; note: string }[] = [];
  let n = 0;
  return {
    async findBySlug(workspaceId, slug) {
      return apps.find((a) => a.workspaceId === workspaceId && a.slug === slug) ?? null;
    },
    async create(o) {
      const row: AppRow = { id: `app_${++n}`, workspaceId: o.workspaceId, ownerUid: o.ownerUid, slug: o.slug, name: o.name, icon: o.icon, description: o.description, currentVersion: 0, createdByAgent: o.createdByAgent, updatedTs: Date.now() };
      apps.push(row);
      return row;
    },
    async recordVersion(o) {
      versions.push({ appId: o.appId, version: o.version, manifest: o.manifest, files: o.files, note: o.note });
      const a = apps.find((x) => x.id === o.appId);
      if (a) Object.assign(a, { currentVersion: o.version, name: o.name, icon: o.icon, description: o.description, updatedTs: Date.now() });
    },
    rows: () => apps.map((a) => ({ ...a })),
    versions: () => versions.map((v) => ({ ...v })),
  };
}

export function createSupabaseAppStore(client: SupabaseClient): AppStore {
  return {
    async findBySlug(workspaceId, slug) {
      const { data, error } = await client.from("apps").select("*").eq("workspace_id", workspaceId).eq("slug", slug).maybeSingle();
      if (error) throw new Error(`apps 读取失败：${error.message}`);
      return data === null ? null : appRowOf(data);
    },
    async create(o) {
      const { data, error } = await client.from("apps")
        .insert({ workspace_id: o.workspaceId, owner_uid: o.ownerUid, slug: o.slug, name: o.name, icon: o.icon, description: o.description, created_by_agent: o.createdByAgent })
        .select("*").single();
      if (error) throw new Error(`apps 写入失败：${error.message}`);
      const row = appRowOf(data);
      if (row === null) throw new Error("apps 写入回包形状不对");
      return row;
    },
    async recordVersion(o) {
      const v = await client.from("app_versions").insert({ app_id: o.appId, version: o.version, manifest: o.manifest, files: o.files, built_by_agent: o.builtByAgent, note: o.note });
      if (v.error) throw new Error(`app_versions 写入失败：${v.error.message}`);
      const a = await client.from("apps").update({ current_version: o.version, name: o.name, icon: o.icon, description: o.description, updated_at: new Date().toISOString() }).eq("id", o.appId);
      if (a.error) throw new Error(`apps 更新失败：${a.error.message}`);
    },
  };
}
