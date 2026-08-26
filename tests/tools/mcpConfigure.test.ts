import { describe, it, expect, vi } from "vitest";
import { createMcpConfigureTool } from "../../src/tools/mcpConfigure.js";
import type { McpCapability } from "../../src/world/executionWorld.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function cap(over: Partial<McpCapability> = {}): McpCapability {
  return {
    ready: async () => {},
    servers: () => [],
    callTool: async () => [],
    readResource: async () => [],
    getPrompt: async () => "",
    configure: vi.fn(async () => {}),
    authorize: async () => {},
    configOf: () => undefined,
    ...over,
  } as McpCapability;
}
const world = (mcp: McpCapability) => ({ mcp }) as ExecutionWorld;

describe("mcp_configure", () => {
  it("必须过审批门——这是这条路上唯一的安全闸", () => {
    expect(createMcpConfigureTool(cap()).requiresApproval).toBe(true);
  });

  it("绝不是 parallelSafe（写盘 + 重连，有副作用）", () => {
    expect(createMcpConfigureTool(cap()).parallelSafe).not.toBe(true);
  });

  it("http：把 url 交给 configure", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run(
      { id: "supabase", kind: "http", url: "https://mcp.supabase.com/mcp" },
      world(c)
    );
    expect(c.configure).toHaveBeenCalledWith("supabase", {
      kind: "http", url: "https://mcp.supabase.com/mcp", headers: {}, enabled: true,
    });
  });

  it("stdio：command + args + env 一起过去", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run(
      { id: "fs", kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "v" } },
      world(c)
    );
    expect(c.configure).toHaveBeenCalledWith("fs", {
      kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "v" }, enabled: true,
    });
  });

  it("remove：传 null 给 configure", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run({ id: "s", action: "remove" }, world(c));
    expect(c.configure).toHaveBeenCalledWith("s", null);
  });

  it("id 缺失/不是字符串 → 抛人话，不把垃圾写进配置", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ kind: "http", url: "https://x" }, world(c)))
      .rejects.toThrow(/id/);
    expect(c.configure).not.toHaveBeenCalled();
  });

  it("http 少了 url → 抛人话", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http" }, world(c)))
      .rejects.toThrow(/url/);
  });

  it("stdio 少了 command → 抛人话", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "stdio" }, world(c)))
      .rejects.toThrow(/command/);
  });

  it("url 不是 http/https → 拒绝（file:// 之类没有意义，且是个惊喜面）", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http", url: "file:///etc/passwd" }, world(c)))
      .rejects.toThrow(/http/);
  });

  it("world 没有 mcp 能力时给人话", async () => {
    await expect(createMcpConfigureTool(cap()).run({ id: "s", action: "remove" }, {} as ExecutionWorld))
      .rejects.toThrow(/MCP/);
  });

  // Task 9 审查 Critical 1：WHATWG 的 URL 解析器会在解析**之前**把 ASCII
  // tab/CR/LF 悄悄剥掉——"https://good.com" + 30 个换行 + "@evil.com/mcp"
  // 解析出的 host 是 evil.com。如果这串带隐藏换行的原始字符串被原样写盘/
  // 显示在审批卡上，用户看到的和实际连接的是两个不同的主机。必须在解析前
  // 直接拒绝，不能静默归一化（静默归一化=把攻击伪装成一次系统自动改写）。
  it("url 里藏着换行把主机改写成别的域名 → 拒绝，不落盘（Critical 1 回归）", async () => {
    const c = cap();
    const malicious = "https://good.com" + "\n".repeat(30) + "@evil.com/mcp";
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http", url: malicious }, world(c)))
      .rejects.toThrow(/换行/);
    expect(c.configure).not.toHaveBeenCalled();
  });

  it("url 里藏着制表符同样能改写主机 → 拒绝（tab 变体）", async () => {
    const c = cap();
    const malicious = "https://good.com\t@evil.com/mcp";
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http", url: malicious }, world(c)))
      .rejects.toThrow(/制表符|换行/);
    expect(c.configure).not.toHaveBeenCalled();
  });

  // Task 9 复审 Critical A：把控制字符那条路堵上之后，同一个漏洞换个填充
  // 字符仍然完全可利用——不需要任何控制字符。
  // "https://mcp.supabase.com" + "." * 1400 + "@evil.com/mcp" 解析出的
  // host 是 evil.com，而这个 href 逐字节等于输入本身（没有隐藏字符可剥），
  // 审批卡折叠线以上看到的却是 "https://mcp.supabase.com...."。
  it("url 用超长点号填充把主机藏进 userinfo → 拒绝，不落盘（Critical A 回归）", async () => {
    const c = cap();
    const malicious = "https://mcp.supabase.com" + ".".repeat(1400) + "@evil.com/mcp";
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http", url: malicious }, world(c)))
      .rejects.toThrow(/用户名|密码/);
    expect(c.configure).not.toHaveBeenCalled();
  });

  // 终审 B Important：新工具要到下一个 turn 才进模型的工具表
  // （engine.rebuildTools()）。旧文案"可用工具 3 个：list_tables、…"是在
  // 鼓励模型这一轮就调它们，而这一轮它们根本不存在——命中的是"未知工具"，
  // 逃生舱 tool_search 也不通（listDeferred 闭包捕获的是这一轮的 list）。
  // 断关键子串不断整句，否则改一次文案就脆
  it("连上之后的文案说清「下一轮才生效」，别鼓励模型这一轮就调", async () => {
    const c = cap({
      servers: () => [{ id: "supabase", name: "supabase", status: "connected", live: true,
        tools: [
          { name: "list_tables", description: "", inputSchema: {} },
          { name: "execute_sql", description: "", inputSchema: {} },
        ], resources: [], prompts: [] }],
    });
    const out = String(
      await createMcpConfigureTool(c).run(
        { id: "supabase", kind: "http", url: "https://mcp.supabase.com/mcp" },
        world(c)
      )
    );
    // 工具名照旧要说（用户要知道接上了什么）……
    expect(out).toContain("list_tables");
    // ……但必须紧跟着"什么时候能用"
    expect(out).toContain("下一条消息");
    expect(out).toContain("不要在这一轮直接调用");
  });
});
