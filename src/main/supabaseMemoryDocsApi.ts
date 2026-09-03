/** MemoryDocsApi 的真 supabase 实现（薄到无逻辑，错误原样上抛；
    收敛在 memorySync 里）。同 supabaseUserProfileApi.ts 的纪律。 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MemoryDocRow, MemoryDocsApi } from "./memoryDocsApi.js";

function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export function createSupabaseMemoryDocsApi(client: SupabaseClient): MemoryDocsApi {
  return {
    async listAll(uid) {
      const res = await client.from("memory_docs").select("key,content,updated_at").eq("uid", uid);
      return (unwrap(res) ?? []) as MemoryDocRow[];
    },

    async upsert(uid, key, content, updatedAtIso) {
      unwrap(await client.from("memory_docs").upsert({ uid, key, content, updated_at: updatedAtIso }));
    },

    async remove(uid, key) {
      unwrap(await client.from("memory_docs").delete().eq("uid", uid).eq("key", key));
    },
  };
}
