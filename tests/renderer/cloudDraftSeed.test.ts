// 开局卡那句话发失败时的去处（issue #957 C-I6、第四批 C2-I4）。
//
// take() 先把它从 cloudPendingFirstMessage 摘掉是对的（不然 effect 重跑会发
// 两遍），但摘掉之后 cloudSay 失败的话，那段文字在任何地方都不再存在——
// 开局卡早已卸载。cloudDraftSeed 是它的落点。
//
// 这里钉两条判据：
//   ① **按 sessionId 挂靠**：异步期间用户可能已经切到别的云会话，把上一条
//      会话没发出去的话塞进这一条的输入框，比丢了更糟。
//   ② **两种失败分得开**：`unsent`（确定没发出去）会被 CloudSessionPage 摆回
//      输入框；`unknown`（没收到回执）**不能**——输入框里躺着原文是「再发一次」
//      这个指令的最强信号，而这句话很可能已经落地了。这一格因此把模式一起
//      带出去，让调用方分流，而不是回一个裸字符串让它自己猜。

import { beforeEach, describe, expect, it } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";

describe("cloudDraftSeed —— 开局卡那句话发失败之后的落点", () => {
  beforeEach(() => {
    useChat.setState({ cloudDraftSeed: null });
  });

  it("同一条会话：取得到，且取完就清（不会第二次冒出来）", () => {
    useChat.getState().seedCloudDraft("cloud-s1", "帮我看下这个仓库", "unsent");
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toEqual({
      text: "帮我看下这个仓库",
      unknown: false,
    });
    expect(useChat.getState().cloudDraftSeed).toBeNull();
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toBeNull();
  });

  it("换了一条会话：回 null，**而且不清**——那句话仍然等着它自己那条会话", () => {
    useChat.getState().seedCloudDraft("cloud-s1", "帮我看下这个仓库", "unsent");

    expect(useChat.getState().takeCloudDraftSeed("cloud-s2")).toBeNull();
    expect(useChat.getState().cloudDraftSeed).toEqual({
      sessionId: "cloud-s1",
      text: "帮我看下这个仓库",
      unknown: false,
    });
    // 切回去还在
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toEqual({
      text: "帮我看下这个仓库",
      unknown: false,
    });
  });

  it("一格都没有：回 null，不抛", () => {
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toBeNull();
  });

  it("「没收到回执」那一份带着 unknown 出来——调用方据此决定不摆回输入框", () => {
    useChat.getState().seedCloudDraft("cloud-s1", "帮我看下这个仓库", "unknown");
    expect(useChat.getState().cloudDraftSeed).toEqual({
      sessionId: "cloud-s1",
      text: "帮我看下这个仓库",
      unknown: true,
    });
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toEqual({
      text: "帮我看下这个仓库",
      unknown: true,
    });
    expect(useChat.getState().cloudDraftSeed).toBeNull();
  });

  it("后一次种下的覆盖前一次（模式也跟着换）——同一条会话只留最后那份", () => {
    useChat.getState().seedCloudDraft("cloud-s1", "第一句", "unknown");
    useChat.getState().seedCloudDraft("cloud-s1", "第二句", "unsent");
    expect(useChat.getState().takeCloudDraftSeed("cloud-s1")).toEqual({ text: "第二句", unknown: false });
  });
});
