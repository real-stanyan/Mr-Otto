// 强化 L1 专员（#1659）：线上日志里专员反复卡的三处，各钉一条。
import { describe, expect, it } from "vitest";
import { createWikiService, type WikiAuthor } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { createTaskTools } from "../../services/runtime/src/taskTools.js";
import { agentPagePath, classifyWikiPath, isOwnAgentPage, renderWikiPrompt } from "../../src/shared/wiki.js";
import { tierPrompt } from "../../src/shared/tierPrompt.js";
import { bashTool } from "../../src/tools/bash.js";
import { foldTask, type TaskRow } from "../../src/shared/tasks.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ExecutionWorld, ExecResult } from "../../src/world/executionWorld.js";

const SPEC_ID = "a_642f0e7623b8";

describe("bash 收下 command 这个别名", () => {
  it("cmd 缺、command 有 → 照跑；两个都有以 cmd 为准；都空照旧报错", async () => {
    const calls: string[] = [];
    const world = {
      exec: async (c: string): Promise<ExecResult> => { calls.push(c); return { stdout: "ok\n", stderr: "", exitCode: 0 }; },
    } as unknown as ExecutionWorld;
    expect(await bashTool.run({ command: "ls /work" }, world)).toContain("exit code: 0");
    await bashTool.run({ cmd: "echo a", command: "echo b" }, world);
    expect(calls).toEqual(["ls /work", "echo a"]);
    await expect(bashTool.run({ command: "  " }, world)).rejects.toThrow(/非空字符串/);
  });
});

describe("专员自己的 wiki 页", () => {
  it("a_<hex> 的页路径是合法的 kebab，提示词里给的就是这条", () => {
    const p = agentPagePath(SPEC_ID);
    expect(p).toBe("agents/a-642f0e7623b8.md");
    expect(classifyWikiPath(p)).toBe("page");
    expect(isOwnAgentPage(p, SPEC_ID)).toBe(true);
    expect(isOwnAgentPage("agents/admin.md", SPEC_ID)).toBe(false);
    expect(agentPagePath("admin")).toBe("agents/admin.md"); // 管理员那页不搬家
    const prompt = renderWikiPrompt({ agentId: SPEC_ID, agentName: "应用专员", index: "", pinned: [], own: null, nudge: null });
    expect(prompt).toContain("wiki write agents/a-642f0e7623b8.md");
  });

  it("专员能写、能删自己那页，下一轮注入；写别人的页被拒并告诉它自己那页在哪", async () => {
    const fs = createMemoryWikiFs();
    const svc = createWikiService({
      workspaceId: "w1", fs, journal: createInMemoryWikiJournal(),
      legacyMemories: async () => [], agentNames: async () => new Map([[SPEC_ID, "应用专员"]]),
      isRunning: async () => true, now: () => Date.UTC(2026, 9, 5), log: () => {},
    });
    await svc.ensure();
    const me: WikiAuthor = { kind: "agent", id: SPEC_ID, label: "应用专员" };
    await svc.write({ path: "agents/a-642f0e7623b8.md", title: "应用专员", summary: "", body: "数据走 window.otto.storage" }, me);
    expect((await svc.snapshot(SPEC_ID, { nudge: false })).own).toContain("window.otto.storage");
    await expect(svc.write({ path: "agents/admin.md", title: "x", summary: "", body: "偷改" }, me)).rejects.toThrow("你自己那页是 agents/a-642f0e7623b8.md");
    await svc.remove("agents/a-642f0e7623b8.md", me);
  });
});

describe("管理员不在这条对话里时，专员往上转的路是主人", () => {
  const admin = { agentId: "admin", name: "雨姐", tier: 0 as const, domain: "admin" };
  const apps = { agentId: SPEC_ID, name: "应用专员", tier: 1 as const, domain: "apps" };

  it("提示词：管理员在场照旧 @ 它；不在场说清 @ 不到、写好一句让主人转；都提醒记自己那页", () => {
    const withAdmin = tierPrompt({ agent: apps, ownerName: "主人", roster: [admin, apps] });
    expect(withAdmin).toContain("@雨姐 转过去");
    expect(withAdmin).not.toContain("管理员不在这条对话里");
    const alone = tierPrompt({ agent: apps, ownerName: "主人", roster: [apps] });
    expect(alone).toContain("管理员不在这条对话里");
    expect(alone).toContain("别 create_task 派给管理员");
    expect(alone).not.toContain("转过去，别自己接");
    for (const p of [withAdmin, alone]) expect(p).toContain("记进你自己的 wiki 页");
    // #1661 C5：需求要联网的先顶回去，别写 fetch 等 build_app 拒
    expect(withAdmin).toContain("build_app 会拒，先回报管理员说做不到和替代方案");
    // #1661 C8：专员以为 storage 是浏览器本地、退到 localStorage，还把「换设备会丢」写进了常驻的 team.md
    expect(withAdmin).toContain("storage 存在 Otto 云端");
    expect(withAdmin).toContain("otto.room"); // #1675
  });

  it("assign_task：专员派给不在场的 → 告诉它用 escalate_to_admin，不叫它 bring_agent；管理员照旧提示 bring_agent", async () => {
    const fold = new Map<string, TaskRow>();
    let seq = 0;
    const toolsFor = (agentId: string) => createTaskTools({
      agentId, roster: () => (agentId === "admin" ? [admin] : [apps]), tasks: () => fold, newId: () => `t_${++seq}`,
      append: (e) => foldTask(fold, { sessionId: "s1", seq: ++seq, ts: seq, ignorable: true, byAgentId: agentId, ...e } as SessionEvent, "w1"),
    });
    const [create, assign] = toolsFor(SPEC_ID);
    await create!.run({ title: "到点打电话" }, {} as ExecutionWorld);
    const id = [...fold.keys()][0]!;
    const err = await assign!.run({ taskId: id, to: "管理员" }, {} as ExecutionWorld).catch((e: Error) => e.message);
    expect(err).toContain("escalate_to_admin");
    expect(err).not.toContain("bring_agent");
    const [, adminAssign] = toolsFor("admin");
    await expect(adminAssign!.run({ taskId: id, to: "出行" }, {} as ExecutionWorld)).rejects.toThrow("bring_agent");
  });
});
