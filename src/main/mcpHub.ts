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
  /** 跑一次 OAuth 授权（开浏览器、等回调、换 token 落盘），成功后自动重连。
      失败原样抛给调用方：设置页要把原因显示出来，agent 要把原因转述给用户。
      只对 http 传输有意义——stdio 的凭据走 env，调到会拿到一句人话 */
  authorize(id: string): Promise<void>;
  onChange(cb: () => void): () => void;
  closeAll(): Promise<void>;
  /** 上一次读 ~/.mr-otto/mcp.json 时,解析不动的那几行的人话原因(mcpConfig.ts
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
    kind 变了（stdio ↔ http）没有旧值可比,直接采信 incoming——新建同理。

    第二道闸（review D1/D2）：渲染层三轮补丁分别堵上了"同一台 server 内改名
    漏值"（N1）、"改名又改回来"（M1）这两条路，但渲染层的判据结构性地只能
    看见它自己手上那份 baseline——看不见"另一台 server 的遮罩被粘过来了"
    （D1：设置页里几台 server 的 <details> 能同时展开，遮罩在值输入框里是
    普普通通、可以选中复制的明文，把 A 的遮罩粘进 B 的字段是操作上顺理成章
    的一步）、也看不见"这一行展开期间磁盘被外部改过"（D2：baseline 是活的
    prop,但 envRows/headerRows 只在挂载和存完之后才重新取样，外部改动落地
    的那一刻,行里握着的还是旧遮罩）。这两个洞都不是"渲染层漏做了什么",
    是渲染层能看见的信息本来就不够——它只有一份 baseline,不知道全局磁盘
    现状,也不知道别的 server 长什么样。真正同时看得见"整份磁盘现状 + 这一次
    incoming 到底改的是哪台"的只有这里，所以第二道闸必须长在这一层，
    不是又一次渲染层补丁。

    判据（v 已经不是 k 自己的遮罩,即上面 merge 判过"没碰过"这条之后的分支）：
    stored[k] !== undefined（有真值在磁盘上,真凭据确实处在风险里——新键/
    新 server 没有旧值可覆盖,不该被这道闸拦住）且 v !== ""（清空是正常操作,
    见 mcpForm.ts hasStrayMaskedValue 同款的空值豁免）且 maskKey(v) === v
    （v 长得像"遮罩形状"——这是可判定的：maskKey 在全部三段长度分支上都是
    幂等的，maskKey(maskKey(s)) === maskKey(s) 恒成立，逐段验证见
    mcpHub.test.ts。v 如果是用户真敲的一把新凭据，几乎不可能恰好落在
    maskKey 的不动点上；如果恰好等于 maskKey(v)，唯一自洽的解释就是它本来
    就是某处的遮罩——可能是这台 server 自己的旧遮罩（D2）、也可能是另一台
    server 的（D1）——总之不是这个键此刻该收下的真凭据）。
    命中就拒存，抛错——宁可错杀也不可放过：静默覆盖成星号且日后无法察觉，
    远比"这次保存被拒、用户看到一条能读懂的报错、重新填一遍"更糟。
    失败方向要诚实：一把恰好长得像 `XXXXXXXX*****YYYY` 这种形状的真实凭据
    （概率极低，但结构上不是不可能）会被这道闸误伤，存不进去——这是刻意的
    取舍，不是需要"修"的 bug,下一个读到这里的人不必为它去关掉这项检查。 */
function mergeMaskedCreds(stored: McpServerConfig | undefined, incoming: McpServerConfig): McpServerConfig {
  if (!stored || stored.kind !== incoming.kind) return incoming;
  const merge = (inc: Record<string, string>, old: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(inc).map(([k, v]) => {
        const oldValue = old[k];
        if (oldValue !== undefined && v === maskKey(oldValue)) return [k, oldValue];
        if (oldValue !== undefined && v !== "" && maskKey(v) === v) {
          throw new Error(
            `「${k}」提交的值看起来是遮罩字符串（可能贴自另一台 server，或者这一格` +
            `展开期间磁盘上的凭据已经被改过），不像是真凭据——为安全起见拒绝这次保存，请重新填一遍真值`
          );
        }
        return [k, v];
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
  load(): {
    servers: Record<string, McpServerConfig>;
    errors: string[];
    unrecognizedIds: string[];
    /** 整份 JSON 解析不动（mcpConfig.parseMcpConfig 同名字段）。
        true 时 servers 的空不代表"没有 server"，只代表"这次没读出来" */
    fatal: boolean;
  };
  /** unrecognizedIds：上一次 load() 里解析不动、但同伴健康的那些 id
      （mcpConfig.ts parseMcpConfig 的同名字段）——原样转给 saveMcpConfig，
      让它们的原始节点在写回时不被冲掉（F1 half 1，见 mcpConfig.ts 顶部
      serializeMcpConfig 的注释）。可能抛：prevText 本身解析不动时
      （F1 half 2），不接住，让调用方（save()/remove()）原样把这次保存
      失败的错误抛给上层，一路穿透到 IPC 和设置页 */
  save(servers: Record<string, McpServerConfig>, unrecognizedIds: readonly string[]): void;
  connect: McpConnect;
  /** 跑一次完整 OAuth 授权。真实现是 mcpClient.authorizeMcpServer（它才认识
      SDK），hub 只管什么时候调、调完做什么——同 connect 的注入方向，
      hub 因此完全不碰 SDK，状态机能用假实现测干净 */
  authorize(id: string, cfg: McpServerConfig): Promise<void>;
  /** 抹掉一台 server 的 OAuth 凭据。remove() 时调 —— 配置删了而凭据留着，
      就是一份没有任何界面能看到、也没人会想起来撤销的长期授权 */
  clearAuth(id: string): void;
}): McpHub {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let readying: Promise<void> | null = null;
  // 解析阶段的人话错误(见 McpHub.configErrors 的接口注释),每次 syncFromDisk 刷新
  let parseErrors: string[] = [];
  // 同一次 load() 里解析不动的 id 清单，写回时要原样保护（见上方 save 的接口注释）
  let unrecognizedIds: string[] = [];

  const emit = () => { for (const cb of listeners) cb(); };

  /** 从磁盘同步一次清单：新增的进来，删掉的关连接。已在的保留连接状态 */
  function syncFromDisk(): void {
    const { servers, errors, unrecognizedIds: unrec, fatal } = opts.load();
    parseErrors = errors;
    if (fatal) {
      // 整份文件读不出来（外部编辑器把 JSON 改坏了、写到一半、磁盘出错）。
      // 此时 servers 是空的，但那是"这次没读出来"，不是"用户把 server 都删了"——
      // 照常往下走会把活着的连接一条条关掉、从内存里忘掉，而用户什么提示都
      // 看不到（issue #159）。内存里那份是上一次读成功的结果，它比"空"诚实得多，
      // 原样留着继续用。
      //
      // unrecognizedIds 也刻意不动：这一轮我们连一个 id 都取不出来，
      // 清空它等于把上一次好不容易记住的"要保护的原始节点"忘掉。
      // 真要写盘时另有一道闸（serializeMcpConfig 对 prevText 解析不动直接拒写），
      // 那条错误会原样穿到设置页——用户在那时候会被明确告知文件坏了。
      return;
    }
    unrecognizedIds = unrec;
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

  async function reconnectOne(id: string): Promise<void> {
    const cur = entries.get(id);
    if (cur?.conn) await cur.conn.close();
    // 状态先推成 failed 再连：connectOne 对 status === "connected" 的直接返回，
    // 不推的话"重连一台已经连上的"会变成空操作
    if (cur) { delete cur.conn; cur.status = "failed"; }
    await connectOne(id);
  }

  async function saveOne(id: string, cfg: McpServerConfig): Promise<void> {
    syncFromDisk();
    // 表单可能是拿 list() 的遮罩值预填的,原样合并回真值——不然一次没碰
    // 凭据字段的保存就会拿星号覆盖真 key（review finding 3，见上方
    // mergeMaskedCreds 的注释和 mcpHub.test.ts 里那条同名测试）
    const merged = mergeMaskedCreds(entries.get(id)?.cfg, cfg);
    const next = Object.fromEntries([...entries.entries()].map(([k, e]) => [k, e.cfg]));
    next[id] = merged;
    // 磁盘写在前、内存状态变更在后——opts.save 抛（F1 half 2：prevText
    // 解析不动）时，不能让下面的 close()/entries.set() 抢跑：写都没写成,
    // 内存不该假装这次保存已经生效
    opts.save(next, unrecognizedIds);
    // 配置变了就断开重连 —— 旧连接用的是旧 env/url,留着只会骗人
    const cur = entries.get(id);
    if (cur?.conn) await cur.conn.close();
    // 同 syncFromDisk 的口径：还没试连不等于连不上，见上面那条注释
    entries.set(id, { cfg: merged, status: "connecting" });
    await connectOne(id);
  }

  async function removeOne(id: string): Promise<void> {
    syncFromDisk();
    const remaining = Object.fromEntries(
      [...entries.entries()].filter(([k]) => k !== id).map(([k, e]) => [k, e.cfg])
    );
    // 同 save()：写在前、关连接/删内存记录在后——opts.save 抛的话
    // （F1 half 2）这台 server 的连接和内存记录都原样留着，不因为一次
    // 没写成的删除就先斩后奏关掉一条还活着的连接。同时把 unrecognizedIds
    // 原样带上：删除一台健康 server 不该连带冲掉磁盘上解析不动的 broken
    // sibling（F1 half 1 在 remove() 路径上的同款问题，见上面 save 的注释）
    opts.save(remaining, unrecognizedIds);
    const cur = entries.get(id);
    if (cur?.conn) await cur.conn.close();
    entries.delete(id);
    // 配置没了，凭据也不该留 —— 见 opts.clearAuth 的注释
    opts.clearAuth(id);
    emit();
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

    save: saveOne,

    remove: removeOne,

    reconnect: reconnectOne,

    async configure(id, cfg) {
      // 复用 save/remove 的全部既有语义（遮罩合并、写在前状态变更在后、
      // unrecognizedIds 保护、删除时清 OAuth 凭据）——agent 这条路不该
      // 有一套"简化版"的写盘逻辑，那必然与设置页那条 drift
      if (cfg === null) await removeOne(id);
      else await saveOne(id, cfg);
    },

    configOf: (id) => {
      syncFromDisk();
      return entries.get(id)?.cfg;
    },

    async authorize(id) {
      syncFromDisk();
      const e = entries.get(id);
      if (!e) throw new Error(`没有名叫「${id}」的 MCP server，无法授权`);
      // 授权失败原样抛：状态停在 needs-auth 是诚实的——用户点了拒绝、
      // 或者超时没点，这台确实还是"需要授权"，不该被改成 failed（那会
      // 让设置页把"你还没授权"显示成"这台坏了"）
      await opts.authorize(id, e.cfg);
      await reconnectOne(id);
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
