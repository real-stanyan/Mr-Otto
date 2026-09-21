// #1262：时间线窗口补挂时，滚动补偿把视口送到哪儿。
//
// 上一班在**最小页面**上四种变体都复现不出 issue 归因的那一步（「原生滚动锚定已经先挪过
// 一次 scrollTop」），所以那条归因当时不能当既定前提。这两条用例把同一次测量搬进**真 app**：
// 不改产品代码，只把 `Element.prototype.scrollTo` 包一层，记下每次调用的目标值、调用那一刻的
// `scrollTop`、以及**补挂之前**视口停在哪儿（用 scroll 事件跟，和产品里那道补偿同一个办法）。
//
// 量出来的（Electron 43 / Chromium，2026-09-21）：
//   reveal 桥那条路 —— 补挂前 4435.5、净增高 13888、补偿跑的那一刻 scrollTop 已经是
//   18323.5（= 4435.5 + 13888）。原生锚定确实抢跑了整整一个 delta。
//   **同一组数还排除了另一个嫌疑人**：那一刻视口没贴底，而 aui 的 autoScroll 若是凶手，
//   该把它拽到 19361（scrollHeight − clientHeight），不是 18323.5。
//   哨兵那条路 —— 锚点是哨兵自己（在插入点上方），原生不动手，`at` 就等于补挂前那个值。
//
// 所以补偿的目标必须是**绝对位置**（补挂前的 scrollTop + 净增高）：两条路落同一处，
// 不用先判断「它挪了没有」。这两条用例守的就是这个等式，一条一条路。

import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession, type Otto } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

const VIEWPORT = '[data-slot="aui_thread-viewport"]';

function sqlite(otto: Otto, sql: string): string {
  return execFileSync("sqlite3", [join(otto.accountData, "sessions.db"), sql], {
    encoding: "utf8",
  }).trim();
}

/** 往这条会话尾部塞 `turns` 个完整回合。直接写库是因为跑 60 个真 turn 要几分钟，
    而这两条用例要的只是「消息够多，窗口真的启用」这个形状 */
function seedTurns(otto: Otto, sessionId: string, turns: number): void {
  const start = Number(sqlite(otto, `SELECT COALESCE(MAX(seq), -1) FROM events WHERE session_id = '${sessionId}';`)) + 1;
  const rows: string[] = [];
  let seq = start;
  let ts = Date.now();
  for (let i = 0; i < turns; i++) {
    rows.push(`('${sessionId}', ${seq++}, ${ts++}, 'user_message', NULL, json_object('content', '第 ${i} 问'))`);
    rows.push(`('${sessionId}', ${seq++}, ${ts++}, 'assistant_message', NULL, json_object('content', '第 ${i} 答', 'model', 'fake'))`);
    rows.push(`('${sessionId}', ${seq++}, ${ts++}, 'turn_ended', NULL, json_object('outcome', 'completed'))`);
  }
  sqlite(otto, `INSERT INTO events (session_id, seq, ts, type, sandbox_id, payload) VALUES ${rows.join(",")};`);
}

interface ScrollCall {
  /** 这次调用要滚到哪儿 */
  top: number;
  /** 调用那一刻的 scrollTop —— 别人抢没抢跑就看它 */
  at: number;
  /** 这次调用**之前**最后一次 scroll 事件里的 scrollTop = 补挂前的位置。
      scroll 在「更新渲染」那一步派发，晚于本次提交的 layout effect，所以锚定自己挪出来的
      那一下不会污染它（产品里那道补偿用的是同一个办法） */
  last: number;
  /** 同上，这次调用之前最后一次 scroll 事件里的 scrollHeight = 补挂前的高度 */
  lastHeight: number;
  height: number;
  stack: string;
}

interface Probe {
  calls: ScrollCall[];
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 装探针并回装的那一刻的视口尺寸 */
async function installProbe(win: Page): Promise<Omit<Probe, "calls">> {
  const snap = await win.evaluate((sel) => {
    const viewport = document.querySelector(sel);
    if (!(viewport instanceof HTMLElement)) return null;
    const w = window as unknown as { __calls?: unknown[]; __last?: number; __lastH?: number };
    w.__calls = [];
    w.__last = viewport.scrollTop;
    w.__lastH = viewport.scrollHeight;
    viewport.addEventListener("scroll", () => {
      w.__last = viewport.scrollTop;
      w.__lastH = viewport.scrollHeight;
    }, { passive: true });
    const orig = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function patched(this: Element, ...args: unknown[]) {
      const opt = args[0] as { top?: number } | undefined;
      w.__calls!.push({
        top: typeof opt === "object" && opt !== null ? (opt.top ?? -1) : Number(args[1] ?? -1),
        at: this.scrollTop,
        last: w.__last,
        lastHeight: w.__lastH,
        height: this.scrollHeight,
        stack: new Error().stack ?? "",
      });
      return (orig as (...a: unknown[]) => void).apply(this, args);
    } as typeof Element.prototype.scrollTo;
    return { scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight };
  }, VIEWPORT);
  expect(snap, "没找到 aui 视口").not.toBeNull();
  return snap!;
}

async function readProbe(win: Page): Promise<ScrollCall[]> {
  return win.evaluate(() => ((window as unknown as { __calls?: ScrollCall[] }).__calls ?? []));
}

/** 起一只 app、播一条 60 轮的会话、重载到位。回调里做各自的动作 */
async function withLongSession(body: (otto: Otto) => Promise<void>): Promise<void> {
  const fake = await startFakeModel(() => ({ content: "收到。" }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "第一句");
    await expect(win.getByText("收到。").first()).toBeVisible({ timeout: 20_000 });
    const sessionId = sqlite(otto, "SELECT session_id FROM events WHERE type = 'session_created' LIMIT 1;");
    expect(sessionId, "没找到会话").not.toBe("");
    // 60 轮 = 180 条消息投影 → 远超 INITIAL_WINDOW(60)，窗口必然启用
    seedTurns(otto, sessionId, 60);
    await win.reload();
    await expect(win.getByTestId("splash")).toHaveCount(0, { timeout: 20_000 });
    await expect(win.getByText("第 59 答").first()).toBeVisible({ timeout: 20_000 });
    await body(otto);
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
}

/** 补挂补偿那次调用 = 第一次、且栈里不是 scrollToTurn（那次排在它后面） */
function compensationOf(calls: readonly ScrollCall[]): ScrollCall {
  const comp = calls[0];
  expect(comp, "一次 scrollTo 都没发生 —— 这条路压根没走到").toBeDefined();
  expect(comp!.stack, "第一次调用不是补挂补偿").not.toContain("scrollToTurn");
  return comp!;
}

test("#1262 reveal 桥：原生锚定抢跑了一个 delta，补偿不许再加一次", async () => {
  await withLongSession(async ({ win }) => {
    const ticks = win.locator('button[data-slot="conversation-map-tick"]');
    await expect(ticks.first()).toBeVisible({ timeout: 20_000 });

    // **判别实验的前提**：先用真滚轮离开底部。贴着底时两个嫌疑人（原生锚定 / aui 的
    // autoScroll 拽回底部）预测同一个数（s0 + 净增高 恰好等于底部），分不开。
    // 用滚轮不用 scrollTo：assistant-ui 判「用户往上滚」看的是相邻两次 scroll 回调，
    // 程序滚动凑不齐它那两条，会让 autoScroll 仍然武装着 —— 那正是要保留的变量
    const box = await win.locator(VIEWPORT).boundingBox();
    expect(box, "没量到视口").not.toBeNull();
    await win.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await win.mouse.wheel(0, -3200);
    await win.waitForTimeout(600);

    const before = await installProbe(win);
    expect(before.scrollTop, "点之前贴着底，判别实验失效").toBeLessThan(
      before.scrollHeight - before.clientHeight - 1
    );

    // 第一格 = 最早那一轮，必然在窗口上沿以外 → 走 reveal 桥的 grow 分支
    await ticks.first().click();
    await win.waitForTimeout(1500);

    const comp = compensationOf(await readProbe(win));
    const grew = comp.height - before.scrollHeight;
    expect(grew, "窗口没补挂 —— 这条用例什么都没测到").toBeGreaterThan(0);

    // ① 修法本身：目标 = 补挂前的位置 + 净增高。写成「现读的 scrollTop + 净增高」就是双倍
    expect(comp.top, "补偿目标是双倍 —— #1262 回来了").toBeCloseTo(before.scrollTop + grew, 0);
    // ② 修法的**前提**：补偿跑的那一刻，scrollTop 确实已经被原生锚定挪过整整一个 delta。
    //    哪天 Chromium 不再这么干，这一条会红 —— 那时上面那条补偿就该回去重判，
    //    而不是默默变成一次无害但没人再理解的冗余
    expect(comp.at, "原生锚定没再抢跑了 —— 补偿的前提变了，回去重判").toBeCloseTo(
      before.scrollTop + grew, 0
    );
  });
});

test("#1262 哨兵那条路不回退：原生不抢跑，同一个等式照样成立", async () => {
  // 补偿那一行是两条路共用的。哨兵这条锚点是哨兵自己（在插入点上方），原生不动手 ——
  // 改成绝对位置之前它是对的，之后也必须还是对的
  await withLongSession(async ({ win }) => {
    const box = await win.locator(VIEWPORT).boundingBox();
    await win.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const mounted = () => win.evaluate((sel) => document.querySelectorAll(`${sel} [data-role]`).length, VIEWPORT);

    await installProbe(win);
    // 一路往上滚到哨兵进视野；挂载数涨了 = 补挂发生过
    const start = await mounted();
    let grown = false;
    for (let i = 0; i < 30 && !grown; i++) {
      await win.mouse.wheel(0, -1200);
      await win.waitForTimeout(150);
      grown = (await mounted()) > start;
    }
    expect(grown, "滚了 30 档也没触发补挂 —— 这条用例什么都没测到").toBe(true);
    await win.waitForTimeout(400);

    const comp = compensationOf(await readProbe(win));
    // 净增高从**高度**推，不从 top − last 推 —— 后者是待验等式的一边，拿它当基准就成了同义反复
    const grew = comp.height - comp.lastHeight;
    expect(grew, "窗口没补挂 —— 这条用例什么都没测到").toBeGreaterThan(0);
    // ① 同一个等式：目标 = 补挂前的位置 + 净增高
    expect(comp.top, "哨兵那条路的补偿目标不对").toBeCloseTo(comp.last + grew, 0);
    // ② 这条路的前提与 reveal 桥**相反**：原生一格都没挪
    expect(comp.at, "哨兵那条路上原生锚定也抢跑了 —— 两条路的前提不再对称，回去重判")
      .toBeCloseTo(comp.last, 0);
  });
});
