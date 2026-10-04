// 「发送」不等回执（#1473）。RN 组件进不了 vitest（仓里没有 RN 渲染 harness，同 activityFace.test.ts 的做法），
// 所以读源码钉住三件事：
// ① 输入框在 await onSend 之前就清空——量到的回执是 DM 里 ~850ms、群里（派活分类器）两三秒、
//    会话刚 ready 之后更久；原来文字留在框里、钮变灰、期间的点击一律无声吞掉，人就一直点；
// ② 「发送」钮不再被一个 sending 锁按住（点第二句不用等第一句的回执——排队在 chatStore 那一层）；
// ③ 确定失败时原文回到输入框（ADR-0228 的三态回执没变：ok / unknown 清，确定失败留原文）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const composer = read("../../mobile/src/chat/WxComposer.tsx");
const screen = read("../../mobile/src/chat/ChatScreen.tsx");
const store = read("../../mobile/src/cloud/chatStore.ts");

describe("WxComposer：发出即清", () => {
  it("清空输入框排在 await onSend 之前", () => {
    const clear = composer.indexOf('setDraftText("")');
    const send = composer.indexOf("await onSend(text)");
    expect(clear).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(send);
  });

  it("「发送」钮没有 sending 锁", () => {
    expect(composer).not.toContain("const [sending, setSending]");
  });

  it("确定失败时原文回到输入框", () => {
    expect(composer).toContain("if (!accepted) restoreText(text)");
  });
});

describe("chatStore：发出去的那句先画在时间线上，发送串成一条链", () => {
  it("sendText 走 sendQueue，并在回执之前把那句挂进 outbox", () => {
    expect(store).toContain("createSendQueue");
    expect(store).toContain("outbox:");
    expect(screen).toContain('kind: "outbox"');
  });
});
