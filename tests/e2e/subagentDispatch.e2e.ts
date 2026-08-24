// 派活链路的真机验收 —— #142 第 8–15、17–18 条 + #147 第 6/7/11/13/14/15 条。
//
// 这一段是四张清单里最该跑、也最没跑过的一段：#142 的 body 自己写了「全分支审查
// 发现的那个 Critical 是**读代码读出来的**，不是跑出来的」。跑它需要模型真的派一次活，
// 所以这里接一台假模型（fakeModel.ts）—— 让「这一轮吐什么」变成用例的输入。
// 除了对面那台服务器，从 routeModel 到 engine 到子会话落盘，跑的都是真代码。

import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFileSync } from "node:child_process";

import {
  CONFIG_DIR,
  expectNoRendererErrors,
  launchOtto,
  openSettings,
  startSession,
  type Otto,
} from "./harness.js";
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

    // 界面上：turn 那一层的「已中断」
    await expect(win.getByText("已中断")).toBeVisible();

    // 卡片那一层也得说实话（issue #267）：被按停的子任务是**红叉**，
    // 不是绿勾。曾经这里两种情况长得一模一样 —— subagentRowState 只问
    // 「有没有 tool_result」，不问它是 ok 还是 error
    await expect(card.locator("svg.lucide-x")).toBeVisible();
    await expect(card.locator("svg.lucide-check")).toHaveCount(0);

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

/** 此刻模型派得出谁 —— task 工具 agent 字段的 enum */
function dispatchable(req: FakeRequest): string[] {
  return req.tools?.find((t) => t.function.name === "task")?.function.parameters?.properties?.agent?.enum ?? [];
}

test("#142-17/18 一个定义都没有时 task 照样在（内置那三份）；设置页刚建的那份当场可派，不用重开会话", async () => {
  const fake = await startFakeModel((req) => (isParentTurn(req) ? { content: "收到。" } : { content: "好。" }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "先说句话");

    // #142-17 的原文是「清空 ~/.mr-otto/agents 后 task 不该出现（一个人都派不出去）」。
    // 那条**已经过期**：后来加了三份内置子智能体（app 自带，不在磁盘上），
    // 所以清单永远不空、task 永远在。现在该验的是这个新事实。
    await expect.poll(() => fake.requests.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(dispatchable(fake.requests[0]!).sort()).toEqual([
      "Explore",
      "general-purpose",
      "memory-reviewer",
    ]);

    // #142-18：会话开着不动，去设置页建一份，回来再说一句 —— 新的那份当场就在 enum 里
    await openSettings(win, "子智能体");
    await win.getByRole("button", { name: "新建" }).first().click();
    await win.getByLabel("名称").fill("hotswap");
    await win.getByRole("button", { name: "创建" }).click();
    await expect(win.getByRole("button", { name: /^hotswap/ })).toBeVisible();
    await win.getByRole("button", { name: "返回会话" }).click();

    await win.getByRole("textbox", { name: /输入消息/ }).fill("再说一句");
    await win.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => fake.requests.length, { timeout: 20_000 }).toBeGreaterThan(1);
    expect(dispatchable(fake.requests[fake.requests.length - 1]!)).toContain("hotswap");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("#147-6/7 工作区级的那份只在它自己的工程里派得出去", async () => {
  const fake = await startFakeModel(() => ({ content: "收到。" }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const w1 = mkdtempSync(join(tmpdir(), "otto-ws1-"));
  const w2 = mkdtempSync(join(tmpdir(), "otto-ws2-"));
  try {
    const { win } = otto;
    // 先在 W1 开一条会话（作用域下拉的候选来自「有过会话的工程」）
    await startSession(otto, w1, "W1 的第一条会话");
    await openSettings(win, "子智能体");
    await win.getByRole("button", { name: "新建" }).first().click();
    await win.getByLabel("名称").fill("w1only");
    await win.getByRole("button", { name: "创建" }).click();
    expect(existsSync(join(w1, CONFIG_DIR, "agents", "w1only.md"))).toBe(true);
    await win.getByRole("button", { name: "返回会话" }).click();

    // 6. 在 W1 的会话里，它在派得出的名单里
    await win.getByRole("textbox", { name: /输入消息/ }).fill("在 W1 里说一句");
    await win.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => dispatchable(fake.requests[fake.requests.length - 1]!), { timeout: 20_000 })
      .toContain("w1only");

    // 7. 换到另一个工程的会话，它**派不出来**
    await win.getByRole("button", { name: "＋ 新会话" }).click();
    await startSession(otto, w2, "W2 的第一条会话");
    await expect.poll(() => dispatchable(fake.requests[fake.requests.length - 1]!), { timeout: 20_000 })
      .not.toContain("w1only");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

/** 子会话那一轮的第一条 user 消息 = subagent_briefed.instructions 的投影，
    也就是「模型看到的全部」 */
function briefing(fake: FakeModel): string {
  const child = fake.requests.find((r) => !isParentTurn(r));
  const first = child?.messages.find((m) => m.role === "user");
  return typeof first?.content === "string" ? first.content : "";
}

const PREAMBLE_HEAD = "You are a subagent dispatched to carry out one specific task.";

async function dispatchOnce(otto: Otto, agent: string, ws: string): Promise<void> {
  await startSession(otto, ws, `派活给 ${agent}`);
  await expect(otto.win.getByRole("button", { name: new RegExp(`${agent} · `) })).toContainText(
    /步 ·/,
    { timeout: 30_000 }
  );
}

function dispatcher(agent: string, task = "看一眼") {
  return (req: FakeRequest) =>
    isParentTurn(req)
      ? req.messages.some((m) => m.role === "tool")
        ? { content: "好了。" }
        : { toolCalls: [{ name: "task", args: { agent, task } }] }
      : { content: "看完了。" };
}

test("#147-11 前置词选「不加」：子会话第一条里一个字的前置词都没有", async () => {
  const fake = await startFakeModel(dispatcher("nopre"));
  const otto = await launchOtto({
    userAgents: [
      {
        name: "nopre",
        raw: "---\nname: nopre\ndescription: 不加前置词\ntools: read_file\napproval: deny\npreamble: off\n---\n\n这是我的正文，全部内容就这一句。\n",
      },
    ],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    await dispatchOnce(otto, "nopre", ws);
    const text = briefing(fake);
    expect(text).toContain("这是我的正文，全部内容就这一句。");
    expect(text, "选了「不加」还是把内置前置词拼了进去").not.toContain(PREAMBLE_HEAD);
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("#147-13 前置词选「自定义」：用的是自定义那段，**没有**内置那段", async () => {
  const fake = await startFakeModel(dispatcher("mypre"));
  const otto = await launchOtto({
    userAgents: [
      {
        name: "mypre",
        raw: "---\nname: mypre\ndescription: 自定义前置词\ntools: read_file\napproval: deny\npreamble: |\n  你是我的专用检索员，只回文件路径。\n---\n\n正文在这里。\n",
      },
    ],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    await dispatchOnce(otto, "mypre", ws);
    const text = briefing(fake);
    expect(text).toContain("你是我的专用检索员，只回文件路径。");
    expect(text, "自定义是**替代**不是叠加：内置那段不该同时在场").not.toContain(PREAMBLE_HEAD);
    expect(text.indexOf("你是我的专用检索员")).toBeLessThan(text.indexOf("正文在这里。"));
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("#147-14/15 勾了 AGENTS.md：有就注入并标出处；没有就跳过，不报错也不中断", async () => {
  const seed = {
    name: "reader",
    raw: "---\nname: reader\ndescription: 读工作区文档\ntools: read_file\napproval: deny\ncontext: AGENTS.md\n---\n\n正文。\n",
  };

  // 有 AGENTS.md 的工程
  const fake1 = await startFakeModel(dispatcher("reader"));
  const otto1 = await launchOtto({ userAgents: [seed], env: fakeModelEnv(fake1) });
  const ws1 = mkdtempSync(join(tmpdir(), "otto-ws-has-"));
  writeFileSync(join(ws1, "AGENTS.md"), "# 这个工程的规矩\n\n提交前先跑门禁。\n");
  try {
    await dispatchOnce(otto1, "reader", ws1);
    const text = briefing(fake1);
    expect(text).toContain("## 工作区文档：AGENTS.md");
    expect(text).toContain("提交前先跑门禁。");
    expectNoRendererErrors(otto1);
  } finally {
    await otto1.close();
    await fake1.close();
  }

  // 没有 AGENTS.md 的工程：同一份定义，派得出去，正文里干净利落地没有那一段
  const fake2 = await startFakeModel(dispatcher("reader"));
  const otto2 = await launchOtto({ userAgents: [seed], env: fakeModelEnv(fake2) });
  const ws2 = mkdtempSync(join(tmpdir(), "otto-ws-none-"));
  try {
    await dispatchOnce(otto2, "reader", ws2);
    const text = briefing(fake2);
    expect(text).not.toContain("## 工作区文档");
    expect(text).toContain("正文。");
    expectNoRendererErrors(otto2);
  } finally {
    await otto2.close();
    await fake2.close();
  }
});

test("#147-17 approval: deny 的子会话：危险操作被**直接拒绝**，不弹审批卡给用户", async () => {
  let childTurn = 0;
  const fake = await startFakeModel((req) => {
    if (isParentTurn(req)) {
      return req.messages.some((m) => m.role === "tool")
        ? { content: "它被挡住了。" }
        : { toolCalls: [{ name: "task", args: { agent: "denied", task: "试着动一下磁盘" } }] };
    }
    childTurn += 1;
    return childTurn === 1
      ? { toolCalls: [{ name: "bash", args: { command: "rm -rf /tmp/otto-e2e-should-never-run" } }] }
      : { content: "被拒了，我停手。" };
  });
  const otto = await launchOtto({
    userAgents: [{ name: "denied", description: "只读且拒绝一切审批", tools: "read_file, bash", approval: "deny" }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await dispatchOnce(otto, "denied", ws);
    // 子会话日志里那条 tool_result 是 denied（不是 error，也不是 ok），
    // 理由写明是 approval: deny —— 模型读得到、能据此改口
    expect(
      sqlite(
        otto,
        "select json_extract(payload,'$.status')||'|'||json_extract(payload,'$.output') from events where type='tool_result' and json_extract(payload,'$.toolCallId')='call_0_bash'"
      )
    ).toMatch(/^denied\|用户拒绝执行：这个 subagent 被配置为拒绝一切需要审批的操作（approval: deny）$/);
    // 用户那侧一张审批卡都没弹出来（弹了就说明 deny 没换掉整条审批链）
    await expect(win.getByRole("button", { name: /^(允许|批准|同意)/ })).toHaveCount(0);
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});

test("#147-19 改磁盘上那份 .md 再 resume 历史子会话：装备只信快照，不受改动影响", async () => {
  const fake = await startFakeModel(dispatcher("frozen"));
  const otto = await launchOtto({
    userAgents: [{ name: "frozen", description: "验快照", tools: "read_file", approval: "deny" }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win, userAgentsDir } = otto;
    await dispatchOnce(otto, "frozen", ws);
    const whenSpawned = fake.requests.find((r) => !isParentTurn(r))!;
    expect((whenSpawned.tools ?? []).map((t) => t.function.name)).toEqual(["read_file"]);

    // 磁盘上那份换副装备：加上 bash 和 write_file
    writeFileSync(
      join(userAgentsDir, "frozen.md"),
      "---\nname: frozen\ndescription: 验快照\ntools: read_file, bash, write_file\napproval: auto\n---\n\n测试用子智能体。\n"
    );

    // resume 那个历史子会话：卡片点开 → 「打开会话」
    await win.getByRole("button", { name: /frozen · / }).click();
    await win.getByRole("button", { name: "打开会话", exact: true }).click();
    // #142-11 的后半段：整屏切进子会话后，得有一条回父会话的路
    await expect(win.getByRole("button", { name: /回到父会话/ })).toBeVisible({ timeout: 10_000 });
    await win.getByRole("textbox", { name: /输入消息/ }).fill("再问一句");
    await win.getByRole("button", { name: "发送消息" }).click();

    await expect
      .poll(() => (fake.requests[fake.requests.length - 1]!.tools ?? []).map((t) => t.function.name), {
        timeout: 20_000,
      })
      .toEqual(["read_file"]);

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
