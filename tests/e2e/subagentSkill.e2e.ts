// ADR-0122 D9（「子会话自己也拿得到 skill 工具」）的端到端守卫。
//
// 为什么单测不够，而且是**已经骗过一次**的那种不够：subagentRunner 的三条挂载
// 单测在内存里造 `def({ tools: ["read_file", "skill"] })` 然后断言挂上了——
// 三条全绿。但真实装配里 `skill ∉ TOOL_NAMES`（探针没接 skills），于是
// subagents.ts 解析用户那份 .md 时把 `skill` 当不认识的工具名滤掉，
// **那个形状根本产生不出来**。测试绿着，功能不存在。
//
// 所以这一条从磁盘上的一份 .md（和内置的 general-purpose）出发，看子会话的
// 请求体里到底有没有这把刀 —— 假模型收到的 `tools` 数组是唯一说了算的证据。

import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel, type FakeRequest } from "./fakeModel.js";

/** 只可能来自 SKILL.md 正文注入的一句话（同 skillAcquire.e2e.ts 的取舍：
    名字可能因为别的原因出现在消息里，正文不会） */
const MARKER = "e2e-demo 正文里的这句话只应该在子会话 acquire 之后出现。";

/** 父会话那一轮才带 task 工具（子 agent 不能再派子 agent） */
function isParentTurn(req: FakeRequest): boolean {
  return (req.tools ?? []).some((t) => t.function.name === "task");
}

function toolNames(req: FakeRequest): string[] {
  return (req.tools ?? []).map((t) => t.function.name);
}

function bodyOf(req: FakeRequest): string {
  return req.messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

test("手写定义里的 `tools: read_file, skill` 真的挂得上：子会话取一把 skill，正文进它自己的上下文", async () => {
  const fake = await startFakeModel((req) => {
    if (isParentTurn(req)) {
      return req.messages.some((m) => m.role === "tool")
        ? { content: "取到了。" }
        : { toolCalls: [{ name: "task", args: { agent: "skiller", task: "取一把用得上的 skill" } }] };
    }
    // 子会话：先 acquire，第二轮（tool_result 回来之后）收工
    return req.messages.some((m) => m.role === "tool")
      ? { content: "已经启用 e2e-demo。" }
      : { toolCalls: [{ name: "skill", args: { action: "acquire", name: "e2e-demo" } }] };
  });
  const otto = await launchOtto({
    userAgents: [{ name: "skiller", description: "会取说明书的子 agent", tools: "read_file, skill" }],
    skills: [{ name: "e2e-demo", description: "e2e 用的假 skill", body: MARKER }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    await startSession(otto, ws, "派个人去取说明书");

    // 子会话至少两轮（acquire 那轮 + tool_result 回去那轮）
    await expect
      .poll(() => fake.requests.filter((r) => !isParentTurn(r)).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    const child = fake.requests.filter((r) => !isParentTurn(r));

    // ① 这把刀真的在子会话的工具表里 —— 探针不传 skills 的话它在这一步就没了
    expect(
      toolNames(child[0]!),
      "子会话的工具表里没有 skill —— 定义里写了也被当成不认识的工具名滤掉了（D9 没兑现）"
    ).toContain("skill");

    // ② 不只是挂着好看：正文真的进了子会话下一轮的上下文
    expect(
      bodyOf(child[child.length - 1]!),
      "子会话 acquire 之后正文没进上下文"
    ).toContain(MARKER);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("内置 general-purpose 也带着 skill（ALL_TOOLS 那份白名单就是 allowTools）", async () => {
  const fake = await startFakeModel((req) => {
    if (isParentTurn(req)) {
      return req.messages.some((m) => m.role === "tool")
        ? { content: "问完了。" }
        : { toolCalls: [{ name: "task", args: { agent: "general-purpose", task: "随便看看" } }] };
    }
    return { content: "看完了。" };
  });
  const otto = await launchOtto({
    skills: [{ name: "e2e-demo", description: "e2e 用的假 skill", body: MARKER }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    await startSession(otto, ws, "派通用子 agent 看看");

    await expect
      .poll(() => fake.requests.filter((r) => !isParentTurn(r)).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    const child = fake.requests.filter((r) => !isParentTurn(r))[0]!;
    expect(
      toolNames(child),
      "内置 general-purpose 的工具表里没有 skill —— ALL_TOOLS 漏了它，连挂都挂不上"
    ).toContain("skill");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

// issue #482 欠账 ①：**恢复出来的**子会话也该有这把刀。
//
// 为什么必须重启 app 才算数：不重启的话 resumeSession 走的是"agent 还在内存里，
// 只切视线"那条路，压根到不了 createChildAgent。而 createChildAgent 那一侧的
// skills 接线在 index.ts 里——正是上一轮终审抓到的两处"单测绿着、功能不存在"
// 的同一个形状（单测能造出 createChildAgent 的入参，造不出装配根有没有传）。
//
// 证据取 BootInfo.toolDefs：主进程报的是这个会话**实际挂上 engine** 的那份
// 工具表，不用再跑一轮模型。
test("重启之后 resume 回来的子会话，skill 工具还在（createChildAgent 那一侧）", async () => {
  const fake = await startFakeModel((req) =>
    isParentTurn(req)
      ? req.messages.some((m) => m.role === "tool")
        ? { content: "派完了。" }
        : { toolCalls: [{ name: "task", args: { agent: "skiller", task: "随便看看" } }] }
      : { content: "看完了。" }
  );
  // 两只共用同一份 HOME + profile，所以两只都不"自己造"——close() 因此都不删，
  // 清理归下面的 finally（见 harness 的 LaunchOptions.home）
  const home = mkdtempSync(join(tmpdir(), "otto-e2e-home-"));
  const profile = `e2e${Math.random().toString(16).slice(2, 10)}`;
  const seed = {
    userAgents: [{ name: "skiller", description: "会取说明书的子 agent", tools: "read_file, skill" }],
    skills: [{ name: "e2e-demo", description: "e2e 用的假 skill", body: MARKER }],
    env: fakeModelEnv(fake),
    home,
    profile,
  };
  const first = await launchOtto(seed);
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  let second: Awaited<ReturnType<typeof launchOtto>> | undefined;
  try {
    await startSession(first, ws, "派个人去看看");
    await expect
      .poll(() => fake.requests.filter((r) => !isParentTurn(r)).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    // 关掉整只 app：内存里那个子 agent 随之消失，resume 只能走重建那条路
    await first.close();

    second = await launchOtto(seed);
    // 子会话不在 listSessions 里（它是从父那张派活卡点进去的），而
    // readSessionEvents 只让读"当前会话派出的子会话"——所以先 resume 父，
    // 从它的 subagent_spawned 里取 id，再 resume 子。界面上那张卡走的也是这条路
    const tools = await second.win.evaluate(async () => {
      const bridge = (window as unknown as { otter: {
        listSessions(): Promise<{ sessionId: string }[]>;
        resumeSession(id: string): Promise<{
          events: { type: string; childSessionId?: string }[];
          toolDefs: { name: string }[];
        }>;
      } }).otter;
      for (const s of await bridge.listSessions()) {
        const parent = await bridge.resumeSession(s.sessionId);
        const spawned = parent.events.find((e) => e.type === "subagent_spawned");
        if (!spawned?.childSessionId) continue;
        const child = await bridge.resumeSession(spawned.childSessionId);
        return child.toolDefs.map((d) => d.name);
      }
      return null;
    });
    expect(tools, "库里没找到子会话——上半场没派成活，下面的断言就没有意义").not.toBeNull();

    // 快照里点了名（当初实际挂上过），所以恢复回来还该在
    expect(tools, "resume 回来的子会话没有 skill 工具——createChildAgent 那一侧没接 skills").toContain("skill");
    // 递归防线照旧：重建出来的这一位永远没有 task
    expect(tools).not.toContain("task");
  } finally {
    await second?.close();
    rmSync(home, { recursive: true, force: true });
    if (first.userData.includes(profile)) rmSync(first.userData, { recursive: true, force: true });
    await fake.close();
  }
});
