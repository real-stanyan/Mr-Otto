// 手机端把「分享会话」那条私信画成一张卡（#1271）。原来是一整坨原始 JSON。
import { describe, expect, it } from "vitest";
import { encodeEnvelope, decodeEnvelope, type ShareEnvelope } from "../../src/shared/sessionPackageCodec.js";
import { shareCardView } from "../../src/shared/shareCard.js";

const INVITE = "otto-proxy:1:32c6716a-2215-4fef-8865-7da11e0feab9:Uty0zzi_o98C5FrUbdo5i:secretpart:1788075140589";

function env(over: Partial<ShareEnvelope> = {}): ShareEnvelope {
  return {
    otto: "otto.session-share", v: 1,
    bucket: "session-packages", prefix: "uid/pkg",
    message: "交给他处理", title: "查 Mandy 店 Square 销量", eventCount: 130,
    ...over,
  };
}

describe("shareCardView", () => {
  it("对方分享的：抬头带名字，标题 / 留言 / 条数各一行", () => {
    const v = shareCardView(env(), { mine: false, fromName: "Stan Yan" });
    expect(v.heading).toBe("Stan Yan 分享了一个会话");
    expect(v.title).toBe("查 Mandy 店 Square 销量");
    expect(v.message).toBe("交给他处理");
    expect(v.meta).toBe("130 条事件");
  });

  it("自己分享的：不说别人的名字", () => {
    expect(shareCardView(env(), { mine: true, fromName: "Stan Yan" }).heading).toBe("你分享了一个会话");
  });

  it("**邀请码一个字都不上屏** —— 它是一次性 secret，给按钮读的，不是给人读的", () => {
    const v = shareCardView(env({ invite: INVITE, grantServers: ["supabase", "square"] }),
      { mine: false, fromName: "Stan Yan" });
    expect(JSON.stringify(v)).not.toContain("otto-proxy");
    expect(JSON.stringify(v)).not.toContain("secretpart");
  });

  it("借出的服务两个方向措辞不同；没借就不画那一行", () => {
    const borrowed = shareCardView(env({ grantServers: ["supabase", "square"] }),
      { mine: false, fromName: "小红" });
    expect(borrowed.grant).toBe("小红 连带把这些服务借给你用：supabase、square");
    expect(shareCardView(env({ grantServers: [] }), { mine: false, fromName: "小红" }).grant).toBeNull();
    expect(shareCardView(env(), { mine: false, fromName: "小红" }).grant).toBeNull();
  });

  it("空标题 / 空留言不画成空行；名字空了退回「对方」", () => {
    const v = shareCardView(env({ title: "   ", message: "" }), { mine: false, fromName: "  " });
    expect(v.title).toBeNull();
    expect(v.message).toBeNull();
    expect(v.heading).toBe("对方 分享了一个会话");
  });

  it("条数不像数就说不详，不替它编一个", () => {
    expect(shareCardView(env({ eventCount: NaN }), { mine: false, fromName: "x" }).meta).toBe("条数不详");
    expect(shareCardView(env({ eventCount: -1 }), { mine: false, fromName: "x" }).meta).toBe("条数不详");
  });

  it("手机上永远有一句「去哪儿做」—— 因为这里做不了", () => {
    expect(shareCardView(env(), { mine: false, fromName: "x" }).hint).toContain("电脑");
  });

  it("和真信封对得上：encode 出来的 body 解得回来，再交给它", () => {
    const body = encodeEnvelope({
      bucket: "session-packages", prefix: "u/p", message: "看看", title: "标题", eventCount: 3,
    });
    const decoded = decodeEnvelope(body);
    expect(decoded).not.toBeNull();
    expect(shareCardView(decoded!, { mine: false, fromName: "小明" }).meta).toBe("3 条事件");
  });
});
