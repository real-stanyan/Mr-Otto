// 应用分享卡（#1648）：信封认得出、一格不对整张不认；预览；slug 不撞。
import { describe, expect, it } from "vitest";
import { appCardPreview, decodeAppCard, encodeAppCard, freeSlug, type AppShareCard } from "../../src/shared/appCard.js";
import { dmPreview } from "../../src/shared/wechatInbox.js";

const CARD: AppShareCard = {
  appId: "11111111-2222-3333-4444-555555555555", version: 2, name: "日历记事本", icon: "🗓️", slug: "calendar-notepad",
  description: "带月历的记事本", from: { uid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "继爸" },
};

describe("appCard", () => {
  it("编了解得回；预览不摊开 JSON（私聊列表第二行也走它）", () => {
    const body = encodeAppCard(CARD);
    expect(decodeAppCard(body)).toEqual(CARD);
    expect(appCardPreview(CARD)).toBe("[应用] 🗓️ 日历记事本");
    expect(dmPreview(body)).toBe("[应用] 🗓️ 日历记事本");
  });
  it("一格不对整张不认：不是 uuid / 版本 0 / slug 不合规 / 别的信封 / 普通文字", () => {
    const bad = (patch: Partial<AppShareCard>): string => JSON.stringify({ otto: "otto.app-card", v: 1, card: { ...CARD, ...patch } });
    expect(decodeAppCard(bad({ appId: "x" }))).toBeNull();
    expect(decodeAppCard(bad({ version: 0 }))).toBeNull();
    expect(decodeAppCard(bad({ slug: "Bad Slug" }))).toBeNull();
    expect(decodeAppCard(JSON.stringify({ otto: "otto.contact-card", v: 1, card: CARD }))).toBeNull();
    expect(decodeAppCard("你好")).toBeNull();
  });
  it("freeSlug：原样 / -2 / -3，封顶 32", () => {
    expect(freeSlug("notes", () => false)).toBe("notes");
    expect(freeSlug("notes", (s) => s === "notes" || s === "notes-2")).toBe("notes-3");
    expect(freeSlug("a".repeat(32), (s) => s === "a".repeat(32)).length).toBe(32);
  });
});
