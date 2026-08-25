// Supabase PostgREST 的 rpc 调用底座。
//
// 抽出来是因为鉴权头散在各个调用点上迟早会漂 —— service_role key
// 绕过 RLS，拿到它等于拿到所有人的钱包，这不是能容忍漂移的地方。

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RpcOptions {
  /** Supabase 根地址，例如 https://kpeemypbhkynapkjzewr.supabase.co */
  url: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
}

export type Rpc = (name: string, body: Record<string, unknown>) => Promise<unknown>;

export function createRpc(opts: RpcOptions): Rpc {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.url.replace(/\/+$/, "");
  return async (name, body) => {
    const res = await doFetch(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: opts.serviceRoleKey,
        authorization: `Bearer ${opts.serviceRoleKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${name} 失败(${res.status})：${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
}

export function asNumber(value: unknown, rpc: string): number {
  // rpc 返回标量 bigint 时 PostgREST 给的是裸数字；数字过大时给字符串
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`${rpc} 返回了非数字：${JSON.stringify(value)}`);
}
