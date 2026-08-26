import { describe, expect, it } from "vitest";
import { buildApprovalPreview } from "../../src/main/approvalPreview.js";
import type { ExecutionWorld, McpServerHandle } from "../../src/world/executionWorld.js";
import { mcpToolName } from "../../src/shared/mcp.js";

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
