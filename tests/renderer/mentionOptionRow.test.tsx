// @vitest-environment jsdom
//
// @ 选人弹层的一行**真渲染一遍**（#1068，承接 #1059 / ADR-0252）。
//
// 谁进这份列表、每一格填什么，钉在 tests/renderer/workspaceMentionItems.test.ts
// （纯逻辑）；这里补的是那份够不到的一件事——**那几格有没有真被画出来**。维护者
// 对这块 UI 提的原话只有两条（左边那个圆圈是这一行对应的那张脸、右边标出这是人
// 还是 agent），两条恰好都只在这一层看得见：`MentionRow.kind` 的值是对的，不代表
// 屏幕上有「成员」两个字。
//
// Radix 的 Avatar.Image 要等图片**真的加载完**才把 <img> 挂上去，而 jsdom 从不
// 真的取图 —— 不打桩的话每一行都只剩首字母，「两族画的是两张不同的脸」这件事一条
// 都验不到。下面那个 stub 因此是这条测试能存在的前提，不是装饰；它打在哪、为什么
// 不是打在 onload 上，写在 beforeAll 里。

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { MentionOptionRow } from "../../src/renderer/src/components/CloudSessionPage.js";
import { mentionRows } from "../../src/renderer/src/lib/workspaceMentionItems.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

beforeAll(() => {
  // 桩要打在 complete / naturalWidth 上，不是 onload 上：Radix 判「加载成功没有」
  // 的原文是 `image.complete ? image.naturalWidth > 0 ? "loaded" : "error" : "loading"`
  // （react-avatar 的 getImageLoadingStatus），而 jsdom 从不真的取图 ——
  // naturalWidth 恒为 0，于是**连 load 事件都派了也还是判成 error**（第一版就栽在
  // 这儿）。这两格一给，它在 `image.src = src` 之后那次同步调用里就直接得出
  // "loaded"，<img> 当场挂上，测试也不必等异步
  const store = new WeakMap<object, string>();
  Object.defineProperty(window.Image.prototype, "src", {
    configurable: true,
    get(this: HTMLImageElement) {
      return store.get(this) ?? "";
    },
    set(this: HTMLImageElement, value: string) {
      store.set(this, value);
    },
  });
  Object.defineProperty(window.Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(window.Image.prototype, "naturalWidth", { configurable: true, get: () => 1 });
});

afterEach(cleanup);

function agent(agentId: string, name: string, description = ""): WorkspaceSnapshot["agents"][number] {
  return {
    agentId, name, description, instructions: "", models: [], tools: [],
    createdBy: "u1", updatedTs: 0, avatarSlot: null,
  };
}

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [], sandboxApproval: "ask",
  agents: [agent("a_1", "运营", "管店铺")],
  members: [
    { uid: "u1", role: "owner", label: "Stan", avatarUrl: "https://example.test/stan.png" },
    { uid: "u2-abcdefgh", role: "member", label: "无头像的人", avatarUrl: "" },
    { uid: "u3", role: "member", label: "运营助理", avatarUrl: "" },
  ],
};

const rows = mentionRows(ws);
const rowFor = (key: string) => {
  const row = rows.find((r) => r.key === key);
  if (row === undefined) throw new Error(`没有 ${key} 这一行`);
  return row;
};

function renderRow(key: string, selected = false) {
  render(<MentionOptionRow ws={ws} row={rowFor(key)} selected={selected} onPick={() => {}} onHover={() => {}} />);
  return screen.getByRole("option");
}

describe("MentionOptionRow", () => {
  it("agent 那一行：内置像素头像 + 名字 + 职责 + 「智能体」", () => {
    const row = renderRow("agent:a_1");
    expect(within(row).getByText("运营")).toBeInTheDocument();
    expect(within(row).getByText("管店铺")).toBeInTheDocument();
    expect(within(row).getByText("智能体")).toBeInTheDocument();
    // 脸来自 assets/agent-avatars/（agentAvatarSrc 按 avatarSlot / agentId 哈希取），
    // **不是** members 里那些 URL —— 两族画法不同才认得出谁是谁
    const img = within(row).getByRole("img");
    expect(img).toHaveAttribute("alt", "运营");
    expect(img.getAttribute("src")).toContain("agent-avatars");
  });

  it("成员那一行：profiles.avatar_url + 名字 + 「成员」，中间那格空着", () => {
    const row = renderRow("member:u1");
    expect(within(row).getByText("Stan")).toBeInTheDocument();
    expect(within(row).getByText("成员")).toBeInTheDocument();
    const img = within(row).getByRole("img");
    expect(img).toHaveAttribute("src", "https://example.test/stan.png");
    // 职责那一格是 agent 的东西，成员这一行不该凭空多出一格灰字
    expect(within(row).queryByText("管店铺")).not.toBeInTheDocument();
  });

  it("没设过头像的成员：退回首字母，不画一张空 <img>", () => {
    const row = renderRow("member:u2-abcdefgh");
    expect(within(row).queryByRole("img")).not.toBeInTheDocument();
    expect(within(row).getByText("无")).toBeInTheDocument();
  });

  it("撞名的成员：那句「@ 会点到智能体「运营」」真的画在行上", () => {
    // 纯逻辑那份钉的是 detail 这个**字段**的值；这里验它有没有被画出来 ——
    // 少画的后果是用户点了写着「成员」的那一行、回话的却是一只 agent（#722 那个
    // 撒谎的勾的一般形式），而这正是这一格存在的全部理由
    const row = renderRow("member:u3");
    expect(within(row).getByText("@ 会点到智能体「运营」")).toBeInTheDocument();
    expect(within(row).getByText("成员")).toBeInTheDocument();
  });

  it("高亮走 aria-selected：键盘挑到哪一行，读屏与样式说的是同一件事", () => {
    expect(renderRow("agent:a_1", true)).toHaveAttribute("aria-selected", "true");
    cleanup();
    expect(renderRow("agent:a_1", false)).toHaveAttribute("aria-selected", "false");
  });
});
