// 应用的文件落到本机（#1591 第 1 期 b，plan 小修 1：不打 zip，按文件表逐个下）：
// Paths.document/otto-apps/<appId>/<version>/<path>。下过的不再下（按路径存在判；版本号变了就是新目录）；之后离线可开。
import { Directory, File, Paths } from "expo-file-system";
import type { AppFileEntry } from "../../../src/shared/apps.js";
import { appFileUrls } from "../../../src/shared/appsApi.js";
import { supabase } from "../supabase.js";

export function appVersionDir(appId: string, version: number): Directory {
  return new Directory(Paths.document, "otto-apps", appId, String(version));
}

function ensureDir(d: Directory): void {
  if (!d.exists) d.create({ intermediates: true });
}

/** 把一版的文件都落到本机；回入口目录。缺哪个下哪个；签不出地址 / 下不下来抛 */
export async function ensureAppFiles(uid: string, appId: string, version: number, files: readonly AppFileEntry[]): Promise<Directory> {
  const dir = appVersionDir(appId, version);
  ensureDir(dir);
  const missing = files.filter((f) => !new File(dir, ...f.path.split("/")).exists);
  if (missing.length === 0) return dir;
  const urls = await appFileUrls(supabase, uid, appId, version, missing);
  if (urls === null) throw new Error("应用的文件这会儿下不下来，稍后再试");
  for (let i = 0; i < missing.length; i++) {
    const segs = missing[i]!.path.split("/");
    const parent = segs.length > 1 ? new Directory(dir, ...segs.slice(0, -1)) : dir;
    ensureDir(parent);
    await File.downloadFileAsync(urls[i]!, new File(parent, segs[segs.length - 1]!));
  }
  return dir;
}

export function appFileUri(dirUri: string, path: string): string {
  return `${dirUri.endsWith("/") ? dirUri : `${dirUri}/`}${path}`;
}
