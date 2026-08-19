// 牌桌的 HTTP 面。所有路由都在 /v1/poker 下，身份一律来自 Supabase JWT ——
// 客户端说自己是谁不算数。
//
// 发给客户端的每一份牌局数据都过 Tables.view()（按人裁剪），
// 这个文件里不允许出现第二条通往 HandState 的路。

import type { Action } from "./poker/betting.js";
import type { PokerStore } from "./pokerStore.js";
import type { Rest } from "./supabaseRpc.js";
import type { SeatRow, TableInfo, Tables } from "./tables.js";

export interface PokerApiDeps {
  tables: Tables;
  store: PokerStore;
  rest: Rest;
  /** 注入幂等键，测试要能钉死 */
  newId?: () => string;
  onError?: (where: string, err: unknown) => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const apiError = (status: number, message: string, code: string): Response =>
  json(status, { error: { message, type: "otto_poker", code } });

function num(v: unknown, fallback = NaN): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** DB 行 → TableInfo。列名是 snake_case，进程内一律 camelCase */
export function toTableInfo(row: Record<string, unknown>): TableInfo {
  return {
    id: String(row["id"]),
    tier: String(row["tier"]),
    smallBlind: num(row["small_blind"]),
    bigBlind: num(row["big_blind"]),
    minBuyin: num(row["min_buyin"]),
    maxBuyin: num(row["max_buyin"]),
    maxSeats: num(row["max_seats"]),
  };
}

export function toSeatRow(row: Record<string, unknown>): SeatRow {
  return {
    userId: String(row["user_id"]),
    seatIndex: num(row["seat_index"], 0),
    stack: num(row["stack_tokens"], 0),
  };
}

/** 客户端传来的动作要重验一遍形状 —— 引擎只认这四种，别的一律不进门 */
export function parseAction(raw: unknown): Action | null {
  if (!isRecord(raw)) return null;
  const t = raw["type"];
  if (t === "fold" || t === "check" || t === "call") return { type: t };
  if (t === "raise") {
    const to = raw["to"];
    if (typeof to !== "number" || !Number.isInteger(to)) return null;
    return { type: "raise", to };
  }
  return null;
}

export function createPokerApi(deps: PokerApiDeps) {
  const { tables, store, rest } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const onError = deps.onError ?? (() => {});

  /** 每张桌的 SSE 订阅者。一人可以开多个窗口，所以是数组不是 map */
  const subs = new Map<string, { userId: string; send: (v: unknown) => void }[]>();

  function push(tableId: string): void {
    for (const sub of subs.get(tableId) ?? []) {
      // 各推各的：同一手牌，每个人看到的不是同一份数据
      sub.send(tables.view(tableId, sub.userId));
    }
  }

  async function myFriends(userId: string): Promise<Set<string>> {
    const rows = await rest.select(
      `friendships?status=eq.accepted&or=(requester.eq.${userId},addressee.eq.${userId})&select=requester,addressee`
    );
    const out = new Set<string>();
    for (const r of rows) {
      if (!isRecord(r)) continue;
      const a = String(r["requester"]);
      const b = String(r["addressee"]);
      out.add(a === userId ? b : a);
    }
    return out;
  }

  async function listTables(userId: string): Promise<Response> {
    const rows = await rest.select("poker_tables?closed_at=is.null&select=*");
    const seatRows = await rest.select(`poker_stacks?user_id=eq.${userId}&select=table_id`);
    const seated = new Set(seatRows.filter(isRecord).map((r) => String(r["table_id"])));
    // 每桌有筹码的在座人数 —— 等桌页拿它画"X/Y 在座"并判断够不够开牌
    const allSeats = await rest.select("poker_stacks?stack_tokens=gt.0&select=table_id");
    const players = new Map<string, number>();
    for (const r of allSeats.filter(isRecord)) {
      const t = String(r["table_id"]);
      players.set(t, (players.get(t) ?? 0) + 1);
    }
    const friends = await myFriends(userId);
    // service_role 绕过 RLS，所以可见性得在这里自己判 —— 与 0005 的 policy 同一套规则
    const visible = rows.filter(isRecord).filter((r) => {
      const owner = String(r["created_by"]);
      return owner === userId || seated.has(String(r["id"])) || friends.has(owner);
    });
    return json(200, {
      tables: visible.map((r) => ({
        ...toTableInfo(r),
        name: String(r["name"] ?? ""),
        seated: seated.has(String(r["id"])),
        live: tables.hasLiveHand(String(r["id"])),
        players: players.get(String(r["id"])) ?? 0,
      })),
    });
  }

  async function createTable(userId: string, body: unknown): Promise<Response> {
    if (!isRecord(body)) return apiError(400, "请求体要是 JSON 对象", "bad_body");
    const bigBlind = num(body["bigBlind"], 50);
    const row = await rest.insert("poker_tables", {
      name: String(body["name"] ?? ""),
      // 档位定死在建桌这一刻：桌上所有人押的都是这个桶（ADR-0022 决定一）
      tier: body["tier"] === "pro" ? "pro" : "flash",
      small_blind: num(body["smallBlind"], Math.max(1, Math.floor(bigBlind / 2))),
      big_blind: bigBlind,
      min_buyin: num(body["minBuyin"], bigBlind * 20),
      max_buyin: num(body["maxBuyin"], bigBlind * 100),
      max_seats: num(body["maxSeats"], 6),
      created_by: userId,
    });
    return json(200, { table: { ...toTableInfo(row), name: String(row["name"] ?? "") } });
  }

  async function join(userId: string, tableId: string, body: unknown): Promise<Response> {
    const amount = isRecord(body) ? num(body["amount"]) : NaN;
    if (!Number.isInteger(amount) || amount <= 0) {
      return apiError(400, "买入额要是正整数", "bad_amount");
    }
    if (tables.hasLiveHand(tableId)) {
      return apiError(409, "这手牌打完再坐下", "hand_in_progress");
    }
    const seat = await store.join({ userId, tableId, amount, requestId: `join:${newId()}` });
    push(tableId);
    return json(200, { seatIndex: seat });
  }

  async function leave(userId: string, tableId: string): Promise<Response> {
    // 牌局进行中不许带钱走人 —— 那等于把已下的注抽回去
    if (tables.hasLiveHand(tableId)) {
      return apiError(409, "这手牌打完才能离桌", "hand_in_progress");
    }
    const taken = await store.leave({ userId, tableId, requestId: `leave:${newId()}` });
    push(tableId);
    return json(200, { taken });
  }

  async function start(tableId: string): Promise<Response> {
    await tables.startHand(tableId);
    return json(200, { ok: true });
  }

  async function act(userId: string, tableId: string, body: unknown): Promise<Response> {
    const action = parseAction(isRecord(body) ? body["action"] : null);
    if (!action) return apiError(400, "看不懂这个动作", "bad_action");
    await tables.act(tableId, userId, action);
    return json(200, { ok: true });
  }

  /** SSE：连上先推一份当前视图，之后每次状态变化推一份 */
  function stream(userId: string, tableId: string): Response {
    let entry: { userId: string; send: (v: unknown) => void };
    // 心跳：没人行动时流上没有任何字节，nginx 的 proxy_read_timeout(600s) 会把
    // 连接当死链掐掉，客户端视图从此冻结。25s 一行 SSE 注释让代理知道流还活着。
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (v: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(v)}\n\n`));
          } catch (err) {
            onError("poker.sse", err);
          }
        };
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: hb\n\n`));
          } catch {
            // 客户端已断，cancel 马上会来清场
          }
        }, 25_000);
        entry = { userId, send };
        subs.set(tableId, [...(subs.get(tableId) ?? []), entry]);
        send(tables.view(tableId, userId));
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        const list = (subs.get(tableId) ?? []).filter((s) => s !== entry);
        if (list.length) subs.set(tableId, list);
        else subs.delete(tableId);
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /** Tables 的 onChange 接到这里 */
  const notify = (tableId: string): void => push(tableId);

  async function handle(userId: string, req: Request, path: string): Promise<Response> {
    // path 形如 "" | "abc" | "abc/join"
    const [tableId, verb] = path.split("/");
    const method = req.method.toUpperCase();
    let body: unknown = null;
    if (method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = null;
      }
    }

    try {
      if (!tableId) {
        if (method === "GET") return await listTables(userId);
        if (method === "POST") return await createTable(userId, body);
        return apiError(405, "方法不对", "bad_method");
      }
      if (!verb && method === "GET") {
        return json(200, { hand: tables.view(tableId, userId) });
      }
      if (method !== "POST" && verb !== "stream") return apiError(405, "方法不对", "bad_method");
      switch (verb) {
        case "join": return await join(userId, tableId, body);
        case "leave": return await leave(userId, tableId);
        case "start": return await start(tableId);
        case "action": return await act(userId, tableId, body);
        case "stream": return stream(userId, tableId);
        default: return apiError(404, `没有这个端点：${path}`, "not_found");
      }
    } catch (err) {
      onError(`poker.${path}`, err);
      // 引擎和 DB 的报错都是给人看的整句中文，原样抬上去比包一层"内部错误"有用
      return apiError(400, err instanceof Error ? err.message : String(err), "poker_error");
    }
  }

  return { handle, notify };
}
