import { describe, it, expect } from "vitest";
import { bashTool, createBashTool } from "../../src/tools/bash.js";
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

  it("超长输出中间截断:头尾都在,警告头带原始字符数与估算 token(issue #343 第三层)", async () => {
    const head = "HEAD-MARK" + "x".repeat(10_000);
    const tail = "y".repeat(9_000) + "TAIL-MARK";
    const { world } = fakeWorld({ stdout: head + tail, stderr: "", exitCode: 0 });
    const out = (await bashTool.run({ cmd: "cat big" }, world)) as string;
    expect(out.length).toBeLessThan(10_000);
    expect(out).toContain("HEAD-MARK"); // 头 = 启动报错
    expect(out).toContain("TAIL-MARK"); // 尾 = 最终结果(旧实现只留头,尾全丢)
    expect(out).toContain("原始 19018 字符");
    expect(out).toMatch(/≈ \d+ tokens/); // 模型知道被截、知道原本多大
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

  // ── 沙箱 enforcement 事实上报（issue #389）────────────────
  // 生产者是 v2 SandboxWorld；v1 这里钉住的是消费侧协议（ADR-0083「协议即测试」同款）

  it("sandbox 字段缺席：输出与从前逐字节一致（v1 LocalWorld 永远走这条）", async () => {
    const { world } = fakeWorld({ stdout: "hello\n", stderr: "", exitCode: 0 });
    const out = await bashTool.run({ cmd: "echo hello" }, world);
    expect(out).toBe("exit code: 0\nstdout:\nhello");
  });

  it("沙箱拦截/异常事实摆到模型眼前，拦截与异常措辞分开", async () => {
    const { world } = fakeWorld({
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
      sandbox: {
        enforcement: "partial",
        denials: ["写 /etc/hosts 被拒"],
        failures: ["seccomp profile 加载失败"],
      },
    });
    const out = (await bashTool.run({ cmd: "deploy" }, world)) as string;
    expect(out).toContain("[沙箱] enforcement: partial");
    expect(out).toContain("[沙箱拦截] 写 /etc/hosts 被拒");
    expect(out).toContain("[沙箱异常] seccomp profile 加载失败");
    // 事实行在 stdout 段之前——正常输出再长也埋不掉它
    expect(out.indexOf("[沙箱拦截]")).toBeLessThan(out.indexOf("stdout:"));
  });

  it("enforcement: full 且无拦截无异常：不加噪音行", async () => {
    const { world } = fakeWorld({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      sandbox: { enforcement: "full" },
    });
    const out = (await bashTool.run({ cmd: "ls" }, world)) as string;
    expect(out).not.toContain("[沙箱");
    expect(out).toBe("exit code: 0\nstdout:\nok");
  });

  // ── 后台执行（issue #389）────────────────────────────────

  it("默认 bashTool：参数表不宣称 run_in_background，传了也拒（无登记口）", async () => {
    const props = (bashTool.def.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty("run_in_background");
    const { world } = fakeWorld({ stdout: "", stderr: "", exitCode: 0 });
    await expect(bashTool.run({ cmd: "ls", run_in_background: true }, world)).rejects.toThrow(
      /不支持后台执行/
    );
  });

  it("带登记口且 armed：立即返回任务 id，走 execDetached 不走 exec", async () => {
    const started: string[] = [];
    const tool = createBashTool({
      armed: true,
      start: (cmd) => {
        started.push(cmd);
        return "bg-1";
      },
    });
    const props = (tool.def.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("run_in_background");

    const { world, calls } = fakeWorld({ stdout: "", stderr: "", exitCode: 0 });
    world.execDetached = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const out = await tool.run({ cmd: "npm run build", run_in_background: true }, world);
    expect(out).toContain("bg-1");
    expect(started).toEqual(["npm run build"]);
    expect(calls).toEqual([]); // 前台 exec 没被碰
  });

  it("登记口未接线（armed=false，subagent 装配）：拒绝而不是丢结果", async () => {
    const tool = createBashTool({ armed: false, start: () => "bg-x" });
    const { world } = fakeWorld({ stdout: "", stderr: "", exitCode: 0 });
    world.execDetached = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    await expect(tool.run({ cmd: "ls", run_in_background: true }, world)).rejects.toThrow(
      /不支持后台执行/
    );
  });

  it("world 无 execDetached 能力：拒绝（装配没有后台执行的世界）", async () => {
    const tool = createBashTool({ armed: true, start: () => "bg-x" });
    const { world } = fakeWorld({ stdout: "", stderr: "", exitCode: 0 });
    await expect(tool.run({ cmd: "ls", run_in_background: true }, world)).rejects.toThrow(
      /不支持后台执行/
    );
  });

  it("沙箱事实行不进截断预算：超长输出被截，事实行完好", async () => {
    const { world } = fakeWorld({
      stdout: "x".repeat(20_000),
      stderr: "",
      exitCode: 0,
      sandbox: { enforcement: "full", denials: ["读 ~/.ssh 被拒"] },
    });
    const out = (await bashTool.run({ cmd: "cat big" }, world)) as string;
    expect(out).toContain("输出被中间截断");
    expect(out).toContain("[沙箱拦截] 读 ~/.ssh 被拒");
  });
});
