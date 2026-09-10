// @vitest-environment jsdom
//
// 通话那一行**真渲染一遍**（#1228）。
//
// 每一格填什么钉在 tests/renderer/cloudTimelineLabels.test.ts（纯逻辑）；这里补的是
// 那份够不到的两件事——维护者对这块 UI 提的原话只有这两条，两条都只在这一层看得见：
// ① 这一行**居中**（`VoiceCallPart` 的值里没有"对齐"这个概念）
// ② 每个名字**左边有一张脸**（`avatarSrc` 是对的，不代表 <img> 真的挂上去了）
//
// Radix 的 Avatar.Image 要等图片真的加载完才把 <img> 挂上去，而 jsdom 从不真的取图 ——
// 桩打在 complete / naturalWidth 上而不是 onload 上，原因抄自 mentionOptionRow.test.tsx
// （naturalWidth 恒为 0，光派 load 事件仍然判成 error）。

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { VoiceCallRow } from "../../src/renderer/src/components/CloudSessionPage.js";
import { voiceCallLineParts } from "../../src/renderer/src/lib/cloudTimeline.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { VoiceCallChangedEvent } from "../../src/session/events.js";

beforeAll(() => {
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

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [], sandboxApproval: "ask",
  agents: [
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_2", name: "广告", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  members: [
    { uid: "u1", role: "owner", label: "Stan", avatarUrl: "https://example.test/stan.png" },
    { uid: "u2", role: "member", label: "无头像的人", avatarUrl: "" },
  ],
};

const ev = (seq: number, ids: string[], byUid = "u1"): VoiceCallChangedEvent => ({
  seq, ts: 0, sessionId: "s", type: "voice_call_changed", ignorable: true, byUid,
  participants: ids.map((id) => ({ agentId: id, name: `快照${id}` })),
});

function renderLine(prev: VoiceCallChangedEvent | null, e: VoiceCallChangedEvent): HTMLElement {
  const { container } = render(<VoiceCallRow parts={voiceCallLineParts(prev, e, ws)} />);
  const p = container.querySelector("p");
  if (p === null) throw new Error("这一行没画出来");
  return p;
}

describe("VoiceCallRow", () => {
  it("整句话照旧画得出来（分段只是把名字拆成了自己的一格）", () => {
    renderLine(null, ev(1, ["a_1", "a_2"]));
    // 名字与连接词各在各的 <span> 里，所以这里按格找而不是整句 getByText
    for (const s of ["Stan", "开始了语音通话：", "运营", "、", "广告"]) {
      expect(screen.getByText(s)).toBeInTheDocument();
    }
  });

  it("居中：与旁边那几行旁白（靠左的小灰字）故意不同款", () => {
    expect(renderLine(null, ev(1, ["a_1"])).className).toContain("text-center");
  });

  it("每个名字左边一张脸：发起人一张 + 名单里每一只各一张", () => {
    const line = renderLine(null, ev(1, ["a_1", "a_2"]));
    const imgs = [...line.querySelectorAll("img")];
    expect(imgs).toHaveLength(3);
    expect(imgs[0]!.getAttribute("src")).toBe("https://example.test/stan.png");
    // agent 画内置像素图，不是成员表里那些 URL —— 两族画法不同才认得出谁是谁
    expect(imgs[1]!.getAttribute("src")).toContain("agent-avatars");
    // alt 留空：名字就贴在右边，读屏念两遍是噪音
    expect(imgs[0]).toHaveAttribute("alt", "");
  });

  it("脸和它的名字锁在一起：换行不能断在中间", () => {
    const line = renderLine(null, ev(1, ["a_1"]));
    const holder = line.querySelector("img")!.closest("span.whitespace-nowrap");
    expect(holder).not.toBeNull();
    expect(holder!.textContent).toBe("Stan");
  });

  it("名册里查不到的不画空 <img>，退回首字母", () => {
    // 发起人是没设过头像的成员、名单里那只已经被删了 —— 两格都该是首字母
    const line = renderLine(null, ev(1, ["a_x"], "u2"));
    expect(line.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByText("无")).toBeInTheDocument();
    expect(screen.getByText("快")).toBeInTheDocument();
  });

  it("结束那一条只有发起人一格", () => {
    const line = renderLine(ev(1, ["a_1"]), ev(2, []));
    expect(line.textContent).toBe("Stan 结束了语音通话");
    expect(line.querySelectorAll("img")).toHaveLength(1);
  });
});
