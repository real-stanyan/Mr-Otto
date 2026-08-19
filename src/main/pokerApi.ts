// 牌桌客户端 —— 主进程这一侧。渲染层不直连网关：access token 不过桥
// （与 walletApi 同一条规矩，AccountInfo 里的 token/session 从来不过 IPC）。
//
// SSE 也在这里收：主进程读流、切行、解析，只把裁剪过的牌局视图推给渲染层。

import { gatewayBaseUrl, parseGatewayError } from "../shared/gatewayConfig.js";
import type { PokerHandView, PokerTableInput, PokerTableSummary } from "../shared/shellBridge.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type GetToken = () => Promise<string | null>;

export interface PokerDeps {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function call(
  getToken: GetToken,
  path: string,
  init: RequestInit,
  deps: PokerDeps
): Promise<unknown> {
  const token = await getToken();
  if (!token) throw new Error("先登录才能上牌桌");
  const base = (deps.baseUrl ?? gatewayBaseUrl()).replace(/\/+$/, "");
  const doFetch = deps.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  const res = await doFetch(`${base}/poker${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${token}`,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const gw = parseGatewayError(text);
    // 网关的报错本来就是给人看的整句中文，包一层"请求失败"只会盖住有用信息
    throw new Error(gw ? gw.message : `牌桌请求失败(${res.status})`);
  }
  return text ? JSON.parse(text) : null;
}

const postInit = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

export async function listTables(getToken: GetToken, deps: PokerDeps = {}): Promise<PokerTableSummary[]> {
  const out = await call(getToken, "", { method: "GET" }, deps);
  if (!isRecord(out) || !Array.isArray(out.tables)) throw new Error("牌桌列表响应不对");
  return out.tables as PokerTableSummary[];
}

export async function createTable(
  getToken: GetToken, input: PokerTableInput, deps: PokerDeps = {}
): Promise<PokerTableSummary> {
  const out = await call(getToken, "", postInit(input), deps);
  if (!isRecord(out) || !isRecord(out.table)) throw new Error("建桌响应不对");
  return out.table as unknown as PokerTableSummary;
}

export async function joinTable(
  getToken: GetToken, tableId: string, amount: number, deps: PokerDeps = {}
): Promise<number> {
  const out = await call(getToken, `/${tableId}/join`, postInit({ amount }), deps);
  if (!isRecord(out) || typeof out.seatIndex !== "number") throw new Error("入座响应不对");
  return out.seatIndex;
}

export async function leaveTable(
  getToken: GetToken, tableId: string, deps: PokerDeps = {}
): Promise<number> {
  const out = await call(getToken, `/${tableId}/leave`, postInit(), deps);
  if (!isRecord(out) || typeof out.taken !== "number") throw new Error("离桌响应不对");
  return out.taken;
}

export async function startHand(getToken: GetToken, tableId: string, deps: PokerDeps = {}): Promise<void> {
  await call(getToken, `/${tableId}/start`, postInit(), deps);
}

export async function sendAction(
  getToken: GetToken, tableId: string, action: unknown, deps: PokerDeps = {}
): Promise<void> {
  await call(getToken, `/${tableId}/action`, postInit({ action }), deps);
}

/**
 * 订阅一张桌的牌局推送。返回退订函数。
 *
 * 同一时刻只订一张桌：换桌先退订再订，免得两条流互相盖着推。
 *
 * 断流自动重连：SSE 会被代理掐（闲置超时）、被睡眠断网切开。服务端在每次
 * 连接建立时都先推一份当前视图，所以重连本身就是自愈 —— 冻结的视图会被
 * 新鲜的覆盖。退避 1s 起步翻倍，封顶 10s；连上一次就归零。
 */
export function watchTable(
  getToken: GetToken,
  tableId: string,
  onHand: (view: PokerHandView | null) => void,
  onError: (err: unknown) => void,
  deps: PokerDeps = {}
): () => void {
  const controller = new AbortController();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });

  void (async () => {
    let backoff = 1000;
    while (!controller.signal.aborted) {
      try {
        const token = await getToken();
        if (!token) throw new Error("先登录才能上牌桌");
        const base = (deps.baseUrl ?? gatewayBaseUrl()).replace(/\/+$/, "");
        const doFetch = deps.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
        const res = await doFetch(`${base}/poker/${tableId}/stream`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`订阅牌桌失败(${res.status})`);
        backoff = 1000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE 以空行分事件；一个事件可能跨多个 chunk 到达，所以留住尾巴
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                onHand(JSON.parse(line.slice(6)) as PokerHandView | null);
              } catch (err) {
                onError(err);
              }
            }
            idx = buffer.indexOf("\n\n");
          }
        }
      } catch (err) {
        // 主动退订触发的 abort 不是错误
        if (!controller.signal.aborted) onError(err);
      }
      if (controller.signal.aborted) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  })();
  return () => controller.abort();
}
