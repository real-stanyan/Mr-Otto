// edge 的地址与令牌（#1356 A5）：账号页、订阅页、用量页都要拿用户的 JWT 打 edge。A1 的 home/billing.ts 与 A4 的
// voiceStore 各写过一份 EDGE_BASE；新代码从这里取，home/billing.ts 改用它（voiceStore 不动——A4 的代码这一片不碰）。
import { edgeBaseUrl } from "../../src/shared/edgeConfig.js";
import { supabase } from "./supabase.js";

// RN 里没有 process.env，edgeBaseUrl 读的那个 env 传空对象即可——走默认生产地址（同 relay.ts）
export const EDGE_BASE = edgeBaseUrl({} as never);

/** 现取 supabase 的 access token（会过期，缓存一份等于把「过期」变成一次静默失败） */
export async function edgeToken(): Promise<string | null> {
  return (await supabase.auth.getSession()).data.session?.access_token ?? null;
}
