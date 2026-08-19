import { describe, it, expect, vi } from "vitest";
import {
  withAbortSignal,
  withBrowser,
  withExecOutput,
  type ExecutionWorld,
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
