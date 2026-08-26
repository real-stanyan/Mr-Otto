// issue #465 的端到端守卫：模型自己 acquire 一把 skill，这条链路真的通到底。
//
// 为什么单测不够：`activeSkills` / `composeSkillIndex` / `skillCardLabel` 各自的
// 单测钉的是「一个函数给定输入吐什么」，钉不住「模型调一次 skill 工具 → 事件真的
// 落盘 → 时间线卡片真的长出来 → 下一轮请求体里真的带着说明书正文」这条完整链路。
// 尤其是 D2 那条最要紧的决定——正文走 skill_invoked 事件、不进 tool_result——
// 只有从假模型的请求体里搜到那句标记文本，才算验到了「没有被投影层削掉」。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel, type FakeRequest } from "./fakeModel.js";

/** 只可能来自 SKILL.md 正文注入的一句话——搜它比搜 skill 名可靠，
    同 skillDirective.e2e.ts 的取舍：名字可能因为别的原因出现在消息里，正文不会 */
const MARKER = "e2e-demo 正文里的这句话只应该在 acquire 之后出现在请求体里。";

function bodyOf(req: FakeRequest): string {
  return req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
}

test("#465 模型自己 acquire 一把 skill：卡片长出来，下一轮请求带着说明书正文", async () => {
  const fake = await startFakeModel((req) => {
    // 第一轮：工具表里已经有 skill 这把刀（composeSkillIndex 拼进了 description），
    // 模型选择取用它。第二轮：tool_result 回来之后收工，说一句话
    const dispatched = req.messages.some((m) => m.role === "tool");
    return dispatched
      ? { content: "已经启用了 e2e-demo，接下来会用得上。" }
      : { toolCalls: [{ name: "skill", args: { action: "acquire", name: "e2e-demo" } }] };
  });
  const otto = await launchOtto({
    skills: [{ name: "e2e-demo", description: "e2e 用的假 skill", body: MARKER }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "看看有没有用得上的 skill，有就启用它");

    // 卡片：skillCardLabel 给模型自取标了来源——「Otto 启用了 skill「e2e-demo」」
    await expect(win.getByText("Otto 启用了 skill「e2e-demo」", { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    // 第二轮请求（tool_result 回去之后那一轮）的消息里含正文标记——
    // 证明正文走的是 skill_invoked 事件投影进 user 消息，不是躺在 tool_result 里
    // 等着被削（D2）
    await expect.poll(() => fake.requests.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    const req = fake.requests[fake.requests.length - 1]!;
    expect(bodyOf(req), "下一轮请求体里没带上 skill 正文——D2 那条决定没生效").toContain(MARKER);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
