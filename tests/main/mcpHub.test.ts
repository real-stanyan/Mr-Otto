import { describe, it, expect, vi } from "vitest";
import { createMcpHub, type McpConnect } from "../../src/main/mcpHub.js";
import { McpAuthRequiredError, type McpClientConn } from "../../src/main/mcpClient.js";
import type { McpServerConfig } from "../../src/shared/mcp.js";

const stdio = (command = "npx"): McpServerConfig => ({
  kind: "stdio", command, args: [], env: {}, enabled: true,
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

/** 内存里的配置源 —— 不碰磁盘 */
function memStore(initial: Record<string, McpServerConfig> = {}) {
  let servers = { ...initial };
  return {
    load: () => ({ servers, errors: [] as string[] }),
    save: (next: Record<string, McpServerConfig>) => { servers = { ...next }; },
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
});

// review finding 4：mcpConfig.ts 的 parseMcpConfig 早就结构化产出了错误列表，
// 但过去 hub 只解构了 servers，errors 从没被接到任何地方
describe("configErrors()（review finding 4）", () => {
  it("同步磁盘之前是空的；list()/syncFromDisk 之后原样透出解析错误", () => {
    const errors = ['server「x」缺 command'];
    const hub = createMcpHub({
      load: () => ({ servers: {}, errors }),
      save: () => {},
      connect: vi.fn(),
    });
    expect(hub.configErrors()).toEqual([]);
    hub.list(); // list() 内部会 syncFromDisk()
    expect(hub.configErrors()).toEqual(errors);
  });
});
