import { describe, it, expect, vi } from "vitest";
import { createMcpHub, type McpConnect } from "../../src/main/mcpHub.js";
import { loadMcpConfig, saveMcpConfig, type McpConfigReader } from "../../src/main/mcpConfig.js";
import { McpAuthRequiredError, type McpClientConn } from "../../src/main/mcpClient.js";
import { maskKey } from "../../src/shared/keyMask.js";
import type { McpServerConfig } from "../../src/shared/mcp.js";

const stdio = (command = "npx"): McpServerConfig => ({
  kind: "stdio", command, args: [], env: {}, enabled: true,
});

const http = (url = "https://mcp.example.com/mcp"): McpServerConfig => ({
  kind: "http", url, headers: {}, enabled: true,
});

function conn(over: Partial<McpClientConn> = {}): McpClientConn {
  return {
    tools: [{ name: "t1", description: "一把刀", inputSchema: {} }],
    resources: [],
    prompts: [],
    callTool: async () => [{ kind: "text", text: "ok" }],
    readResource: async () => [{ kind: "text", text: "料" }],
    getPrompt: async () => "提示词",
    onListChanged: () => {},
    close: async () => {},
    kill: () => {},
    ...over,
  };
}

/** 内存里的配置源 —— 不碰磁盘。errors/unrecognizedIds 固定给空，不模拟解析失败
    （模拟解析失败、F1 的场景用下面的 fileStore，走真实的 mcpConfig 读写函数） */
function memStore(initial: Record<string, McpServerConfig> = {}) {
  let servers = { ...initial };
  return {
    load: () => ({ servers, errors: [] as string[], unrecognizedIds: [] as string[], fatal: false }),
    save: (next: Record<string, McpServerConfig>, _unrecognizedIds: readonly string[]) => {
      servers = { ...next };
    },
    // 大多数测试不关心授权/清凭据这两条通道——给个啥都不做的默认值，
    // 免得每处 createMcpHub 调用都要补这两个字段
    authorize: async () => {},
    clearAuth: () => {},
  };
}

/** 内存里的"文件" —— 走真实的 loadMcpConfig/saveMcpConfig（连同它们背后的
    parseMcpConfig/serializeMcpConfig），只是 fs 换成一个内存字符串。
    F1 的两个 scenario 要测的是这几个函数拼在一起之后的真实行为，
    memStore 那种"servers 直接是 Record"的假实现绕过了 parseMcpConfig，
    测不出"解析不动的 id 有没有被冲掉"这件事 */
function fileStore(initialText = "") {
  let text = initialText;
  const reader: McpConfigReader = {
    readFile: () => text,
    writeFile: (_path, t) => { text = t; },
  };
  return {
    get text() {
      return text;
    },
    /** 模拟外部编辑器把文件改坏（issue #159） */
    corrupt(bad: string) {
      text = bad;
    },
    load: () => loadMcpConfig("mcp.json", reader),
    save: (servers: Record<string, McpServerConfig>, unrecognizedIds: readonly string[]) =>
      saveMcpConfig("mcp.json", servers, unrecognizedIds, reader),
    // 同 memStore：F1 场景不关心授权/清凭据，给默认空实现
    authorize: async () => {},
    clearAuth: () => {},
  };
}

describe("createMcpHub", () => {
  it("ready() 把 enabled 的 server 连上，状态转 connected", async () => {
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    const [s] = hub.servers();
    expect(s!.status).toBe("connected");
    expect(s!.live).toBe(true);
    expect(s!.tools.map((t) => t.name)).toEqual(["t1"]);
  });

  it("enabled: false 的不连，但仍出现在清单里（设置页要显示它）", async () => {
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...memStore({ off: { ...stdio(), enabled: false } }), connect });
    await hub.ready();
    expect(connect).not.toHaveBeenCalled();
    expect(hub.servers()).toHaveLength(1);
    expect(hub.servers()[0]!.live).toBe(false);
  });

  it("连不上 = failed + 人话原因，不抛（一台挂了不该拖垮 ready）", async () => {
    const connect: McpConnect = async () => { throw new Error("spawn npx ENOENT"); };
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await expect(hub.ready()).resolves.toBeUndefined();
    const [s] = hub.servers();
    expect(s!.status).toBe("failed");
    expect(s!.error).toContain("ENOENT");
  });

  it("401 映射成 needs-auth 而不是 failed —— UI 要据此显示 Authorize", async () => {
    const connect: McpConnect = async () => { throw new McpAuthRequiredError("要授权"); };
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    expect(hub.servers()[0]!.status).toBe("needs-auth");
  });

  it("一台挂了不影响另一台连上", async () => {
    const connect: McpConnect = async (id) => {
      if (id === "bad") throw new Error("炸了");
      return conn();
    };
    const hub = createMcpHub({ ...memStore({ bad: stdio(), good: stdio() }), connect });
    await hub.ready();
    const byId = Object.fromEntries(hub.servers().map((s) => [s.id, s.status]));
    expect(byId["bad"]).toBe("failed");
    expect(byId["good"]).toBe("connected");
  });

  it("ready() 幂等 —— 已连上的不重连", async () => {
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    await hub.ready();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("并发调 ready() 只连一次", async () => {
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await Promise.all([hub.ready(), hub.ready(), hub.ready()]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("failed 的 server 下次 ready() 会重试 —— 用户可能刚把 npx 装上", async () => {
    let fail = true;
    const connect: McpConnect = vi.fn(async () => {
      if (fail) throw new Error("炸了");
      return conn();
    });
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    expect(hub.servers()[0]!.status).toBe("failed");
    fail = false;
    await hub.ready();
    expect(hub.servers()[0]!.status).toBe("connected");
  });

  it("callTool 转给对应的 conn", async () => {
    const callTool = vi.fn(async () => [{ kind: "text" as const, text: "结果" }]);
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => conn({ callTool }) });
    await hub.ready();
    const out = await hub.callTool("a", "t1", { x: 1 });
    expect(callTool).toHaveBeenCalledWith("t1", { x: 1 }, undefined);
    expect(out).toEqual([{ kind: "text", text: "结果" }]);
  });

  it("对没连上的 server 调 callTool 报人话", async () => {
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => { throw new Error("x"); } });
    await hub.ready();
    await expect(hub.callTool("a", "t1", {})).rejects.toThrow(/a/);
  });

  it("list_changed 通知触发重拉清单 —— 靠 hub 真的调用 refresh()，不是外部直接改数组", async () => {
    // tools 是一个普通字段（不是 getter），只有 refreshSpy 内部会改它。
    // 这样断言"清单变成 2 个"就只能靠 hub 调用了 conn.refresh() 才成立——
    // 如果 hub 里触发重拉的那段代码被删掉，refreshSpy 不会被调用，
    // tools 也就永远停在 1 个，测试会失败（而不是像原来那样，不管 hub
    // 有没有调用 refresh，测试都会通过，因为断言读的是被测试自己从外部
    // 改过的同一个数组）。
    let fire = () => {};
    const fakeConn: McpClientConn = conn();
    // tools 对外是 readonly（McpClientConn 的契约），refreshSpy 是"内部实现"，
    // 借同一个手法（mcpClient.ts 自己也这么干）绕开 readonly 去写同一个对象。
    const mutable = fakeConn as { tools: McpClientConn["tools"] };
    const refreshSpy = vi.fn(async () => {
      mutable.tools = [
        { name: "t1", description: "", inputSchema: {} },
        { name: "t2", description: "", inputSchema: {} },
      ];
    });
    fakeConn.onListChanged = (cb: () => void) => { fire = cb; };
    fakeConn.refresh = refreshSpy;
    const connect: McpConnect = async () => fakeConn;
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    expect(hub.servers()[0]!.tools).toHaveLength(1);
    expect(refreshSpy).not.toHaveBeenCalled();
    fire();
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hub.servers()[0]!.tools).toHaveLength(2));
  });

  it("onChange 在状态变化时被叫到（渲染层靠它刷新）", async () => {
    const seen = vi.fn();
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => conn() });
    hub.onChange(seen);
    await hub.ready();
    expect(seen).toHaveBeenCalled();
  });

  it("save() 存配置并重连那一台", async () => {
    const store = memStore();
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...store, connect });
    await hub.save("a", stdio());
    expect(store.load().servers["a"]).toBeDefined();
    expect(hub.servers()[0]!.status).toBe("connected");
  });

  it("remove() 关掉连接并从清单里去掉", async () => {
    const close = vi.fn(async () => {});
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => conn({ close }) });
    await hub.ready();
    await hub.remove("a");
    expect(close).toHaveBeenCalled();
    expect(hub.servers()).toEqual([]);
  });

  it("closeAll() 关掉每一条连接（退出时用）", async () => {
    const close = vi.fn(async () => {});
    const hub = createMcpHub({ ...memStore({ a: stdio(), b: stdio() }), connect: async () => conn({ close }) });
    await hub.ready();
    await hub.closeAll();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("list() 过桥的配置里凭据是遮罩过的 —— 真值不出主进程", async () => {
    const secret: McpServerConfig = {
      kind: "stdio", command: "npx", args: [], env: { TOKEN: "ghp_abcdefghijklmnop" }, enabled: true,
    };
    const hub = createMcpHub({ ...memStore({ a: secret }), connect: async () => conn() });
    const [row] = hub.list();
    expect(row!.config.kind).toBe("stdio");
    if (row!.config.kind !== "stdio") throw new Error("窄化失败");
    expect(row!.config.env["TOKEN"]).toContain("*****");
    expect(JSON.stringify(hub.list())).not.toContain("ghp_abcdefghijklmnop");
  });
});

// review finding 1：before-quit 不会等 closeAll() 的 promise settle，
// 保证只能来自"kill() 在这次调用返回之前就已经同步跑完"
describe("closeAll() 的同步 kill（review finding 1）", () => {
  it("kill() 在 closeAll() 返回的 promise 有机会 settle 之前就已经被叫过", async () => {
    const killed: string[] = [];
    // close() 故意永远不 resolve —— 模拟 SDK 优雅关闭卡在那两个 2s 定时器上，
    // 如果 closeAll() 的收尾依赖 close()，这条测试就会挂死，而不是像现在这样
    // 立刻看到 kill() 已经跑完
    const hangingClose = () => new Promise<void>(() => {});
    const connect: McpConnect = async (id) => conn({ kill: () => { killed.push(id); }, close: hangingClose });
    const hub = createMcpHub({ ...memStore({ a: stdio(), b: stdio() }), connect });
    await hub.ready();

    const settled = hub.closeAll(); // 不 await —— 这条 promise 本来就不会 resolve
    // 微任务/宏任务都还没轮到之前，kill() 的同步代码已经跑完：
    // async 函数体在第一个 await 之前是整段同步执行的（见 mcpHub.ts 的注释）
    expect(killed.sort()).toEqual(["a", "b"]);
    void settled; // 明知不会 settle，不等它，避免测试挂起
  });

  it("closeAll() 仍然尝试 close() —— kill 是兜底，不是取代协议层收尾", async () => {
    const close = vi.fn(async () => {});
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => conn({ close }) });
    await hub.ready();
    await hub.closeAll();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// review finding 2：ready() 曾经无界等待，一台握手不完的 server 会让
// startSession/resumeSession 挂到 SDK 的 60s 默认超时
describe("ready() 的超时兜底（review finding 2）", () => {
  it("一台永远握手不完的 server 不会拖死 ready()，超时后状态留在 connecting", async () => {
    vi.useFakeTimers();
    try {
      const neverConnect: McpConnect = () => new Promise<McpClientConn>(() => {});
      const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: neverConnect });

      const readyPromise = hub.ready();
      await vi.advanceTimersByTimeAsync(10_000); // 走过 READY_TIMEOUT_MS
      await expect(readyPromise).resolves.toBeUndefined();

      // 没连完不等于连不上——不能把它判成 failed，那是撒谎；
      // "connecting" 才是诚实的状态，UI 之后能靠 onChange 收到真正的结果
      expect(hub.servers()[0]!.status).toBe("connecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时之后再调 ready() 不会对同一台还在连接中的 server 重复发起连接", async () => {
    vi.useFakeTimers();
    try {
      const connect = vi.fn(() => new Promise<McpClientConn>(() => {}));
      const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });

      void hub.ready();
      await vi.advanceTimersByTimeAsync(10_000);
      void hub.ready(); // 第二次调用：上一轮的 connectOne 其实还挂在那儿没死
      await vi.advanceTimersByTimeAsync(10_000);

      // 两次 ready() 都超时返回，但底层只应该对 "a" 发起过一次 opts.connect() ——
      // readying 不因为超时被提前清空，才不会撞出同一个 id 的第二个孤儿进程
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// review finding 3：设置页的表单会拿 list() 给的遮罩值预填，原样交回来
// 不该覆盖磁盘上的真凭据。这条测试删掉 mergeMaskedCreds 就会失败。
describe("save() 合并遮罩值（review finding 3）", () => {
  it("表单没碰的凭据字段送回遮罩值 —— 磁盘上的真值原样保留", async () => {
    const store = memStore({
      a: { kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-real-secret-0123456789" }, enabled: true },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();

    const [row] = hub.list();
    if (row!.config.kind !== "stdio") throw new Error("窄化失败");
    const shownToken = row!.config.env["TOKEN"]!;
    expect(shownToken).not.toBe("sk-real-secret-0123456789"); // 渲染层看到的确实是遮罩值

    // 模拟设置页：用户只改了 args，凭据字段原样把遮罩值交回来
    await hub.save("a", {
      kind: "stdio", command: "npx", args: ["-y"], env: { TOKEN: shownToken }, enabled: true,
    });

    const saved = store.load().servers["a"];
    if (saved!.kind !== "stdio") throw new Error("窄化失败");
    expect(saved!.env["TOKEN"]).toBe("sk-real-secret-0123456789"); // 真值没被星号覆盖
    expect(saved!.args).toEqual(["-y"]); // 用户真改的那部分照常生效
  });

  it("用户真的改了凭据 —— 新值原样生效，不会被合并逻辑拦住", async () => {
    const store = memStore({
      a: { kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-old-value-0123456789" }, enabled: true },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();

    await hub.save("a", {
      kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-brand-new-value-999999" }, enabled: true,
    });

    const saved = store.load().servers["a"];
    if (saved!.kind !== "stdio") throw new Error("窄化失败");
    expect(saved!.env["TOKEN"]).toBe("sk-brand-new-value-999999");
  });

  it("新建 server（磁盘上没有旧值）：incoming 原样采信，没有旧值可合并", async () => {
    const store = memStore({});
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();

    await hub.save("new", {
      kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-first-time-0123456789" }, enabled: true,
    });

    const saved = store.load().servers["new"];
    if (saved!.kind !== "stdio") throw new Error("窄化失败");
    expect(saved!.env["TOKEN"]).toBe("sk-first-time-0123456789");
  });

  it("新建一台 server 时,凭据字段哪怕长得像遮罩,也不该被这道闸拦住（没有旧值可覆盖）", async () => {
    const store = memStore({});
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();

    // 这串是另一把 key 遮罩之后的形状,但这是新建 server,没有"磁盘上的旧值"
    // 可言——闸门的判据要求 stored[k] !== undefined,新建天然不满足
    await expect(
      hub.save("brand-new", {
        kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-31cf5*****828c" }, enabled: true,
      })
    ).resolves.toBeUndefined();

    const saved = store.load().servers["brand-new"];
    if (saved!.kind !== "stdio") throw new Error("窄化失败");
    expect(saved!.env["TOKEN"]).toBe("sk-31cf5*****828c");
  });

  // issue #158：闸门那句 `stored[k] !== undefined` 从前没有测试钉住——
  // 只删这一个子句，全部 mcpHub 测试照样绿。而它是承重的：上面那条测的是
  // 新建**整台 server**（stored 为 undefined，函数第一行就 return 了，
  // 压根走不到闸门），走到闸门还能被这个子句放过去的是下面这种——
  // 已有 server 上加一个**新键**
  it("已有 server 加一个新键，值恰好落在 maskKey 的不动点上也放行（stored[k] === undefined）", async () => {
    const store = memStore({
      a: { kind: "stdio", command: "npx", args: [], env: { OLD: "sk-old-real-0123456789" }, enabled: true },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();
    const masked = maskKey("sk-old-real-0123456789");

    await expect(
      hub.save("a", {
        kind: "stdio", command: "npx", args: [],
        // OLD 没碰（交回遮罩），NEW 是一把恰好长得像遮罩的新值
        env: { OLD: masked, NEW: "sk-31cf5*****828c" },
        enabled: true,
      })
    ).resolves.toBeUndefined();

    const saved = store.load().servers["a"];
    if (saved!.kind !== "stdio") throw new Error("窄化失败");
    expect(saved!.env["OLD"]).toBe("sk-old-real-0123456789"); // 旧值没被遮罩覆盖
    expect(saved!.env["NEW"]).toBe("sk-31cf5*****828c"); // 新键原样收下
  });

  // issue #158：merge 层的"没碰过就往返回真值"只测了 stdio/env，http/headers
  // 那一路（同一个 merge 函数的另一个调用点）没有对应的往返测试
  it("http headers 没碰过的字段送回遮罩值 —— 磁盘上的真值原样保留", async () => {
    const store = memStore({
      a: { kind: "http", url: "https://a.example.com", headers: { Authorization: "sk-http-real-0123456789" }, enabled: true },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();
    const masked = maskKey("sk-http-real-0123456789");

    // 用户只改了 url，Authorization 原样把遮罩交回来
    await hub.save("a", {
      kind: "http", url: "https://a2.example.com", headers: { Authorization: masked }, enabled: true,
    });

    const saved = store.load().servers["a"];
    if (saved!.kind !== "http") throw new Error("窄化失败");
    expect(saved!.url).toBe("https://a2.example.com");
    expect(saved!.headers["Authorization"]).toBe("sk-http-real-0123456789");
  });

  // issue #158：两个键合法地共用同一个真值时，两份遮罩长得一模一样——
  // 闸门必须逐键判断，不能因为"这串遮罩已经在别处出现过"就一竿子拒了
  it("两个键共用同一个真值：两份遮罩交回来，两个键都还原成真值", async () => {
    const store = memStore({
      a: {
        kind: "stdio", command: "npx", args: [],
        env: { TOKEN_A: "sk-shared-real-0123456789", TOKEN_B: "sk-shared-real-0123456789" },
        enabled: true,
      },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();
    const masked = maskKey("sk-shared-real-0123456789");

    await expect(
      hub.save("a", {
        kind: "stdio", command: "npx", args: [],
        env: { TOKEN_A: masked, TOKEN_B: masked },
        enabled: true,
      })
    ).resolves.toBeUndefined();

    const saved = store.load().servers["a"];
    if (saved!.kind !== "stdio") throw new Error("窄化失败");
    expect(saved!.env["TOKEN_A"]).toBe("sk-shared-real-0123456789");
    expect(saved!.env["TOKEN_B"]).toBe("sk-shared-real-0123456789");
  });
});

// review D1/D2：渲染层的 hasStrayMaskedValue 只看得见自己手上那份 baseline，
// 看不见"另一台 server 的遮罩被粘过来了"或者"这一行展开期间磁盘被外部改过"。
// 这道闸长在 mergeMaskedCreds 里，同时看得见"整份磁盘现状"和"这次 incoming
// 改的是哪台/哪个键"，堵上渲染层结构性看不见的两个洞
describe("mergeMaskedCreds 拒绝跨 server / 过期遮罩（review D1/D2）", () => {
  it("D1：把另一台 server 的可见遮罩粘进这一台已存在的键——拒存并抛错", async () => {
    const store = memStore({
      a: { kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-server-a-secret-0000000" }, enabled: true },
      b: { kind: "stdio", command: "npx", args: [], env: { GITHUB_TOKEN: "sk-server-b-secret-1111" }, enabled: true },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();

    const [rowA] = hub.list().filter((s) => s.id === "a");
    if (rowA!.config.kind !== "stdio") throw new Error("窄化失败");
    const maskedA = rowA!.config.env["TOKEN"]!;

    // 用户把 A 的遮罩粘进了 B 的 GITHUB_TOKEN 值框，键名 GITHUB_TOKEN 没变
    await expect(
      hub.save("b", {
        kind: "stdio", command: "npx", args: [], env: { GITHUB_TOKEN: maskedA }, enabled: true,
      })
    ).rejects.toThrow(/遮罩|真凭据/);

    // 拒存意味着磁盘上 B 的真凭据必须原封不动，不能被半途写坏
    const stillB = store.load().servers["b"];
    if (stillB!.kind !== "stdio") throw new Error("窄化失败");
    expect(stillB!.env["GITHUB_TOKEN"]).toBe("sk-server-b-secret-1111");
  });

  it("D2：这一行展开期间磁盘被外部改过，交回来的还是旧遮罩——拒存，不拿旧遮罩覆盖新真值", async () => {
    const store = memStore({
      a: { kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-old-real-value-000000" }, enabled: true },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();

    const [row] = hub.list();
    if (row!.config.kind !== "stdio") throw new Error("窄化失败");
    const staleMask = row!.config.env["TOKEN"]!; // 渲染层此刻手上握着的遮罩

    // 磁盘在渲染层这一行展开期间被外部改了(手改 mcp.json / 另一个窗口存过)
    store.save({
      a: { kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-new-real-value-999999" }, enabled: true },
    }, []);

    // 渲染层不知道磁盘已经变了，交回来的还是它自己那份过期的遮罩
    await expect(
      hub.save("a", {
        kind: "stdio", command: "npx", args: [], env: { TOKEN: staleMask }, enabled: true,
      })
    ).rejects.toThrow(/遮罩|真凭据/);

    const stillNew = store.load().servers["a"];
    if (stillNew!.kind !== "stdio") throw new Error("窄化失败");
    expect(stillNew!.env["TOKEN"]).toBe("sk-new-real-value-999999"); // 新真值没被旧遮罩覆盖
  });

  it("清空一个字段（value === \"\"）不该被这道闸拦住——空值是正常操作", async () => {
    const store = memStore({
      a: { kind: "stdio", command: "npx", args: [], env: { TOKEN: "sk-real-secret-0123456789" }, enabled: true },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();

    await expect(
      hub.save("a", { kind: "stdio", command: "npx", args: [], env: { TOKEN: "" }, enabled: true })
    ).resolves.toBeUndefined();

    const saved = store.load().servers["a"];
    if (saved!.kind !== "stdio") throw new Error("窄化失败");
    expect(saved!.env["TOKEN"]).toBe("");
  });

  it("http headers 同一条闸——跨 server 粘遮罩同样拒存", async () => {
    const store = memStore({
      a: { kind: "http", url: "https://a.example.com", headers: { Authorization: "sk-http-a-secret-0000" }, enabled: true },
      b: { kind: "http", url: "https://b.example.com", headers: { Authorization: "sk-http-b-secret-1111" }, enabled: true },
    });
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();

    const [rowA] = hub.list().filter((s) => s.id === "a");
    if (rowA!.config.kind !== "http") throw new Error("窄化失败");
    const maskedA = rowA!.config.headers["Authorization"]!;

    await expect(
      hub.save("b", {
        kind: "http", url: "https://b.example.com", headers: { Authorization: maskedA }, enabled: true,
      })
    ).rejects.toThrow(/遮罩|真凭据/);
  });

  it("maskKey 在三段长度分支上都是幂等的——这道闸能成立的前提，单独钉住", () => {
    const long = "sk-abcdefghijklmnopqrstuvwxyz0123456789"; // >= 16
    const mid = "abcdefgh"; // 8-15
    const short = "ab"; // < 8
    for (const s of [long, mid, short]) {
      const once = maskKey(s);
      expect(maskKey(once)).toBe(once);
    }
  });
});

// review finding 4：mcpConfig.ts 的 parseMcpConfig 早就结构化产出了错误列表，
// 但过去 hub 只解构了 servers，errors 从没被接到任何地方
describe("configErrors()（review finding 4）", () => {
  it("同步磁盘之前是空的；list()/syncFromDisk 之后原样透出解析错误", () => {
    const errors = ['server「x」缺 command'];
    const hub = createMcpHub({
      load: () => ({ servers: {}, errors, unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: vi.fn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    expect(hub.configErrors()).toEqual([]);
    hub.list(); // list() 内部会 syncFromDisk()
    expect(hub.configErrors()).toEqual(errors);
  });
});

// F1（whole-branch review 的 blocking finding）：解析不动的那台 server 不该
// 因为用户保存/删除了别的 server 就从磁盘上消失；整份文件语法错误时也不该
// 被"重建"成只剩这次改动的样子。下面两组测试分别钉住"hub 有没有把
// unrecognizedIds 转给 opts.save"（单元级、用假 store 观察调用参数）和
// "拼上真实的 mcpConfig 读写函数之后，reviewer 复现的两个 scenario 有没有
// 真的被修好"（端到端、用 fileStore）
describe("save()/remove() 不冲掉解析不动的邻居（F1 half 1）", () => {
  it("save() 把当前 unrecognizedIds 原样转给 opts.save —— 邻居的 broken sibling 不会因为这次保存而消失", async () => {
    const savedUnrecognized: (readonly string[])[] = [];
    const hub = createMcpHub({
      load: () => ({
        servers: { good: stdio() },
        errors: ["broken：既没有 command 也没有 url，不知道怎么连（本台跳过）"],
        unrecognizedIds: ["broken"],
        fatal: false,
      }),
      save: (_servers, unrecognizedIds) => { savedUnrecognized.push(unrecognizedIds); },
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.save("good", stdio("npx-changed"));
    // 如果 mcpHub.save() 忘了把 unrecognizedIds 转给 opts.save（比如改回
    // `opts.save(next)` 少传一个参数），这里拿到的就是 undefined，断言失败
    expect(savedUnrecognized[0]).toEqual(["broken"]);
  });

  it("remove() 同样把 unrecognizedIds 转给 opts.save —— 删掉一台健康 server 不牵连 broken sibling", async () => {
    const savedCalls: { servers: Record<string, McpServerConfig>; unrecognizedIds: readonly string[] }[] = [];
    const hub = createMcpHub({
      load: () => ({
        servers: { good: stdio() },
        errors: ["broken：既没有 command 也没有 url，不知道怎么连（本台跳过）"],
        unrecognizedIds: ["broken"],
        fatal: false,
      }),
      save: (servers, unrecognizedIds) => { savedCalls.push({ servers, unrecognizedIds }); },
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    await hub.remove("good");
    // servers 参数里 good 已经不在了（真的被删），但 unrecognizedIds 必须
    // 依然带着 "broken"——它从来不经过 entries，只能靠这条通道活下来
    expect(savedCalls[0]!.servers).toEqual({});
    expect(savedCalls[0]!.unrecognizedIds).toEqual(["broken"]);
  });

  it("save() 里 opts.save 抛（整份文件语法错误）时，错误原样穿透，内存状态不被假装保存成功", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: { a: stdio() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {
        throw new Error("mcp.json 当前不是合法 JSON，为避免连带删掉其余内容，这次保存已取消");
      },
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    await expect(hub.save("a", stdio("changed"))).rejects.toThrow(/不是合法 JSON/);
    // 旧配置/旧连接原样留着——不是"保存失败了但内存已经切到新状态"这种
    // 更糟的半吊子结果
    expect(hub.servers()[0]!.status).toBe("connected");
  });

  it("remove() 里 opts.save 抛时，连接不能已经被关掉却没能持久化删除——写在关连接之前", async () => {
    const close = vi.fn(async () => {});
    const hub = createMcpHub({
      load: () => ({ servers: { a: stdio() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {
        throw new Error("mcp.json 当前不是合法 JSON，为避免连带删掉其余内容，这次保存已取消");
      },
      connect: async () => conn({ close }),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    await expect(hub.remove("a")).rejects.toThrow(/不是合法 JSON/);
    // 如果 remove() 被改回"先关连接、再写盘"的顺序，这里 close 已经被叫过，
    // 断言会失败——这条测试钉住的是顺序，不是"最终有没有报错"
    expect(close).not.toHaveBeenCalled();
    expect(hub.servers()).toHaveLength(1);
  });
});

describe("F1 端到端 —— 拼上真实的 mcpConfig 读写函数，复现 reviewer 的两个 scenario", () => {
  it("scenario A：保存一台 server 之后，解析不动的邻居依然在磁盘上（reviewer：good1 ids 之外的 broken 不该消失）", async () => {
    const store = fileStore(JSON.stringify({
      mcpServers: {
        good1: { command: "npx" },
        good2: { command: "npx" },
        broken: { note: "既没有 command 也没有 url" },
      },
    }));
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();
    await hub.save("good1", { kind: "stdio", command: "npx-changed", args: [], env: {}, enabled: true });
    const onDisk = JSON.parse(store.text) as { mcpServers: Record<string, unknown> };
    expect(onDisk.mcpServers["broken"]).toEqual({ note: "既没有 command 也没有 url" });
    expect((onDisk.mcpServers["good1"] as { command: string }).command).toBe("npx-changed");
    expect(onDisk.mcpServers["good2"]).toBeDefined();
  });

  it("scenario A 的删除变体：删掉一台健康 server 之后，解析不动的邻居依然在", async () => {
    const store = fileStore(JSON.stringify({
      mcpServers: {
        good1: { command: "npx" },
        good2: { command: "npx" },
        broken: { note: "既没有 command 也没有 url" },
      },
    }));
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();
    await hub.remove("good2");
    const onDisk = JSON.parse(store.text) as { mcpServers: Record<string, unknown> };
    expect(onDisk.mcpServers["broken"]).toEqual({ note: "既没有 command 也没有 url" });
    expect(onDisk.mcpServers["good2"]).toBeUndefined();
    expect(onDisk.mcpServers["good1"]).toBeDefined();
  });

  it("scenario B：整份 JSON 语法错误时，新建一台不会把文件冲成只剩这一台——保存被拒绝，磁盘原样不动", async () => {
    const brokenText = "{ 这不是 json，但磁盘上原本还有 good1 和它的凭据";
    const store = fileStore(brokenText);
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready(); // 整份解析不动 -> servers 是空的,ready() 无事可连
    await expect(
      hub.save("brandnew", { kind: "stdio", command: "npx", args: [], env: {}, enabled: true })
    ).rejects.toThrow(/不是合法 JSON/);
    // 拒绝写之后磁盘必须原样不动——不能被"brandnew"取代（reviewer 复现的
    // 那句 "good1 and its credential destroyed" 就是这里被冲掉的）
    expect(store.text).toBe(brokenText);
  });
});

// issue #159：会话中途，外部把 ~/.otter/mcp.json 改成语法不合法。
// 从前 syncFromDisk 看到 servers:{} 就当成"用户把 server 都删了"，
// 在拒绝写入那一步之前先把活连接一条条关掉、从内存里忘掉，用户毫无提示。
describe("mcp.json 中途被改坏时不牵连活着的连接（issue #159）", () => {
  it("fatal 的一次 load 不关连接、不忘记 server", async () => {
    let fatal = false;
    const close = vi.fn(async () => {});
    const hub = createMcpHub({
      load: () =>
        fatal
          ? { servers: {}, errors: ["mcp.json 不是合法 JSON，整份配置本次被忽略"], unrecognizedIds: [], fatal: true }
          : { servers: { a: stdio(), b: stdio() }, errors: [], unrecognizedIds: [], fatal: false },
      save: () => {},
      connect: async () => conn({ close }),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    expect(hub.servers().map((s) => s.status)).toEqual(["connected", "connected"]);

    fatal = true;
    hub.list(); // list() 内部 syncFromDisk()

    expect(close).not.toHaveBeenCalled();
    expect(hub.servers().map((s) => s.id)).toEqual(["a", "b"]);
    expect(hub.servers().every((s) => s.live)).toBe(true);
  });

  it("fatal 时解析错误照常透出去（设置页要说得出文件坏了）", async () => {
    const hub = createMcpHub({
      load: () => ({
        servers: {},
        errors: ["mcp.json 不是合法 JSON，整份配置本次被忽略"],
        unrecognizedIds: [],
        fatal: true,
      }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    hub.list();
    expect(hub.configErrors()).toEqual(["mcp.json 不是合法 JSON，整份配置本次被忽略"]);
  });

  it("fatal 不吞掉真正的删除：文件修好之后，少掉的那台照常被关掉", async () => {
    let phase: "both" | "fatal" | "one" = "both";
    const closed: string[] = [];
    const hub = createMcpHub({
      load: () =>
        phase === "fatal"
          ? { servers: {}, errors: ["坏了"], unrecognizedIds: [], fatal: true }
          : {
              servers: phase === "both" ? { a: stdio(), b: stdio() } : { a: stdio() },
              errors: [],
              unrecognizedIds: [],
              fatal: false,
            },
      save: () => {},
      connect: async (id) => conn({ close: async () => { closed.push(id); } }),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    phase = "fatal";
    hub.list();
    expect(closed).toEqual([]);
    phase = "one";
    hub.list();
    expect(closed).toEqual(["b"]);
    expect(hub.servers().map((s) => s.id)).toEqual(["a"]);
  });

  it("端到端：两台连着，文件被外部改坏，再存一台 —— 连接留着，保存被拒", async () => {
    const store = fileStore(
      JSON.stringify({ mcpServers: { a: { command: "npx", args: [] }, b: { command: "npx", args: [] } } })
    );
    const hub = createMcpHub({ ...store, connect: async () => conn() });
    await hub.ready();
    expect(hub.servers().every((s) => s.live)).toBe(true);

    store.corrupt("{ 这不是 JSON");

    await expect(hub.save("a", stdio("npx-changed"))).rejects.toThrow(/不是合法 JSON/);
    // 从前这里两条连接已经先被关掉了，而且用户看不到任何提示
    expect(hub.servers().map((s) => s.id)).toEqual(["a", "b"]);
    expect(hub.servers().every((s) => s.live)).toBe(true);
  });
});

describe("authorize", () => {
  it("授权成功后自动重连，状态从 needs-auth 变 connected", async () => {
    let authed = false;
    const hub = createMcpHub({
      load: () => ({ servers: { s: http() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => {
        if (!authed) throw new McpAuthRequiredError("s 需要授权");
        return conn();
      },
      authorize: async () => { authed = true; },
      clearAuth: () => {},
    });
    await hub.ready();
    expect(hub.list()[0]!.status).toBe("needs-auth");
    await hub.authorize("s");
    expect(hub.list()[0]!.status).toBe("connected");
  });

  it("授权失败原样抛出去，状态不被伪造成 connected", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: { s: http() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => { throw new McpAuthRequiredError("s 需要授权"); },
      authorize: async () => { throw new Error("用户点了拒绝"); },
      clearAuth: () => {},
    });
    await hub.ready();
    await expect(hub.authorize("s")).rejects.toThrow("用户点了拒绝");
    expect(hub.list()[0]!.status).toBe("needs-auth");
  });

  it("不存在的 id 给人话", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: {}, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await expect(hub.authorize("不存在")).rejects.toThrow(/不存在/);
  });

  it("删除一台 server 顺手清掉它的 OAuth 凭据——留着就是一份没人管的长期授权", async () => {
    const cleared: string[] = [];
    const hub = createMcpHub({
      load: () => ({ servers: { s: http() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: (id) => { cleared.push(id); },
    });
    await hub.ready();
    await hub.remove("s");
    expect(cleared).toEqual(["s"]);
  });
});

describe("configure（agent 侧的写配置能力）", () => {
  it("configure 新增一台，落盘并尝试连接", async () => {
    const saved: Record<string, unknown>[] = [];
    const hub = createMcpHub({
      load: () => ({ servers: {}, errors: [], unrecognizedIds: [], fatal: false }),
      save: (servers) => { saved.push(servers); },
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.configure("s", http());
    expect(saved.at(-1)).toHaveProperty("s");
    expect(hub.servers().find((x) => x.id === "s")?.live).toBe(true);
  });

  it("configure(id, null) = 删除", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: { s: http() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    await hub.configure("s", null);
    expect(hub.servers().find((x) => x.id === "s")).toBeUndefined();
  });

  it("configOf 拿得到当前配置（审批预览要对照「改之前是什么」）", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: { s: http("https://a/mcp") }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    expect(hub.configOf("s")).toMatchObject({ kind: "http", url: "https://a/mcp" });
    expect(hub.configOf("没有这台")).toBeUndefined();
  });

  // #504：mcp_configure / mcp_authorize 会长时间阻塞 turn（连接兜底 60s /
  // 等授权 5 分钟），用户点停止必须能穿进来
  describe("中断（#504）", () => {
    it("authorize 把 signal 透传给 opts.authorize（真取消发生在 mcpClient 那一层）", async () => {
      const authorize = vi.fn(async () => {});
      const hub = createMcpHub({ ...memStore({ a: http() }), connect: async () => conn(), authorize });
      await hub.ready();
      const ac = new AbortController();
      await hub.authorize("a", ac.signal);
      expect(authorize).toHaveBeenCalledWith("a", expect.anything(), ac.signal);
    });

    it("configure 连接卡住时中断：调用立即 reject，配置已落盘，连接在后台跑到底收尾（不留半连接）", async () => {
      let release!: (c: McpClientConn) => void;
      const store = memStore();
      const connect: McpConnect = () => new Promise((r) => { release = r; });
      const hub = createMcpHub({ ...store, connect });
      const ac = new AbortController();
      const p = hub.configure("a", stdio(), ac.signal);
      const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
      ac.abort();
      await assertion;
      // 中断只是弃等，不是撤销：审批已经过了，配置必须已在盘上
      expect(store.load().servers["a"]).toBeDefined();
      // 后台那次连接跑完后状态自己收尾——同 ready() 超时的取舍，
      // 不因为中断对同一台发起第二次 connect（stdio 下那是孤儿子进程）
      release(conn());
      await new Promise((r) => { setTimeout(r, 0); });
      expect(hub.servers().find((s) => s.id === "a")?.live).toBe(true);
    });

    it("signal 已中断时 configure 直接 reject，不写盘", async () => {
      const store = memStore();
      const saveSpy = vi.spyOn(store, "save");
      const hub = createMcpHub({ ...store, connect: async () => conn() });
      const ac = new AbortController();
      ac.abort();
      await expect(hub.configure("a", stdio(), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(saveSpy).not.toHaveBeenCalled();
    });
  });
});
