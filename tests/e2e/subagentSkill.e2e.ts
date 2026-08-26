// ADR-0110 D9（「子会话自己也拿得到 skill 工具」）的端到端守卫。
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
import { mkdtempSync } from "node:fs";
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
