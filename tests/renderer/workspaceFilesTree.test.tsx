// @vitest-environment jsdom
//
// 工作区设置页「文件」tab 的那棵树，真渲染一遍（#1097）。
//
// `workFilesView.test.ts` 钉的是每一格的**值**（大小怎么写、空目录该说哪句话），
// 钉不到「有没有被画出来」——同 #1068 给 `mentionOptionRow` 补那一份时的理由。
// 而这一页此前一次都没被渲染过，于是「读回来的条目到底进没进 DOM」这件事
// 在门禁上是空白的：runtime 那侧读得再对，渲染层把它丢了也一样全绿。
//
// 三条各盯一处：非空目录画成树 / 展开子目录才发第二条帧（一次只列一层）/
// **读不到 ≠ 里面是空的**（出错时不许兜底成空目录，同 ADR-0243/0251）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { WorkspaceFilesTab } from "../../src/renderer/src/components/WorkspaceFilesTab.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { CsWorkEntry, CsWorkNode } from "../../src/shared/remote/cloudSession.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const OWNER = "u-owner";
const WS: WorkspaceSnapshot = {
  id: "ws-1",
  name: "mandy's bubble tea",
  ownerUid: OWNER,
  members: [],
  connectors: [],
  sessions: [],
  agents: [],
  sandboxApproval: "ask",
};

const file = (name: string, size: number): CsWorkEntry => ({ name, kind: "file", size, mtimeMs: 1_757_300_000_000 });
const dir = (name: string): CsWorkEntry => ({ name, kind: "dir", size: 0, mtimeMs: 1_757_300_000_000 });

/** 仓库那一节要它才画得出来；这一份测试只关心上半的文件树 */
function seed(files: (path: string) => Promise<{ ok: true; value: CsWorkNode } | { ok: false; message: string }>) {
  useChat.setState({
    workspaceRepoState: async () => ({ ok: true, value: { repoUrl: "", hasPat: false, lastClone: null } }) as never,
    workspaceFiles: (async (_id: string, path: string) => files(path)) as never,
    workspaceFilesSearch: (async () => ({ ok: true, value: [] })) as never,
  });
}

const show = () => render(<WorkspaceFilesTab ws={WS} selfUid={OWNER} />);

afterEach(() => cleanup());

describe("WorkspaceFilesTab 的工作文件夹树", () => {
  it("非空目录：每一条都进 DOM，不是只算出个数", async () => {
    seed(async () => ({ ok: true, value: { kind: "dir", entries: [dir("menu"), file("config.json", 36)], truncated: false } }));
    show();

    expect(await screen.findByText("menu")).toBeInTheDocument();
    expect(screen.getByText("config.json")).toBeInTheDocument();
    // 空态那句话不许同时在场——它出现就说明树没画出来
    expect(screen.queryByText(/还是空的/)).not.toBeInTheDocument();
  });

  it("一次只列一层：展开子目录才发第二条帧", async () => {
    const seen: string[] = [];
    seed(async (path) => {
      seen.push(path);
      if (path === "") return { ok: true, value: { kind: "dir", entries: [dir("menu")], truncated: false } };
      return { ok: true, value: { kind: "dir", entries: [file("menu.md", 12)], truncated: false } };
    });
    show();

    await screen.findByText("menu");
    expect(seen).toEqual([""]); // 开页面只发根那一条

    await userEvent.click(screen.getByText("menu"));

    expect(await screen.findByText("menu.md")).toBeInTheDocument();
    expect(seen).toEqual(["", "menu"]);
  });

  it("读不到 ≠ 里面是空的：失败时不许兜底成空目录", async () => {
    seed(async () => ({ ok: false, message: "读工作文件夹失败（exit 1）" }));
    show();

    await waitFor(() => expect(screen.getByText(/读工作文件夹失败/)).toBeInTheDocument());
    expect(screen.queryByText(/还是空的/)).not.toBeInTheDocument();
  });
});
