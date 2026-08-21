// MCP hub —— 谁在连、谁连上了、谁挂了。对照 browserHub.ts / terminalHub.ts。
// **不 import SDK**：connect 以接口注入,测试喂假实现,状态机能测干净。

import { maskMcpConfig, type McpServerConfig, type McpServerStatus, type McpStatus } from "../shared/mcp.js";
import { McpAuthRequiredError, type McpClientConn } from "./mcpClient.js";
import type { McpCapability, McpServerHandle } from "../world/executionWorld.js";

export type McpConnect = (id: string, cfg: McpServerConfig) => Promise<McpClientConn>;

export interface McpHub extends McpCapability {
  /** 过桥给渲染层：配置已遮罩 */
  list(): McpServerStatus[];
  save(id: string, cfg: McpServerConfig): Promise<void>;
  remove(id: string): Promise<void>;
  reconnect(id: string): Promise<void>;
  onChange(cb: () => void): () => void;
  closeAll(): Promise<void>;
}

interface Entry {
  cfg: McpServerConfig;
  status: McpStatus;
  error?: string;
  conn?: McpClientConn;
}

export function createMcpHub(opts: {
  load(): { servers: Record<string, McpServerConfig>; errors: string[] };
  save(servers: Record<string, McpServerConfig>): void;
  connect: McpConnect;
}): McpHub {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let readying: Promise<void> | null = null;

  const emit = () => { for (const cb of listeners) cb(); };

  /** 从磁盘同步一次清单：新增的进来，删掉的关连接。已在的保留连接状态 */
  function syncFromDisk(): void {
    const { servers } = opts.load();
    for (const [id, cfg] of Object.entries(servers)) {
      const cur = entries.get(id);
      if (!cur) {
        // 中性起始态，不是 failed —— "还没试过"和"真的连不上"对用户是两件事：
        // 设置页可能在 ready() 之前就调 list()，这时候一律记 failed 会让每台
        // 刚配置好、压根没试过的 server 都亮红灯；enabled: false 的更冤枉，
        // 它会一直停在这个初始态（connectOne 直接跳过它），永远显示"失败"。
        // "connecting" 没有这个歧义：enabled 的会立刻被 ready() 里的 connectOne
        // 接过去转正，disabled 的会一直停在这里但至少不撒谎说它坏了——
        // UI 要区分"关掉的"和"连不上的"，看 config.enabled 就够，不必再借
        // status 这一个字段传两种意思（这正是原先的设计想省但省错了的地方）。
        entries.set(id, { cfg, status: "connecting" });
      } else {
        cur.cfg = cfg;
      }
    }
    for (const id of [...entries.keys()]) {
      if (!(id in servers)) {
        void entries.get(id)?.conn?.close();
        entries.delete(id);
      }
    }
  }

  async function connectOne(id: string): Promise<void> {
    const e = entries.get(id);
    if (!e || !e.cfg.enabled || e.status === "connected") return;
    e.status = "connecting";
    delete e.error;
    emit();
    try {
      const conn = await opts.connect(id, e.cfg);
      // list_changed：server 说清单变了,重拉一次再推 UI。
      // 重拉失败不改状态 —— 连接还活着,只是这次没拉到，吞掉不往外抛。
      // 这层 try/catch 是必须的：mcpClient.ts 的 refresh() 现在对"声明了
      // capability 却拉不到"这种真故障是原样抛的（I3），首次连接时那个抛出
      // 要让 connectOne 的外层 catch 接住、标成 failed；但这里是连接已经
      // 活着之后的重拉，同一个错误不该把一条好端端的连接标死，只是这次
      // 没拉到新清单，旧清单继续用。
      conn.onListChanged(() => {
        void (async () => {
          try {
            await conn.refresh?.();
          } catch {
            // 见上：连接没死，只是这次重拉没成功，保留旧清单
          }
          emit();
        })();
      });
      e.conn = conn;
      e.status = "connected";
    } catch (err) {
      e.status = err instanceof McpAuthRequiredError ? "needs-auth" : "failed";
      e.error = err instanceof Error ? err.message : String(err);
    }
    emit();
  }

  function handleOf(id: string, e: Entry): McpServerHandle {
    const live = e.status === "connected" && !!e.conn;
    return {
      id,
      name: id,
      status: e.status,
      live,
      ...(e.error !== undefined ? { error: e.error } : {}),
      tools: live ? e.conn!.tools : [],
      resources: live ? e.conn!.resources : [],
      prompts: live ? e.conn!.prompts : [],
    };
  }

  function liveConn(id: string): McpClientConn {
    const e = entries.get(id);
    if (!e?.conn || e.status !== "connected") {
      throw new Error(`MCP server「${id}」当前没连上（状态：${e?.status ?? "不存在"}）`);
    }
    return e.conn;
  }

  return {
    async ready() {
      // 并发调只连一次；连完清空,下次 ready() 会重试 failed 的那些
      // ——用户可能刚把 npx 装上,或者刚把网连回来
      if (readying) return readying;
      readying = (async () => {
        syncFromDisk();
        await Promise.all([...entries.keys()].map((id) => connectOne(id)));
      })().finally(() => { readying = null; });
      return readying;
    },

    servers: () => [...entries.entries()].map(([id, e]) => handleOf(id, e)),

    // async 包一层是必须的：liveConn() 找不到活连接时同步抛，不包住的话
    // 调用方拿到的就不是一个 rejected promise，而是一次同步异常——
    // `await expect(hub.callTool(...)).rejects.toThrow(...)` 这类断言会在
    // expect() 还没来得及包住 promise 之前就被同步炸穿。
    callTool: async (id, tool, args, signal) => liveConn(id).callTool(tool, args, signal),
    readResource: async (id, uri, signal) => liveConn(id).readResource(uri, signal),
    getPrompt: async (id, name, args) => liveConn(id).getPrompt(name, args),

    list: () => {
      // 先同步磁盘：设置页会在 ready() 之前就调 list()，
      // 那时候 entries 还是空的 —— 配置过但没连上的 server 也必须显示出来
      syncFromDisk();
      return [...entries.entries()].map(([id, e]) => {
        const h = handleOf(id, e);
        return {
          id,
          status: e.status,
          ...(e.error !== undefined ? { error: e.error } : {}),
          // 凭据永不过桥（同 ADR-0044 的口径）
          config: maskMcpConfig(e.cfg),
          tools: [...h.tools],
          resources: [...h.resources],
          prompts: [...h.prompts],
        };
      });
    },

    async save(id, cfg) {
      syncFromDisk();
      const next = Object.fromEntries([...entries.entries()].map(([k, e]) => [k, e.cfg]));
      next[id] = cfg;
      opts.save(next);
      // 配置变了就断开重连 —— 旧连接用的是旧 env/url,留着只会骗人
      const cur = entries.get(id);
      if (cur?.conn) await cur.conn.close();
      // 同 syncFromDisk 的口径：还没试连不等于连不上，见上面那条注释
      entries.set(id, { cfg, status: "connecting" });
      await connectOne(id);
    },

    async remove(id) {
      syncFromDisk();
      const cur = entries.get(id);
      if (cur?.conn) await cur.conn.close();
      entries.delete(id);
      opts.save(Object.fromEntries([...entries.entries()].map(([k, e]) => [k, e.cfg])));
      emit();
    },

    async reconnect(id) {
      const cur = entries.get(id);
      if (cur?.conn) await cur.conn.close();
      if (cur) { delete cur.conn; cur.status = "failed"; }
      await connectOne(id);
    },

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async closeAll() {
      await Promise.all([...entries.values()].map((e) => e.conn?.close()));
      for (const e of entries.values()) { delete e.conn; e.status = "failed"; }
    },
  };
}
