import { describe, it, expect, vi } from "vitest";
import {
  withAbortSignal,
  withBrowser,
  withExecOutput,
  withMcp,
  type ExecutionWorld,
  type McpCapability,
  type TerminalSession,
} from "../../src/world/executionWorld.js";

/** 最小假 world：只关心装饰器有没有把字段原样带过去 */
function fakeWorld(openTerminal?: ExecutionWorld["openTerminal"]): ExecutionWorld {
  return {
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
    ...(openTerminal ? { openTerminal } : {}),
  };
}

const fakeSession = (): TerminalSession => ({
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => () => {},
  onExit: () => () => {},
});

describe("装饰器透传 openTerminal", () => {
  it("withAbortSignal 保住终端能力", async () => {
    const open = vi.fn(async () => fakeSession());
    const wrapped = withAbortSignal(fakeWorld(open), new AbortController().signal);
    expect(wrapped.openTerminal).toBeTypeOf("function");
    await wrapped.openTerminal!({ cols: 80, rows: 24 });
    expect(open).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it("withExecOutput 保住终端能力", async () => {
    const open = vi.fn(async () => fakeSession());
    const wrapped = withExecOutput(fakeWorld(open), () => {});
    expect(wrapped.openTerminal).toBeTypeOf("function");
    await wrapped.openTerminal!({ cols: 100, rows: 30 });
    expect(open).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it("世界本来就没有终端能力时，装饰后依然没有（不凭空造一个）", () => {
    const wrapped = withAbortSignal(fakeWorld(), new AbortController().signal);
    expect(wrapped.openTerminal).toBeUndefined();
  });
});

describe("browser 能力（可选）", () => {
  const fakeBrowser = { read: vi.fn(async () => ({ url: "u", title: "t", text: "x", truncated: false })) };

  it("withBrowser 把能力焊上去，其余面原样", async () => {
    const w = withBrowser(fakeWorld(), fakeBrowser);
    expect(w.browser).toBeDefined();
    await w.browser!.read({ url: "https://a" });
    expect(fakeBrowser.read).toHaveBeenCalledWith({ url: "https://a" });
  });

  it("withAbortSignal 透传 browser 并把信号焊进 read —— "
     + "漏了这条,turn 中断时页面还在加载,工具挂到超时才回来", async () => {
    const ac = new AbortController();
    const w = withAbortSignal(withBrowser(fakeWorld(), fakeBrowser), ac.signal);
    await w.browser!.read({ url: "https://b" });
    expect(fakeBrowser.read).toHaveBeenLastCalledWith({ url: "https://b", signal: ac.signal });
  });

  it("withExecOutput 原样透传 browser", () => {
    const w = withExecOutput(withBrowser(fakeWorld(), fakeBrowser), () => {});
    expect(w.browser).toBeDefined();
  });

  it("没有 browser 的 world 过装饰器后仍然没有 —— 可选就是可选，不能凭空长出来", () => {
    expect(withAbortSignal(fakeWorld(), new AbortController().signal).browser).toBeUndefined();
    expect(withExecOutput(fakeWorld(), () => {}).browser).toBeUndefined();
  });
});

const fakeMcp = (): McpCapability => ({
  ready: async () => {},
  servers: () => [
    {
      id: "github",
      name: "github",
      status: "connected",
      live: true,
      tools: [{ name: "create_pr", description: "开 PR", inputSchema: {} }],
      resources: [],
      prompts: [],
    },
  ],
  callTool: async () => [{ kind: "text", text: "ok" }],
  readResource: async () => [{ kind: "text", text: "料" }],
  getPrompt: async () => "展开后的提示词",
});

describe("装饰器透传 mcp", () => {
  it("withMcp 焊上能力", () => {
    const w = withMcp(fakeWorld(), fakeMcp());
    expect(w.mcp?.servers()).toHaveLength(1);
  });

  it("withAbortSignal 保住 MCP 能力，并把 signal 绑进 callTool", async () => {
    const callTool = vi.fn(async () => [{ kind: "text" as const, text: "ok" }]);
    const ac = new AbortController();
    const w = withAbortSignal(withMcp(fakeWorld(), { ...fakeMcp(), callTool }), ac.signal);
    expect(w.mcp).toBeTypeOf("object");
    await w.mcp!.callTool("github", "create_pr", { a: 1 });
    expect(callTool).toHaveBeenCalledWith("github", "create_pr", { a: 1 }, ac.signal);
  });

  it("withAbortSignal 也把 signal 绑进 readResource", async () => {
    const readResource = vi.fn(async () => [{ kind: "text" as const, text: "料" }]);
    const ac = new AbortController();
    const w = withAbortSignal(withMcp(fakeWorld(), { ...fakeMcp(), readResource }), ac.signal);
    await w.mcp!.readResource("github", "file:///a");
    expect(readResource).toHaveBeenCalledWith("github", "file:///a", ac.signal);
  });

  it("withExecOutput 保住 MCP 能力 —— 它是逐字段重建 world 的，最容易漏", () => {
    const w = withExecOutput(withMcp(fakeWorld(), fakeMcp()), () => {});
    expect(w.mcp?.servers()).toHaveLength(1);
  });

  // issue #158：这条从前是按**值**断言 undefined —— 把 withExecOutput 里那句
  // 条件透传拍成无条件的 `mcp: world.mcp`，它照样绿（值仍然是 undefined），
  // 也就是说它测不出它存在的理由。exactOptionalPropertyTypes 下"键不存在"和
  // "键的值是 undefined"是两件事，断言必须落在键上
  it("世界本来没有 MCP 时，装饰后连这个键都不该有（不凭空造一个）", () => {
    const decorated = [
      withAbortSignal(fakeWorld(), new AbortController().signal),
      withExecOutput(fakeWorld(), () => {}),
    ];
    for (const w of decorated) {
      expect(Object.hasOwn(w, "mcp")).toBe(false);
      expect(w.mcp).toBeUndefined();
    }
  });

  // 同款：browser / openTerminal 走的是同一行条件透传的写法
  it("世界本来没有 browser / openTerminal 时，装饰后也不该冒出这两个键", () => {
    const w = withExecOutput(fakeWorld(), () => {});
    expect(Object.hasOwn(w, "browser")).toBe(false);
    expect(Object.hasOwn(w, "openTerminal")).toBe(false);
  });
});
