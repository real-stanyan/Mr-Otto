// 开局卡那句话发失败时的去处（issue #957 C-I6）。
//
// take() 先把它从 cloudPendingFirstMessage 摘掉是对的（不然 effect 重跑会发
// 两遍），但摘掉之后 cloudSay 回 false 的话，那段文字在任何地方都不再存在——
// 开局卡早已卸载。cloudDraftSeed 是它的落点：CloudSessionPage 挂载时取走填进
// 输入框，从此归 composer 那条既有纪律管（「草稿在发送成功之后才清」）。
//
// 这里钉的是 take 那条判据：**按 sessionId 挂靠**。异步期间用户可能已经切到
// 别的云会话，把上一条会话没发出去的话塞进这一条的输入框，比丢了更糟。

import { beforeEach, describe, expect, it } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";

describe("cloudDraftSeed —— 开局卡那句话发失败之后的落点", () => {
  beforeEach(() => {
    useChat.setState({ cloudDraftSeed: null });
  });

  it("同一条会话：取得到，且取完就清（不会第二次冒出来）", () => {
    useChat.getState().seedCloudDraft("cloud-s1", "帮我看下这个仓库");
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toBe("帮我看下这个仓库");
    expect(useChat.getState().cloudDraftSeed).toBeNull();
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toBeNull();
  });

  it("换了一条会话：回 null，**而且不清**——那句话仍然等着它自己那条会话", () => {
    useChat.getState().seedCloudDraft("cloud-s1", "帮我看下这个仓库");

    expect(useChat.getState().takeCloudDraftSeed("cloud-s2")).toBeNull();
    expect(useChat.getState().cloudDraftSeed).toEqual({ sessionId: "cloud-s1", text: "帮我看下这个仓库" });
    // 切回去还在
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toBe("帮我看下这个仓库");
  });

  it("一格都没有：回 null，不抛", () => {
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toBeNull();
  });
});
