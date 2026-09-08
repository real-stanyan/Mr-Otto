// @vitest-environment jsdom
//
// 工作区设置页「会话」tab 真渲染一遍（#1115）。
//
// 这一组钉的是**这一 tab 对得起它的名字**：一个有云会话的工作区，点 ⚙ 落地的
// 第一格不许是一片空白。原来的实现只画 `archived` 那一半、一条归档的都没有时
// 整节 `return null`，于是真机上两条进行中的云会话在这一屏上一个字都不提。
//
// 三态那两条（读不到 ≠ 一条都没有）与 gitHostsSection 那一组是同一条纪律，
// 判据不同：这里没有第二条 RPC 可问，只能看「拉完了没有」+「拉完之后这一格
// 有没有值」——所以用例必须让 refresh 真的跑一趟（等 findBy*），不能只 setState。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { WorkspacePage } from "../../src/renderer/src/components/WorkspacePage.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

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

type Row = { id: string; title: string; publisherUid: string; archived: boolean; updatedTs: number };

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

const show = () => render(<WorkspacePage ws={WS} selfUid={OWNER} onBack={() => {}} />);

afterEach(() => cleanup());

describe("「会话」tab 的云会话一节", () => {
  it("进行中的云会话进 DOM —— 这一 tab 不再只画归档的", async () => {
    seed([
      { id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1 },
      { id: "s-2", title: "门店排班", publisherUid: OTHER, archived: false, updatedTs: T2 },
    ]);
    show();

    expect(await screen.findByText("冬季新品")).toBeInTheDocument();
    expect(screen.getByText("门店排班")).toBeInTheDocument();
    // 空态与那句「还没有人发布会话」是两码事：后者说的是 kind='package'
    expect(screen.queryByText(/还没有进行中的云会话/)).not.toBeInTheDocument();
  });

  it("点一行 = 打开那条会话", async () => {
    const opened: [string, string | null][] = [];
    seed([{ id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1 }]);
    useChat.setState({
      openCloudSession: (async (w: string, s: string | null) => {
        opened.push([w, s]);
      }) as never,
    });
    show();
    await userEvent.click(await screen.findByText("冬季新品"));
    expect(opened).toEqual([["ws-1", "s-1"]]);
  });

  it("归档的仍然单列一节，且带那颗彻底删除", async () => {
    seed([
      { id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1 },
      { id: "s-9", title: "去年双十一", publisherUid: OWNER, archived: true, updatedTs: T2 },
    ]);
    show();

    expect(await screen.findByText("已归档的云会话")).toBeInTheDocument();
    expect(screen.getByText("去年双十一")).toBeInTheDocument();
    expect(
      screen.getByTitle("彻底删除这条会话（整段对话从云端抹掉，不可恢复）")
    ).toBeInTheDocument();
  });

  it("一条归档的都没有 → 不画那一节（不为没发生过的事留一行空态）", async () => {
    seed([{ id: "s-1", title: "冬季新品", publisherUid: OWNER, archived: false, updatedTs: T1 }]);
    show();
    await screen.findByText("冬季新品");
    expect(screen.queryByText("已归档的云会话")).not.toBeInTheDocument();
  });

  it("一条云会话都没有 → 空态，且指得出去哪开一条", async () => {
    seed([]);
    show();
    expect(await screen.findByText(/还没有进行中的云会话/)).toBeInTheDocument();
    expect(screen.queryByText(/读不到云会话清单/)).not.toBeInTheDocument();
  });

  it("读不到 → 说读不到，**不许画成「一条都没有」**", async () => {
    seed(null);
    show();
    expect(await screen.findByText(/读不到云会话清单/)).toBeInTheDocument();
    expect(screen.queryByText(/还没有进行中的云会话/)).not.toBeInTheDocument();
  });
});
