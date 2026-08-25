// Supabase PostgREST 的 rpc 调用底座。
//
// 抽出来是因为鉴权头一旦在两处各写一遍，迟早只改一处 —— service_role key
// 绕过 RLS，拿到它等于拿到所有人的钱包和牌桌，这不是能容忍漂移的地方。

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RpcOptions {
  /** Supabase 根地址，例如 https://otto-auth.stan.damianslife.com */
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

/** PostgREST 的表读写。rpc 走函数，这里走表 —— 两者共用同一套鉴权头 */
export interface Rest {
  select(path: string): Promise<unknown[]>;
  insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** PATCH。path 自带过滤（如 `poker_tables?id=eq.X`）——无过滤的整表 UPDATE 不该存在 */
  update(path: string, patch: Record<string, unknown>): Promise<void>;
}

export function createRest(opts: RpcOptions): Rest {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.url.replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    apikey: opts.serviceRoleKey,
    authorization: `Bearer ${opts.serviceRoleKey}`,
  };
  async function call(path: string, init: RequestInit): Promise<unknown> {
    const res = await doFetch(`${base}/rest/v1/${path}`, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} 失败(${res.status})：${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    async select(path) {
      const out = await call(path, { method: "GET", headers });
      if (!Array.isArray(out)) throw new Error(`${path} 没返回数组`);
      return out;
    },
    async insert(table, row) {
      const out = await call(table, {
        method: "POST",
        headers: { ...headers, prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      const first = Array.isArray(out) ? out[0] : out;
      if (!first || typeof first !== "object") throw new Error(`${table} 插入没回行`);
      return first as Record<string, unknown>;
    },
    async update(path, patch) {
      if (!path.includes("?")) throw new Error(`update 必须带过滤条件：${path}`);
      await call(path, { method: "PATCH", headers, body: JSON.stringify(patch) });
    },
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

export function asBoolean(value: unknown, rpc: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${rpc} 返回了非布尔：${JSON.stringify(value)}`);
}
