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
