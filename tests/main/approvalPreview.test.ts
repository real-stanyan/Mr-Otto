import { describe, expect, it } from "vitest";
import { buildApprovalPreview } from "../../src/main/approvalPreview.js";
import type { ExecutionWorld, McpServerHandle } from "../../src/world/executionWorld.js";
import { mcpToolName } from "../../src/shared/mcp.js";
import type { McpServerConfig } from "../../src/shared/mcp.js";

function worldWith(files: Record<string, string>): ExecutionWorld {
  return {
    fs: {
      async read(path) {
        const content = files[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      async write() {},
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    http: { postJson: async () => ({}) },
  };
}

describe("buildApprovalPreview", () => {
  it("write_file 覆盖已有文件 → 旧内容随预览出场", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "a.txt", content: "新" } },
      worldWith({ "a.txt": "旧" })
    );
    expect(preview).toEqual({ kind: "write_file", path: "a.txt", oldText: "旧", newText: "新" });
  });

  it("目标不存在 → oldText 为 null（新文件），预览失败不挡审批", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "new.txt", content: "内容" } },
      worldWith({})
    );
    expect(preview).toEqual({ kind: "write_file", path: "new.txt", oldText: null, newText: "内容" });
  });

  it("非 write_file（bash 等）→ 无预览，审批卡走 JSON 兜底", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "bash", args: { cmd: "rm -rf /" } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });

  it("参数出自模型，形状不对不赌：缺 path/content 就不预览", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: 42 } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });

  it("超大内容 → 放弃预览（IPC 别扛巨物）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "big.txt", content: "x".repeat(300_000) } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });
});

// issue #157：MCP 工具的审批卡从前是 `mcp__github__create_pr` + 一坨原始 JSON。
// 预览把它拆回"哪台 server 的哪把刀 + 参数表"——server/tool 只能由主进程在还
// 知道两截的时候拆好，工具名那一路是有损收口（净化 + 截断 + 指纹），反推不回去
describe("buildApprovalPreview：MCP 工具", () => {
  const mcpWorld = (over: Partial<McpServerHandle> = {}): ExecutionWorld => ({
    ...worldWith({}),
    mcp: {
      ready: async () => {},
      servers: () => [{
        id: "gh", name: "gh", status: "connected", live: true,
        tools: [{ name: "create_pr", description: "开 PR", inputSchema: {} }],
        resources: [], prompts: [],
        ...over,
      }],
      callTool: async () => [],
      readResource: async () => [],
      getPrompt: async () => "",
      configure: async () => {},
      authorize: async () => {},
      configOf: () => undefined,
    },
  });

  it("认出是哪台 server 的哪把刀，参数摊平成一格一项", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: { title: "加个功能", draft: true } },
      mcpWorld()
    );
    expect(preview).toEqual({
      kind: "mcp_tool",
      server: "gh",
      tool: "create_pr",
      description: "开 PR",
      args: [
        { name: "title", value: "加个功能", truncated: false, fullLength: 4 },
        { name: "draft", value: "true", truncated: false, fullLength: 4 },
      ],
    });
  });

  it("字符串参数原样，其余 JSON 序列化（卡上不显示引号包着的中文）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: { s: "纯文本", n: 42, o: { a: 1 } } },
      mcpWorld()
    );
    expect(preview?.kind === "mcp_tool" && preview.args.map((a) => a.value)).toEqual([
      "纯文本", "42", '{"a":1}',
    ]);
  });

  it("超长参数在主进程就截断，并说出原长（IPC 别扛巨物）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: { body: "x".repeat(5_000) } },
      mcpWorld()
    );
    expect(preview?.kind === "mcp_tool" && preview.args[0]).toEqual({
      name: "body", value: "x".repeat(2_000), truncated: true, fullLength: 5_000,
    });
  });

  it("没有参数 = 空数组，不是 undefined（卡上要说得出「这次调用没有参数」）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: {} },
      mcpWorld()
    );
    expect(preview?.kind === "mcp_tool" && preview.args).toEqual([]);
  });

  it("参数根本不是对象时不硬拆，整体记成一项", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: ["a", "b"] as unknown as Record<string, unknown> },
      mcpWorld()
    );
    expect(preview?.kind === "mcp_tool" && preview.args).toEqual([
      { name: "参数", value: '["a","b"]', truncated: false, fullLength: 9 },
    ]);
  });

  it("清单里找不到这把刀（server 刚掉线）→ 不预览，审批卡照常弹", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__gone", args: {} },
      mcpWorld()
    );
    expect(preview).toBeUndefined();
  });

  it("world 里压根没有 mcp 能力 → 不预览", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: {} },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });

  it("server id 需要净化时也认得出来（工具名有损，靠正着算而不是反推）", async () => {
    const world: ExecutionWorld = {
      ...worldWith({}),
      mcp: {
        ready: async () => {},
        servers: () => [{
          id: "my.server", name: "my.server", status: "connected", live: true,
          tools: [{ name: "do.thing", description: "", inputSchema: {} }],
          resources: [], prompts: [],
        }],
        callTool: async () => [],
        readResource: async () => [],
        getPrompt: async () => "",
        configure: async () => {},
        authorize: async () => {},
        configOf: () => undefined,
      },
    };
    const preview = await buildApprovalPreview(
      { id: "c1", name: mcpToolName("my.server", "do.thing"), args: {} },
      world
    );
    expect(preview).toMatchObject({ kind: "mcp_tool", server: "my.server", tool: "do.thing" });
  });
});

// Task 9：mcp_configure 的审批预览。这张卡是"agent 自助配置 MCP server"这条路上
// 唯一的安全闸——worldWithMcp 造一个带假 mcp 能力的 world，configOf 从传入的
// map 里取（对照"改之前是什么"），servers() 按 map 造 handle（每台配一把工具，
// 用来算 before.toolCount）
function worldWithMcp(configs: Record<string, McpServerConfig> = {}): ExecutionWorld {
  return {
    ...worldWith({}),
    mcp: {
      ready: async () => {},
      servers: () =>
        Object.keys(configs).map((id) => ({
          id, name: id, status: "connected", live: true,
          tools: [{ name: "t", description: "", inputSchema: {} }],
          resources: [], prompts: [],
        })),
      callTool: async () => [],
      readResource: async () => [],
      getPrompt: async () => "",
      configure: async () => {},
      authorize: async () => {},
      configOf: (id: string) => configs[id],
    },
  };
}

describe("mcp_configure 的审批预览", () => {
  it("stdio：command / 每一条 arg / env 的键名都列出来，值不列", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "sk-真的" } } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({
      kind: "mcp_configure", server: "fs", action: "add",
      transport: "stdio", command: "npx", args: ["-y", "pkg"],
      credentialKeys: ["TOKEN"],
    });
    expect(JSON.stringify(preview)).not.toContain("sk-真的");
  });

  it("http：url 全文出现在卡片上——用户要看得到自己在授权给谁", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://mcp.supabase.com/mcp" } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", url: "https://mcp.supabase.com/mcp" });
  });

  it("改已有的一台时带上「改之前是什么」", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://新的/mcp" } },
      worldWithMcp({ s: { kind: "http", url: "https://旧的/mcp", headers: {}, enabled: true } })
    );
    expect(preview).toMatchObject({ action: "update", before: { url: "https://旧的/mcp" } });
  });

  it("删除时说清删的是哪台、它现在有几把刀", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", action: "remove" } },
      worldWithMcp({ s: { kind: "http", url: "https://旧的/mcp", headers: {}, enabled: true } })
    );
    expect(preview).toMatchObject({ action: "remove", server: "s" });
  });

  // Task 9 审查 Important 1：args 必须留在数组里、一格一项，不能在预览这一层
  // 就被 join 成一句话——`["-y", "some pkg"]` 和 `["-y", "some", "pkg"]` join
  // 之后长得一模一样，用户分不清是一个参数还是两个。渲染层（App.tsx 的
  // McpConfigureApproval）逐项建行，前提是这里给的就是逐项的数组。
  it("args 保持数组、逐项分开，不折成一个 join 后的字符串", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", args: ["-y", "some pkg"] } },
      worldWithMcp()
    );
    expect(preview?.kind === "mcp_configure" && preview.args).toEqual(["-y", "some pkg"]);
  });

  // Task 9 复审 Critical A：host 是独立算出来的字段（`URL.host`），不是从
  // url 字符串里现切的——即便 url 那一行以后被截断/变形，这一行必须永远
  // 是解析器实际会连接的主机。
  it("host 是从 url 独立解析出来的字段，不是从 url 串里现切", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://mcp.supabase.com/mcp" } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", host: "mcp.supabase.com" });
  });

  // Task 9 复审 Critical A：换个填充字符（点号代替换行）的同一个漏洞——
  // 预览层不应该被这种输入骗到显示一个"看起来干净"的 url。host 字段必须
  // 露出真实主机 evil.com，且 url 字段（归一化后）也应该等于真实 href。
  it("userinfo 填充攻击：host 字段露出真实主机，不被点号填充骗过", async () => {
    const malicious = "https://mcp.supabase.com" + ".".repeat(1400) + "@evil.com/mcp";
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: malicious } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", host: "evil.com" });
  });
});
