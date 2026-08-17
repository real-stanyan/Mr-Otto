import { describe, it, expect } from "vitest";
import { bashTool } from "../../src/tools/bash.js";
import type { ExecutionWorld, ExecResult } from "../../src/world/executionWorld.js";

/** 假 world：exec 回放预设结果，顺带记录收到的命令 */
function fakeWorld(result: ExecResult) {
  const calls: string[] = [];
  const world: ExecutionWorld = {
    fs: {
      read: () => Promise.reject(new Error("bash 测试不该碰 fs")),
      write: () => Promise.reject(new Error("bash 测试不该碰 fs")),
    },
    exec: async (cmd) => {
      calls.push(cmd);
      return result;
    },
    http: { postJson: async () => ({}) },
  };
  return { world, calls };
}

describe("bash 工具", () => {
  it("命令经 world.exec 执行，stdout 和退出码拼进输出", async () => {
    const { world, calls } = fakeWorld({ stdout: "hello\n", stderr: "", exitCode: 0 });
    const out = await bashTool.run({ cmd: "echo hello" }, world);
    expect(calls).toEqual(["echo hello"]);
    expect(out).toContain("exit code: 0");
    expect(out).toContain("hello");
  });

  it("exitCode ≠ 0 不 throw：非零退出是世界的正常反馈，不是工具故障", async () => {
    const { world } = fakeWorld({ stdout: "", stderr: "not found", exitCode: 1 });
    const out = await bashTool.run({ cmd: "grep xxx file" }, world);
    expect(out).toContain("exit code: 1");
    expect(out).toContain("not found");
  });

  it("空 stdout/stderr 段不输出标签，省上下文", async () => {
    const { world } = fakeWorld({ stdout: "ok\n", stderr: "", exitCode: 0 });
    const out = await bashTool.run({ cmd: "true" }, world);
    expect(out).not.toContain("stderr:");
  });

  it("超长输出截断并标注原始长度", async () => {
    const { world } = fakeWorld({ stdout: "x".repeat(20_000), stderr: "", exitCode: 0 });
    const out = await bashTool.run({ cmd: "cat big" }, world);
    expect(out.length).toBeLessThan(10_000);
    expect(out).toContain("截断，共 20000 字符");
  });

  it("cmd 非法（空/非字符串）→ throw（这才是管线故障）", async () => {
    const { world, calls } = fakeWorld({ stdout: "", stderr: "", exitCode: 0 });
    await expect(bashTool.run({ cmd: "   " }, world)).rejects.toThrow(/非空字符串/);
    await expect(bashTool.run({}, world)).rejects.toThrow(/非空字符串/);
    expect(calls).toEqual([]); // 没碰到 exec
  });

  it("requiresApproval = true：最危险的工具必须过门", () => {
    expect(bashTool.requiresApproval).toBe(true);
  });
});
