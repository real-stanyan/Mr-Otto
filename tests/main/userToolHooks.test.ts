import { describe, it, expect, vi } from "vitest";
import { buildUserToolHooks, type HookExec } from "../../src/main/userToolHooks.js";
import type { ToolCallContext } from "../../src/loop/middleware.js";
import type { UserHookDef } from "../../src/shared/userHooks.js";
import type { ExecResult } from "../../src/world/executionWorld.js";

function ctx(name = "bash", args: unknown = { cmd: "rm -rf build" }): ToolCallContext {
  return {
    call: { id: "call_1", name, args },
    tool: undefined,
    world: {} as ToolCallContext["world"],
    sessionId: "s-1",
  };
}

function fakeExec(result: ExecResult) {
  const calls: { cmd: string; stdin: string }[] = [];
  const exec: HookExec = async (cmd, o) => {
    calls.push({ cmd, stdin: o.stdin });
    return result;
  };
  return { exec, calls };
}

const preDef: UserHookDef = { name: "guard", phase: "pre", tools: ["bash"], command: "./g.sh" };
const postDef: UserHookDef = { name: "audit", phase: "post", tools: "*", command: "./a.sh" };

describe("buildUserToolHooks（issue #395）", () => {
  it("pre 钩子：stdin 收 JSON 上下文，stdout JSON 裁决翻成 block", async () => {
    const { exec, calls } = fakeExec({ stdout: '{"block":"不许删 build"}', stderr: "", exitCode: 0 });
    const [hook] = buildUserToolHooks([preDef], exec, "/ws");
    const r = await hook!.pre!(ctx());
    expect(r).toEqual({ block: "不许删 build" });
    const input = JSON.parse(calls[0]!.stdin) as Record<string, unknown>;
    expect(input).toEqual({
      phase: "pre", tool: "bash", toolCallId: "call_1",
      args: { cmd: "rm -rf build" }, workspace: "/ws",
    });
    expect(calls[0]!.cmd).toBe("./g.sh");
  });

  it("pre 钩子：reviseArgs 原样透传", async () => {
    const { exec } = fakeExec({ stdout: '{"reviseArgs":{"cmd":"rm -rf build/tmp"}}', stderr: "", exitCode: 0 });
    const [hook] = buildUserToolHooks([preDef], exec);
    const r = await hook!.pre!(ctx());
    expect(r).toEqual({ reviseArgs: { cmd: "rm -rf build/tmp" } });
  });

  it("exit 2 = 快捷否决：pre 翻成 block（stderr 作理由），post 翻成 reject", async () => {
    const pre = buildUserToolHooks([preDef], fakeExec({ stdout: "", stderr: "禁止", exitCode: 2 }).exec)[0]!;
    expect(await pre.pre!(ctx())).toEqual({ block: "禁止" });
    const post = buildUserToolHooks([postDef], fakeExec({ stdout: "", stderr: "结果不合规", exitCode: 2 }).exec)[0]!;
    expect(await post.post!(ctx(), { status: "ok", output: "x" })).toEqual({ reject: "结果不合规" });
  });

  it("其余非零 exit = 钩子自身失败，弃权（fail-open）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [hook] = buildUserToolHooks([preDef], fakeExec({ stdout: "", stderr: "boom", exitCode: 1 }).exec);
    expect(await hook!.pre!(ctx())).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("exit 0 且 stdout 不是裁决 JSON = 弃权", async () => {
    const [hook] = buildUserToolHooks([preDef], fakeExec({ stdout: "checked, fine\n", stderr: "", exitCode: 0 }).exec);
    expect(await hook!.pre!(ctx())).toBeUndefined();
  });

  it("post 钩子：stdin 带上执行结果；feedback 裁决透传", async () => {
    const { exec, calls } = fakeExec({ stdout: '{"feedback":"记得跑 lint"}', stderr: "", exitCode: 0 });
    const [hook] = buildUserToolHooks([postDef], exec, "/ws");
    const r = await hook!.post!(ctx("write_file", { path: "a.ts" }), { status: "ok", output: "已写入" });
    expect(r).toEqual({ feedback: "记得跑 lint" });
    const input = JSON.parse(calls[0]!.stdin) as Record<string, unknown>;
    expect(input["phase"]).toBe("post");
    expect(input["status"]).toBe("ok");
    expect(input["output"]).toBe("已写入");
  });

  it("exec 抛错（外力中断）= 弃权，不让钩子故障毒死 turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec: HookExec = async () => { throw new Error("aborted"); };
    const [hook] = buildUserToolHooks([preDef], exec);
    expect(await hook!.pre!(ctx())).toBeUndefined();
    warn.mockRestore();
  });

  it("声明的 phase 决定挂哪一侧：pre 钩子没有 post，post 钩子没有 pre", () => {
    const exec = fakeExec({ stdout: "", stderr: "", exitCode: 0 }).exec;
    const [pre] = buildUserToolHooks([preDef], exec);
    const [post] = buildUserToolHooks([postDef], exec);
    expect(pre!.pre).toBeDefined();
    expect(pre!.post).toBeUndefined();
    expect(post!.post).toBeDefined();
    expect(post!.pre).toBeUndefined();
    // tools 匹配表原样带过去（engine 的 hookMatches 消费）
    expect(pre!.tools).toEqual(["bash"]);
    expect(post!.tools).toBe("*");
  });
});
