// 派活链路的真机验收 —— #142 第 8–15、17–18 条 + #147 第 6/7/11/13/14/15 条。
//
// 这一段是四张清单里最该跑、也最没跑过的一段：#142 的 body 自己写了「全分支审查
// 发现的那个 Critical 是**读代码读出来的**，不是跑出来的」。跑它需要模型真的派一次活，
// 所以这里接一台假模型（fakeModel.ts）—— 让「这一轮吐什么」变成用例的输入。
// 除了对面那台服务器，从 routeModel 到 engine 到子会话落盘，跑的都是真代码。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFileSync } from "node:child_process";

import { expectNoRendererErrors, launchOtto, startSession, type Otto } from "./harness.js";
import { fakeModelEnv, startFakeModel, type FakeModel, type FakeRequest } from "./fakeModel.js";

/** 直接查会话库。better-sqlite3 是按 Electron 的 ABI 编的，Playwright 这侧的 node
    加载不了；系统自带的 sqlite3 命令行读同一个文件，够用 */
function sqlite(otto: Otto, sql: string): string {
  return execFileSync("sqlite3", [join(otto.userData, "sessions.db"), sql], {
    encoding: "utf8",
  }).trim();
}

/** 父会话那一轮才带 task 工具（子会话的工具表里没有 task —— 那正是 #142-12 要验的） */
function isParentTurn(req: FakeRequest): boolean {
  return (req.tools ?? []).some((t) => t.function.name === "task");
}

test("#142-8/9/10/13 派一次活：卡片长出来、跑着点它不炸、收口后显示步数与 token、子会话不进侧栏", async () => {
  const fake = await startFakeModel((req) => {
    if (!isParentTurn(req)) {
      // 子会话：一个字一个字地吐，留出「跑着的时候点那张卡」的手速
      return { content: "找到了：src/foo.ts 第 1 行。", delayMs: 400 };
    }
    const dispatched = req.messages.some((m) => m.role === "tool");
    return dispatched
      ? { content: "搜索员说在 src/foo.ts。" }
      : { toolCalls: [{ name: "task", args: { agent: "searcher", task: "在这个工程里找到 foo 的定义在哪一行" } }] };
  });
  const otto = await launchOtto({
    userAgents: [{ name: "searcher", description: "只读搜索员", tools: "read_file", approval: "deny" }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "帮我找 foo 在哪定义的");

    // 8. 卡片：agent 名 + 任务首行 + 计时（m:ss）
    const card = win.getByRole("button", { name: /searcher · 在这个工程里找到 foo/ });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(/\d:\d\d/);

    // 9. **跑着的时候点它**。这是上一轮那个 Critical 的位置（点一下会永久毒死
    //    子会话日志）。修完之后的形状是就地展开一块转录、明说还在跑，
    //    而不是跳进一个还没定型的子会话
    await card.click();
    await expect(win.getByText("还在跑,收口后可在这里回看")).toBeVisible();

    // 10. 收口：变成「N 步 · Xk tokens」，计时器让位
    await expect(card).toContainText(/步 ·/, { timeout: 30_000 });
    await expect(card).not.toContainText(/\d:\d\d/);

    // 11. 卡片还开着，转录当场补上子会话真说过的那句话 —— 也就是说，
    //     跑着的时候点开的那一下并没有把日志毒死（毒死的表现是这里永远空着）
    await expect(win.getByText("找到了：src/foo.ts 第 1 行。")).toBeVisible({ timeout: 15_000 });

    // 13. 子会话不进侧栏
    // 侧栏的会话行 = 带删除钮的那种 listitem（转录面板也是 list，别把它算进来）
    const sessionRows = win
      .getByRole("listitem")
      .filter({ has: win.getByRole("button", { name: "✕" }) });
    await expect(sessionRows).toHaveCount(1);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("#142-12 子会话的开局：有 subagent_briefed、前置词在最前面、工具表里没有 task", async () => {
  const fake = await startFakeModel((req) =>
    isParentTurn(req)
      ? req.messages.some((m) => m.role === "tool")
        ? { content: "好了。" }
        : { toolCalls: [{ name: "task", args: { agent: "searcher", task: "看一眼这个工程的结构" } }] }
      : { content: "看完了。" }
  );
  const otto = await launchOtto({
    userAgents: [{ name: "searcher", description: "只读搜索员", tools: "read_file", approval: "deny" }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    await startSession(otto, ws, "看看这个工程");
    await expect(otto.win.getByRole("button", { name: /searcher · 看一眼/ })).toContainText(/步 ·/, {
      timeout: 30_000,
    });

    const child = fake.requests.find((r) => !isParentTurn(r));
    expect(child, "子会话那一轮请求没发出来").toBeTruthy();
    // 工具表里没有 task —— 子 agent 不能再往下派，这是 ADR-0047 的边界
    expect((child!.tools ?? []).map((t) => t.function.name)).not.toContain("task");
    // 「模型看到的全部」= subagent_briefed.instructions，它投影成子会话的第一条
    // user 消息。内置前置词必须在正文**前面**（顺序错了模型先读到的是任务细节）
    const first = child!.messages.find((m) => m.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    const preambleAt = text.indexOf("You are a subagent dispatched to carry out one specific task.");
    const bodyAt = text.indexOf("测试用子智能体。");
    expect(preambleAt, "子会话第一条 user 消息里没有内置前置词").toBeGreaterThanOrEqual(0);
    expect(bodyAt, "子会话第一条 user 消息里没有定义正文").toBeGreaterThan(preambleAt);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("#142-14 一条回复里派两个活：长成两行的清单，且不出现 React 重复 key 的告警", async () => {
  const fake = await startFakeModel((req) =>
    isParentTurn(req)
      ? req.messages.some((m) => m.role === "tool")
        ? { content: "两个都回来了。" }
        : {
            // 刻意**派给同一个 agent 两次** —— registry 原版按 name 做 key，
            // 两行同名就是重复 key，React 会认错行。本仓改成用 toolCallId
            toolCalls: [
              { name: "task", args: { agent: "searcher", task: "第一件事：数一数有几个文件" } },
              { name: "task", args: { agent: "searcher", task: "第二件事：看看有没有 README" } },
            ],
          }
      : { content: "办完了。" }
  );
  const otto = await launchOtto({
    userAgents: [{ name: "searcher", description: "只读搜索员", tools: "read_file", approval: "deny" }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "一次派两个活");
    await expect(win.getByText("第一件事：数一数有几个文件")).toBeVisible({ timeout: 20_000 });
    await expect(win.getByText("第二件事：看看有没有 README")).toBeVisible({ timeout: 20_000 });
    // 两行各自可点：点第二行，展开的该是第二行的转录
    await win.getByText("第二件事：看看有没有 README").click();
    await expect(win.getByText("办完了。").first()).toBeVisible({ timeout: 20_000 });
    // 重复 key 的告警走 console.error —— expectNoRendererErrors 就是这一条的判据
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("#142-15 跑到一半按停止：父会话拿到的是 error 且文案说得清，子会话记的是 aborted", async () => {
  const fake = await startFakeModel((req) =>
    isParentTurn(req)
      ? req.messages.some((m) => m.role === "tool")
        ? { content: "停了。" }
        : { toolCalls: [{ name: "task", args: { agent: "slowpoke", task: "慢慢数到一百" } }] }
      : // 子会话吐得很慢，好让停止键按得下去
        { content: "一二三四五六七八九十".repeat(20), delayMs: 200 }
  );
  const otto = await launchOtto({
    userAgents: [{ name: "slowpoke", description: "慢性子", tools: "read_file", approval: "deny" }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "派个慢活");
    const card = win.getByRole("button", { name: /slowpoke · 慢慢数到一百/ });
    await expect(card).toBeVisible({ timeout: 20_000 });

    await win.getByRole("button", { name: "停止 turn" }).click();

    // 父会话那一侧：tool_result 落成 error，文案说清楚了「谁中断的、过程留在哪」
    await expect
      .poll(
        () =>
          sqlite(
            otto,
            "select json_extract(payload,'$.status')||'|'||json_extract(payload,'$.output') from events where type='tool_result'"
          ),
        { timeout: 20_000 }
      )
      .toMatch(/^error\|子任务被用户中断。/);

    // 子会话那一侧：日志里记的是 aborted
    expect(
      sqlite(otto, "select count(*) from events where type='turn_ended' and payload like '%aborted%'")
    ).not.toBe("0");

    // 界面上能看见的只有 turn 那一层的「已中断」
    await expect(win.getByText("已中断")).toBeVisible();

    // 现状记一笔（不在本次改动范围内，另开单）：那张派活卡此刻显示的是
    // **绿勾 + 「0 步 · 0 tokens」** —— subagentRowState 只看「有没有 tool_result」，
    // 不看它是 ok 还是 error，AgentState 里也没有 error 这一档。也就是说
    // 「被我按停的」和「顺利跑完的」在时间线上长得一模一样。日志是对的，界面在说谎。
    await expect(win.getByRole("button", { name: /slowpoke · 慢慢数到一百/ })).toContainText("0 步");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("#142-16 删掉派过活的父会话：子会话的事件行**一起**物理消失", async () => {
  const fake = await startFakeModel((req) =>
    isParentTurn(req)
      ? req.messages.some((m) => m.role === "tool")
        ? { content: "好了。" }
        : { toolCalls: [{ name: "task", args: { agent: "searcher", task: "随便看看" } }] }
      : { content: "看完了。" }
  );
  const otto = await launchOtto({
    userAgents: [{ name: "searcher", description: "只读搜索员", tools: "read_file", approval: "deny" }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "派个活然后删掉我");
    await expect(win.getByRole("button", { name: /searcher · 随便看看/ })).toContainText(/步 ·/, {
      timeout: 30_000,
    });
    // 父 + 子 = 两条会话的行都在库里
    expect(sqlite(otto, "select count(distinct session_id) from events")).toBe("2");

    // 删父会话（侧栏那颗 ✕）。ADR-0002 承诺删除不可逆 —— 子会话不能留在库里
    win.once("dialog", (d) => void d.accept());
    await win.getByRole("listitem").filter({ has: win.getByRole("button", { name: "✕" }) })
      .getByRole("button", { name: "✕" })
      .click();
    await expect
      .poll(() => sqlite(otto, "select count(distinct session_id) from events"), { timeout: 15_000 })
      .toBe("0");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
