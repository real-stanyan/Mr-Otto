// spec §7 头两条安全不变量的可执行版（终审 A）：
//   ① OAuth token 不进事件日志（append-only，进去 = 永久泄漏，删不掉）
//   ② OAuth token 不过 ShellBridge 回渲染层
//
// 这两条目前靠**结构性保证**成立——McpAuthRecord 这个类型在 src/session/ 和
// src/shared/shellBridge.ts 里根本不出现（tests/architecture.test.ts 里那条
// import 断言守的就是这个）。结构性保证是好的，但它正是那种会被一次无心的
// 字段扩充悄悄推翻、且没有任何东西会变红的保证。
//
// 所以这里换一把尺子：把一串独一无二的 token 真的写进 mcp-auth.json，让它
// 沿着真实路径（授权 → 落盘 → 重连 → 工具返回 → 事件落盘）走一遍，然后断言
// 它在两个出口的**全文**里都不出现。手法抄 approvalPreview.test.ts 里的
// `expect(JSON.stringify(preview)).not.toContain("sk-真的")`，只是把出口
// 换成"过桥的快照"和"一次会话的完整日志"。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMcpHub, type McpHub } from "../../src/main/mcpHub.js";
import { readMcpAuth, writeMcpAuth, clearMcpAuth } from "../../src/main/mcpAuthStore.js";
import type { McpClientConn } from "../../src/main/mcpClient.js";
import type { McpServerConfig, McpServersSnapshot } from "../../src/shared/mcp.js";
import { createAgent, type AgentPush } from "../../src/main/agent.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import { tempDir } from "../helpers/tempDir.js";

/** 独一无二的一串——它在这个仓库里除了这份测试之外不该出现在任何地方 */
const TOKEN = "mcp-oauth-token-绝不能外泄-2f8c41d9";

const push: AgentPush = {
  event: () => {}, approvalRequest: () => {}, askUserRequest: () => {},
  assistantDelta: () => {}, toolOutput: () => {},
};
const attachments = new AttachmentStore(tempDir("otter-mcp-auth-noleak-"));

let dir: string;
let authPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-noleak-"));
  authPath = join(dir, "mcp-auth.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const http: McpServerConfig = {
  kind: "http", url: "https://mcp.supabase.com/mcp", headers: {}, enabled: true,
};

/** 与 src/main/index.ts 同形的装配：connect 读凭据（真实现把它交给
    createOAuthProvider），authorize 跑完一次授权把 token 落盘（真实现是
    mcpClient.authorizeMcpServer 的 write 回调），clearAuth 删记录。
    token 因此真的在这条管线里流过，不是摆在一边的道具。 */
function hubWithAuth(): { hub: McpHub; seenByConnect: string[] } {
  const seenByConnect: string[] = [];
  let servers: Record<string, McpServerConfig> = { supabase: http };
  const hub = createMcpHub({
    load: () => ({ servers, errors: [], unrecognizedIds: [], fatal: false }),
    save: (next) => { servers = { ...next }; },
    connect: async (id): Promise<McpClientConn> => {
      // 真 connect 就是在这一步把凭据记录交给 SDK 的 OAuth provider
      const record = readMcpAuth(authPath, id);
      seenByConnect.push(JSON.stringify(record));
      return {
        tools: [{ name: "list_tables", description: "列出表", inputSchema: {} }],
        resources: [], prompts: [],
        callTool: async () => [{ kind: "text", text: "public.users" }],
        readResource: async () => [], getPrompt: async () => "",
        onListChanged: () => {}, close: async () => {}, kill: () => {},
      };
    },
    authorize: async (id) => { writeMcpAuth(authPath, id, { tokens: { access_token: TOKEN } }); },
    clearAuth: (id) => { clearMcpAuth(authPath, id); },
  });
  return { hub, seenByConnect };
}

/** 假模型：第一轮先 tool_search 把 deferred 的 mcp_authorize 曝光出来，
    第二轮真的调它，第三轮收口 */
function authorizeThenTalk(): ModelAdapter {
  let step = 0;
  return {
    model: "fake-model",
    async chat(): Promise<ModelReply> {
      step++;
      if (step === 1) {
        return { content: "", toolCalls: [{ id: "c1", name: "tool_search", args: { query: "mcp_authorize" } }] };
      }
      if (step === 2) {
        return { content: "", toolCalls: [{ id: "c2", name: "mcp_authorize", args: { id: "supabase" } }] };
      }
      return { content: "supabase 接好了" };
    },
  };
}

describe("spec §7：OAuth token 既不过桥，也不进事件日志", () => {
  it("token 确实流经了这条管线（不然下面两条是空断言）", async () => {
    const { hub, seenByConnect } = hubWithAuth();
    await hub.ready();
    await hub.authorize("supabase");
    // authorize 落盘 → reconnectOne 重连 → connect 读到了带 token 的记录
    expect(seenByConnect.join("")).toContain(TOKEN);
    await hub.closeAll();
  });

  it("过桥的 MCP 快照全文里没有 token", async () => {
    const { hub } = hubWithAuth();
    await hub.ready();
    await hub.authorize("supabase");
    // 与 src/main/index.ts 的 mcpSnapshot() 同一份形状
    const snapshot: McpServersSnapshot = { servers: hub.list(), errors: hub.configErrors() };
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    await hub.closeAll();
  });

  it("一次会话日志的全文里没有 token", async () => {
    const { hub } = hubWithAuth();
    await hub.ready();

    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: hub });
    agent.engine.setAdapter(authorizeThenTalk());
    await agent.engine.runTurn("帮我接上 supabase");

    // 这一轮真的跑完了授权（否则日志里没 token 只是因为什么都没发生）
    expect(readMcpAuth(authPath, "supabase").tokens).toEqual({ access_token: TOKEN });
    // 日志是 append-only 的：一条都不能含 token，包括工具返回、事件参数、错误文本
    const log = store.load(agent.sessionId);
    expect(log.length).toBeGreaterThan(1);
    expect(JSON.stringify(log)).not.toContain(TOKEN);

    store.close();
    await hub.closeAll();
  });
});
