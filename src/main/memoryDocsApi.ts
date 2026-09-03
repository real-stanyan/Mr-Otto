/** 记忆文档 API 接口（#852）。memorySync 与测试通过这个接口调用 Supabase。
    真实实现在 supabaseMemoryDocsApi.ts。 */

export interface MemoryDocRow {
  key: string;
  content: string;
  updated_at: string;
}

export interface MemoryDocsApi {
  listAll(uid: string): Promise<MemoryDocRow[]>;
  upsert(uid: string, key: string, content: string, updatedAtIso: string): Promise<void>;
  remove(uid: string, key: string): Promise<void>;
}
