// sessionShareApi —— 会话分享的 Supabase Storage 上传/下载封装（issue #611，PR#2）。
// 这是 main 层「唯一碰 supabase-js storage」的地方，与 supabaseFriendsApi
// 「唯一碰 from()」同一道职责墙：上层（index.ts 装配、bridge）只认这里的
// 纯接口，不认 SupabaseClient。
//
// 做的事就两件：把一组「路径 → 字节」传到 Storage，再按前缀整组拉回来。
// 包的编解码在 shared/sessionPackageCodec（纯逻辑），这里只管搬运。

import type { SupabaseClient } from "@supabase/supabase-js";

export const SESSION_PACKAGE_BUCKET = "session-packages";

/** 把一组「对象键 → 字节」上传到 bucket。upsert: true——同一个 pkg 重发覆盖，
    内容寻址语义不变（事件流不可变，变了就是新 pkg）。
    任一文件失败即抛（带对象键），上层 bridge 归一成 FriendsResult 结构化回流 */
export async function uploadPackageFiles(
  client: SupabaseClient,
  files: ReadonlyMap<string, Uint8Array>
): Promise<void> {
  for (const [key, bytes] of files) {
    const { error } = await client.storage
      .from(SESSION_PACKAGE_BUCKET)
      .upload(key, bytes, { contentType: guessContentType(key), upsert: true });
    if (error) throw new Error(`上传失败 ${key}: ${error.message}`);
  }
}

/** 按前缀整组下载一个包的所有文件。先 list 出该前缀下的对象键，再逐个 download。
    返回「相对包根的路径 → 字节」（剥掉前缀），正好喂给 decodePackage。
    list 为空 = 包不存在（或已被发送方撤回删除）——返回 null 让上层渲染「分享已失效」，
    而不是抛错炸掉 */
export async function downloadPackageFiles(
  client: SupabaseClient,
  prefix: string
): Promise<Map<string, Uint8Array> | null> {
  const bucket = client.storage.from(SESSION_PACKAGE_BUCKET);
  // list 的参数是「目录」，prefix 就是那个目录（uid/pkgId）
  const { data, error } = await bucket.list(prefix, { limit: 1000 });
  if (error) throw new Error(`列出包文件失败 ${prefix}: ${error.message}`);
  if (!data || data.length === 0) return null;

  const files = new Map<string, Uint8Array>();
  for (const obj of data) {
    if (obj.name.endsWith("/")) continue; // 目录占位符，跳过
    const key = `${prefix}/${obj.name}`;
    const { data: blob, error: dlErr } = await bucket.download(key);
    if (dlErr) throw new Error(`下载失败 ${key}: ${dlErr.message}`);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    files.set(obj.name, bytes); // 相对包根的路径
  }
  return files;
}

/** 删除一个包（撤回分享）。删的是前缀下所有文件 */
export async function deletePackage(client: SupabaseClient, prefix: string): Promise<void> {
  const bucket = client.storage.from(SESSION_PACKAGE_BUCKET);
  const { data, error } = await bucket.list(prefix, { limit: 1000 });
  if (error) throw new Error(`列出包文件失败 ${prefix}: ${error.message}`);
  if (!data || data.length === 0) return;
  const keys = data.filter((o) => !o.name.endsWith("/")).map((o) => `${prefix}/${o.name}`);
  if (keys.length === 0) return;
  const { error: rmErr } = await bucket.remove(keys);
  if (rmErr) throw new Error(`删除失败 ${prefix}: ${rmErr.message}`);
}

/** contentType 按文件名猜：附件没有扩展名（内容寻址），用 manifest 台账里的
    mediaType 更准，但这里只给个大概——Storage 不强校验，下载方按字节嗅探 */
function guessContentType(key: string): string {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".jsonl")) return "application/x-ndjson";
  return "application/octet-stream"; // 附件字节
}
