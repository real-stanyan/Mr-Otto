// @vitest-environment jsdom
//
// agent 的最终答案在云会话时间线上**真渲染一遍**（#1132）：一条回复按空行拆成几张
// 气泡，像真人在群里连发几条；署名与时间只在第一张上面写一次。拆分的判据钉在
// tests/renderer/chatBubbles.test.ts（纯逻辑），这里补的是那份够不到的一件事——
// 拆出来的几段有没有真被画成几张气泡、而不是一张气泡里几段字。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AssistantMessageRow } from "../../src/renderer/src/components/CloudSessionPage.js";
import type { AssistantMessageEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }],
  agents: [
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  sandboxApproval: "ask",
};

const reply = (content: string): AssistantMessageEvent => ({
  sessionId: "s", ts: 0, seq: 9, type: "assistant_message", content, model: "m", agentId: "a_1",
});

const bubbles = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="bubble"]'));

afterEach(cleanup);

describe("AssistantMessageRow（#1132：一条回复拆成几张气泡）", () => {
  it("空行分开的两段画成两张气泡，署名只写一次", () => {
    render(<AssistantMessageRow event={reply("看了一圈，结论是没问题。\n\n下一步我去改样式。")} ws={ws} />);
    expect(bubbles()).toHaveLength(2);
    expect(screen.getByText("看了一圈，结论是没问题。")).toBeInTheDocument();
    expect(screen.getByText("下一步我去改样式。")).toBeInTheDocument();
    expect(screen.getAllByText(/^运营 · /)).toHaveLength(1);
  });

  it("没有空行 = 一张气泡，与改动前逐字同款", () => {
    render(<AssistantMessageRow event={reply("要做三件事：\n改样式\n加组件")} ws={ws} />);
    expect(bubbles()).toHaveLength(1);
  });

  it("代码围栏里的空行不拆——脚本是交付物，切成两张就没法复制", () => {
    render(<AssistantMessageRow event={reply("脚本在这：\n\n```bash\necho a\n\necho b\n```")} ws={ws} />);
    expect(bubbles()).toHaveLength(2);
    expect(bubbles()[1]).toHaveTextContent("echo a");
    expect(bubbles()[1]).toHaveTextContent("echo b");
  });
});
