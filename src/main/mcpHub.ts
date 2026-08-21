// MCP hub —— 谁在连、谁连上了、谁挂了。对照 browserHub.ts / terminalHub.ts。
// **不 import SDK**：connect 以接口注入,测试喂假实现,状态机能测干净。

import { maskMcpConfig, type McpServerConfig, type McpServerStatus, type McpStatus } from "../shared/mcp.js";
import { maskKey } from "../shared/keyMask.js";
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
  /** 上一次读 ~/.otter/mcp.json 时,解析不动的那几行的人话原因(mcpConfig.ts
      的 parseMcpConfig 早就结构化产出了这份清单,但过去没人把它接到桥上——
      一台配置坏了不该拖垮别的 server,但也不该连错在哪都不告诉用户)。
      每次 syncFromDisk()(被 list()/save()/remove() 间接触发)都会刷新它 */
  configErrors(): string[];
}

interface Entry {
  cfg: McpServerConfig;
  status: McpStatus;
  error?: string;
  conn?: McpClientConn;
}

/** ready() 单次调用的等待上限。SDK 的 client.connect() 没设超时,兜底是它自己
    DEFAULT_REQUEST_TIMEOUT_MSEC 的 60s——那个数字是给"一次请求"用的,不是给
    "装配一个会话"用的:startSession/resumeSession 在 await 这个函数,人在
    界面另一头等着看到第一条消息。10s 选在"一次正常的 stdio 握手/http 请求
    绰绰有余"和"用户能忍受的启动等待"之间——npx 包已缓存时握手通常是几十到
    几百毫秒,这个数字是给"服务器挂了/网不通"这类真故障兜底,不是给正常路径
    预留的。超时不等于失败:见 ready() 内部注释,没连完的那几台继续在后台跑,
    只是这一次装配等不到它们的工具了(consequence 见 agent.ts 顶部注释)。 */
const READY_TIMEOUT_MS = 10_000;

/** 遮罩往返合并：设置页的表单是拿 list() 给的遮罩值预填的,用户没碰某个
    env/headers 字段时,交回来的 save() 请求里那个字段还是那串 `sk-xxx*****xxx`。
    原样存下就是拿星号覆盖真凭据——list() 的遮罩越认真,这个洞就越致命
    （测试见 mcpHub.test.ts "save() 合并遮罩值"）。
    判定法：对每个键单独比较——如果 incoming 的值恰好等于「磁盘上这个键的
    当前值」经 maskKey 之后的样子,说明用户没碰它,原样保留磁盘上的真值;
    否则采信 incoming（用户真改了,或者这是一把新键）。
    kind 变了（stdio ↔ http）没有旧值可比,直接采信 incoming——新建同理。 */
function mergeMaskedCreds(stored: McpServerConfig | undefined, incoming: McpServerConfig): McpServerConfig {
  if (!stored || stored.kind !== incoming.kind) return incoming;
  const merge = (inc: Record<string, string>, old: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(inc).map(([k, v]) => {
        const oldValue = old[k];
        return [k, oldValue !== undefined && v === maskKey(oldValue) ? oldValue : v];
      })
    );
  if (incoming.kind === "stdio" && stored.kind === "stdio") {
    return { ...incoming, env: merge(incoming.env, stored.env) };
  }
  if (incoming.kind === "http" && stored.kind === "http") {
    return { ...incoming, headers: merge(incoming.headers, stored.headers) };
  }
  return incoming;
}

export function createMcpHub(opts: {
  load(): { servers: Record<string, McpServerConfig>; errors: string[] };
  save(servers: Record<string, McpServerConfig>): void;
  connect: McpConnect;
}): McpHub {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let readying: Promise<void> | null = null;
  // 解析阶段的人话错误(见 McpHub.configErrors 的接口注释),每次 syncFromDisk 刷新
  let parseErrors: string[] = [];

  const emit = () => { for (const cb of listeners) cb(); };

  /** 从磁盘同步一次清单：新增的进来，删掉的关连接。已在的保留连接状态 */
  function syncFromDisk(): void {
    const { servers, errors } = opts.load();
    parseErrors = errors;
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
      // ——用户可能刚把 npx 装上,或者刚把网连回来。
      // readying 挂的是"真正在跑的那份工作",不是"这次调用愿意等多久"——
      // 两者拆开是这个函数不撞车的关键：下面的超时只影响这次调用返回得多快,
      // 不影响 readying 本身；超时之后 readying 还留着，其余没连完的
      // connectOne 继续在后台跑到底、跑完了正常 emit()。要是让超时把
      // readying 提前置 null，下一次 ready() 调用会对同一台还在连接中的
      // server 重新发起一次 opts.connect()——同一个 id 并发连两次，
      // stdio 场景就是两个孤儿子进程。
      if (!readying) {
        readying = (async () => {
          syncFromDisk();
          await Promise.all([...entries.keys()].map((id) => connectOne(id)));
        })().finally(() => { readying = null; });
      }
      // 超时不是失败：没连完的那几台留在 connecting，装配这次会话时它们
      // 就是没有工具（挂载一次定终身，见 agent.ts 顶部注释里的 consequence），
      // 但状态机本身没有被撕裂——它们迟早会自己 emit() 收尾。
      await Promise.race([
        readying,
        new Promise<void>((resolve) => { setTimeout(resolve, READY_TIMEOUT_MS); }),
      ]);
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
      // 表单可能是拿 list() 的遮罩值预填的,原样合并回真值——不然一次没碰
      // 凭据字段的保存就会拿星号覆盖真 key（review finding 3，见上方
      // mergeMaskedCreds 的注释和 mcpHub.test.ts 里那条同名测试）
      const merged = mergeMaskedCreds(entries.get(id)?.cfg, cfg);
      const next = Object.fromEntries([...entries.entries()].map(([k, e]) => [k, e.cfg]));
      next[id] = merged;
      opts.save(next);
      // 配置变了就断开重连 —— 旧连接用的是旧 env/url,留着只会骗人
      const cur = entries.get(id);
      if (cur?.conn) await cur.conn.close();
      // 同 syncFromDisk 的口径：还没试连不等于连不上，见上面那条注释
      entries.set(id, { cfg: merged, status: "connecting" });
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

    configErrors: () => parseErrors,

    async closeAll() {
      // kill() 先跑,且是这个 async 函数体里第一段同步代码——调用方不需要
      // await 返回的 promise，kill() 的每一次 process.kill(pid, SIGKILL) 早在
      // closeAll() 这次调用返回给调用方之前就已经发出去了（同步函数体在
      // 遇到第一个 await 之前是整段跑完的，这里第一个 await 在下面那行）。
      // before-quit 就是靠这个：Electron 不会等这个函数的 promise settle，
      // 但杀信号已经真的发出去了，不依赖 SDK close() 里那两个 2s 定时器
      // （before-quit 一返回、进程就退出，定时器永远没机会触发，见 review
      // finding 1 / mcpClient.ts 的 kill() 接口注释）。
      for (const e of entries.values()) e.conn?.kill();
      // close() 仍然跑一遍：协议层优雅关闭是尽力而为,跑不完也无所谓——
      // 子进程已经被上面的 kill() 保证会死,这里只是走个协议礼貌,失败不重要
      await Promise.all([...entries.values()].map((e) => e.conn?.close().catch(() => {})));
      for (const e of entries.values()) { delete e.conn; e.status = "failed"; }
    },
  };
}
