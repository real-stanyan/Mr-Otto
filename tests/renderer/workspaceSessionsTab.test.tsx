// @vitest-environment jsdom
//
// 工作区设置「会话」那一页真渲染一遍（#1115；这一组是从 PR #1116 捞回来的——那条 PR
// 与 #1121 撞了同一件事，实现被后者取代，但**这七条断言没有替身**，#1121 那版一条
// 会话页的测试都没有）。
//
// 这一组钉的是**这一页对得起它的名字**：一个有云会话的工作区，点进「会话」不许是一片
// 空白。原来的实现只画 `archived` 那一半、一条归档的都没有时整节 `return null`，于是
// 真机上两条进行中的云会话在这一屏上一个字都不提。
//
// 三态那两条（读不到 ≠ 一条都没有）与 gitHostsSection 那一组是同一条纪律，判据不同：
// 这里没有第二条 RPC 可问，只能看「拉完了没有」+「拉完之后这一格有没有值」——所以
// 用例必须让 refresh 真的跑一趟（等 findBy*），不能只 setState。
//
// #1120 之后目录是**推入式**不是 tab，所以每条用例先点一下根页那行「会话」。

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { WorkspacePage } from "../../src/renderer/src/components/WorkspacePage.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";

// 这一屏里有组件调 `useConfirm()`（#1127），缺 provider 会在**渲染那一刻**抛——
// 这是故意的（不回落到 window.confirm），所以测试自己把 provider 包上。
// 换掉 `render` 这个名字而不是逐处改调用：以后这个文件里新写的用例自动带上
const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: ConfirmProvider });


const OWNER = "u-owner";
const OTHER = "u-other";
const T1 = new Date("2026-09-05T05:20:47Z").getTime();
const T2 = new Date("2026-09-04T02:42:23Z").getTime();

const WS: WorkspaceSnapshot = {
  id: "ws-1",
  name: "mandy's bubble tea",
  ownerUid: OWNER,
  members: [
    { uid: OWNER, role: "owner", label: "小红", avatarUrl: "" },
    { uid: OTHER, role: "member", label: "小明", avatarUrl: "" },
  ],
  connectors: [],
  sessions: [],
  agents: [],
  sandboxApproval: "ask",
};

// participantUids 补于 Task 7（#1213）：这一格是 CloudSessionListRow 的真实
// 字段（Task 6 起就有），之前这里的本地 Row 类型缺了它——反正是被下面
// `as unknown as Window["otter"]` 挡住的 excess-property 检查，tsc 从不会报。
// 这一页此刻还没有第二个消费方读这一格，但 store.ts 的参与者合并逻辑
// （Task 7）与 Task 8 的头像都要读它，补上让这份假件配得上它假冒的类型
// （同 progress.md「T6 minor (deferred) → 提醒 T7/T8 复审」那条）
type Row = { id: string; title: string; publisherUid: string; archived: boolean; updatedTs: number; participantUids: string[] };

beforeAll(() => {
  // 推入式导航在 reduced-motion 下是同步的（不起 rAF、不等动画），断言不必去等帧
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }),
  });
});

/** `list === null` = 这一趟拉失败（主进程回 ok:false），store 因此不写这一格 */
function seed(list: Row[] | null) {
  (window as unknown as { otter: Window["otter"] }).otter = {
    workspaceCloudList: async () =>
      list === null ? { ok: false, message: "网络挂了" } : { ok: true, value: list },
  } as unknown as Window["otter"];
  useChat.setState({
    cloudSessionList: {},
    account: { ...useChat.getState().account, id: OWNER } as never,
  });
}

/** 根页 → 「会话」那一页。行是一层铺满的透明按钮，`aria-label` 就是标题 */
async function show() {
  render(<WorkspacePage ws={WS} selfUid={OWNER} onBack={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "会话" }));
}

afterEach(() => cleanup());

describe("「会话」页的云会话一节", () => {
  it("进行中的云会话进 DOM —— 这一页不再只画归档的", async () => {
    seed([
      { id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1, participantUids: [] },
      { id: "s-2", title: "门店排班", publisherUid: OTHER, archived: false, updatedTs: T2, participantUids: [] },
    ]);
    await show();

    expect(await screen.findByText("冬季新品")).toBeInTheDocument();
    expect(screen.getByText("门店排班")).toBeInTheDocument();
    expect(screen.queryByText(/还没有进行中的云会话/)).not.toBeInTheDocument();
  });

  it("点一行 = 打开那条会话", async () => {
    const opened: [string, string | null][] = [];
    seed([{ id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1, participantUids: [] }]);
    useChat.setState({
      openCloudSession: (async (w: string, s: string | null) => { opened.push([w, s]); }) as never,
    });
    await show();
    await userEvent.click(await screen.findByRole("button", { name: "冬季新品" }));
    expect(opened).toEqual([["ws-1", "s-1"]]);
  });

  it("归档的单列一节，且**只有那一节**带彻底删除——活着那几条的动作在侧栏（ADR-0245 的分工）", async () => {
    seed([
      { id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1, participantUids: [] },
      { id: "s-9", title: "去年双十一", publisherUid: OWNER, archived: true, updatedTs: T2, participantUids: [] },
    ]);
    await show();

    expect(await screen.findByText("已归档的云会话")).toBeInTheDocument();
    expect(screen.getByText("去年双十一")).toBeInTheDocument();
    // 两条会话都是自己建的，但删除钮只能有一颗——挂在活着那条上等于开了第二个入口
    expect(screen.getAllByTitle("彻底删除这条会话（整段对话从云端抹掉，不可恢复）")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "彻底删除「去年双十一」" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "彻底删除「冬季新品」" })).not.toBeInTheDocument();
  });

  it("一条归档的都没有 → 不画那一节（不为没发生过的事留一行空态）", async () => {
    seed([{ id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1, participantUids: [] }]);
    await show();
    await screen.findByText("冬季新品");
    expect(screen.queryByText("已归档的云会话")).not.toBeInTheDocument();
  });

  it("一条云会话都没有 → 空态，且指得出去哪开一条", async () => {
    seed([]);
    await show();
    expect(await screen.findByText(/还没有进行中的云会话/)).toBeInTheDocument();
    expect(screen.queryByText(/读不到云会话清单/)).not.toBeInTheDocument();
  });

  it("一份都没发布过 → 「已发布会话」整节不出（它说的是 kind='package'，不是云会话）", async () => {
    seed([{ id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1, participantUids: [] }]);
    await show();
    await screen.findByText("冬季新品");
    expect(screen.queryByText("已发布会话")).not.toBeInTheDocument();
    expect(screen.queryByText(/还没有人发布会话/)).not.toBeInTheDocument();
  });

  it("读不到 → 说读不到，**不许画成「一条都没有」**", async () => {
    seed(null);
    await show();
    expect(await screen.findByText(/读不到云会话清单/)).toBeInTheDocument();
    expect(screen.queryByText(/还没有进行中的云会话/)).not.toBeInTheDocument();
  });
});
