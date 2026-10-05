// appsApi —— Otto 应用在客户端这一侧的 IO（#1591 第 1 期 b）：拉我的应用、拉一版的清单与文件表、文件的签名下载地址、
// 应用自己的数据格子（app_data）。判据在 apps.ts（appRowOf / appVersionRowOf / safeRelPath），这里只管 IO。
// 同 tasksApi 的纪律：读不到回 null（读不到 ≠ 没有）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_BUCKET, appObjectPath, appRowOf, appVersionRowOf, safeRelPath, type AppFileEntry, type AppRow, type AppVersionRow } from "./apps.js";

export async function fetchApps(client: SupabaseClient): Promise<AppRow[] | null> {
  try {
    const res = await client.from("apps").select("*").order("updated_at", { ascending: false }).limit(200);
    if (res.error) return null;
    const out: AppRow[] = [];
    for (const raw of (res.data ?? []) as unknown[]) {
      const r = appRowOf(raw);
      if (r !== null) out.push(r);
    }
    return out;
  } catch {
    return null;
  }
}

export async function fetchAppVersion(client: SupabaseClient, appId: string, version: number): Promise<AppVersionRow | null> {
  try {
    const res = await client.from("app_versions").select("*").eq("app_id", appId).eq("version", version).maybeSingle();
    if (res.error || res.data === null) return null;
    return appVersionRowOf(res.data);
  } catch {
    return null;
  }
}

/** 文件表 → 签名下载地址（桶私有，本人只读；一次签一批）。顺序与 files 一致；签不出来回 null */
export async function appFileUrls(client: SupabaseClient, uid: string, appId: string, version: number, files: readonly AppFileEntry[], ttlSec = 600): Promise<string[] | null> {
  if (files.length === 0) return [];
  const paths = files.map((f) => appObjectPath(uid, appId, version, f.path));
  const { data, error } = await client.storage.from(APP_BUCKET).createSignedUrls(paths, ttlSec);
  if (error || !data) return null;
  const byPath = new Map<string, string>();
  for (const d of data) if (d.signedUrl && d.path) byPath.set(d.path, d.signedUrl);
  const out: string[] = [];
  for (const p of paths) {
    const u = byPath.get(p);
    if (u === undefined) return null;
    out.push(u);
  }
  return out;
}

export const APP_DATA_KEY_MAX = 200;
const keyOk = (k: unknown): k is string => typeof k === "string" && k.length >= 1 && k.length <= APP_DATA_KEY_MAX;

/** 应用的数据格子（spec §3.2 storage）：(app_id, uid, key) → value。抛错 = 没读到 / 没写进去（桥把那句话回给应用） */
export const appData = {
  async get(client: SupabaseClient, appId: string, uid: string, key: unknown): Promise<unknown> {
    if (!keyOk(key)) throw new Error("key 要是 1–200 字的字符串");
    const res = await client.from("app_data").select("value").eq("app_id", appId).eq("uid", uid).eq("key", key).maybeSingle();
    if (res.error) throw new Error(res.error.message);
    return res.data === null ? null : (res.data as { value: unknown }).value;
  },
  async set(client: SupabaseClient, appId: string, uid: string, key: unknown, value: unknown): Promise<void> {
    if (!keyOk(key)) throw new Error("key 要是 1–200 字的字符串");
    if (value === undefined) throw new Error("value 不能是 undefined（要删用 remove）");
    const res = await client.from("app_data").upsert({ app_id: appId, uid, key, value, updated_at: new Date().toISOString() }, { onConflict: "app_id,uid,key" });
    if (res.error) throw new Error(res.error.message);
  },
  async list(client: SupabaseClient, appId: string, uid: string, prefix: unknown): Promise<{ key: string; value: unknown }[]> {
    const p = typeof prefix === "string" ? prefix : "";
    let q = client.from("app_data").select("key,value").eq("app_id", appId).eq("uid", uid).order("key").limit(500);
    if (p !== "") q = q.like("key", `${p.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
    const res = await q;
    if (res.error) throw new Error(res.error.message);
    return ((res.data ?? []) as { key: string; value: unknown }[]).map((r) => ({ key: r.key, value: r.value }));
  },
  async remove(client: SupabaseClient, appId: string, uid: string, key: unknown): Promise<void> {
    if (!keyOk(key)) throw new Error("key 要是 1–200 字的字符串");
    const res = await client.from("app_data").delete().eq("app_id", appId).eq("uid", uid).eq("key", key);
    if (res.error) throw new Error(res.error.message);
  },
};

/** 多页导航：目标页要在文件表里、要是 .html */
export function appPageOk(files: readonly AppFileEntry[], page: unknown): page is string {
  return typeof page === "string" && safeRelPath(page) && page.endsWith(".html") && files.some((f) => f.path === page);
}
