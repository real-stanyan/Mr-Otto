import { describe, it, expect, vi } from "vitest";
import {
  withAbortSignal,
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
