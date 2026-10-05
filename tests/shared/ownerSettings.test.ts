// 管理员改 Otto 设置（#1621）的纯判据：参数怎么认、复述怎么说。
import { describe, expect, it } from "vitest";
import { SETTING_KEYS, parseSettingsArgs, settingsChangedText } from "../../src/shared/ownerSettings.js";

describe("parseSettingsArgs", () => {
  it("九个键各认各的形状；关掉传 null；形状不对一句能照着改的话", () => {
    expect(parseSettingsArgs({ setting: "quiet_hours", value: { start: "22:00", end: "08:00" } })).toEqual({ kind: "quiet_hours", window: { start: "22:00", end: "08:00" } });
    expect(parseSettingsArgs({ setting: "quiet_hours", value: null })).toEqual({ kind: "quiet_hours", window: null });
    expect(() => parseSettingsArgs({ setting: "quiet_hours", value: { start: "22:00", end: "22:00" } })).toThrow("免打扰时段");
    expect(parseSettingsArgs({ setting: "report", value: { mode: "call", schedule: { kind: "weekly", days: [7], time: "09:00" } } })).toMatchObject({ kind: "report", plan: { mode: "call" } });
    expect(() => parseSettingsArgs({ setting: "report", value: { mode: "call", schedule: { kind: "once", at: "x" } } })).toThrow("汇报");
    expect(parseSettingsArgs({ setting: "tz", value: " Australia/Brisbane " })).toEqual({ kind: "tz", tz: "Australia/Brisbane" });
    expect(() => parseSettingsArgs({ setting: "tz", value: "Brisbane" })).toThrow("IANA");
    expect(parseSettingsArgs({ setting: "push", value: { friends: false, bogus: true } })).toEqual({ kind: "push", patch: { friends: false } });
    expect(() => parseSettingsArgs({ setting: "push", value: { friends: "no" } })).toThrow("布尔");
    expect(() => parseSettingsArgs({ setting: "push", value: {} })).toThrow("至少");
    expect(parseSettingsArgs({ setting: "friend_tier", friend: "Stan", value: "full" })).toEqual({ kind: "friend_tier", friend: "Stan", tier: "full" });
    expect(() => parseSettingsArgs({ setting: "friend_tier", value: "full" })).toThrow("没点名");
    expect(() => parseSettingsArgs({ setting: "friend_tier", friend: "Stan", value: "vip" })).toThrow("chat / agents / full");
    expect(parseSettingsArgs({ setting: "lane_facing", friend: "Stan", value: "both" })).toEqual({ kind: "lane_facing", friend: "Stan", facing: "both" });
    expect(parseSettingsArgs({ setting: "public_agent", value: null })).toEqual({ kind: "public_agent", agent: null });
    expect(parseSettingsArgs({ setting: "public_agent", value: "雨姐" })).toEqual({ kind: "public_agent", agent: "雨姐" });
    expect(parseSettingsArgs({ setting: "agent", agent: "管理员", value: { name: "雨姐", instructions: " 说话利落 " } })).toEqual({ kind: "agent", agent: "管理员", patch: { name: "雨姐", instructions: "说话利落" } });
    expect(() => parseSettingsArgs({ setting: "agent", agent: "管理员", value: {} })).toThrow("至少改一样");
    expect(() => parseSettingsArgs({ setting: "agent", agent: "管理员", value: { name: " " } })).toThrow("不能是空");
    expect(parseSettingsArgs({ setting: "profile_name", value: "  继  爸 " })).toEqual({ kind: "profile_name", name: "继 爸" });
    expect(() => parseSettingsArgs({ setting: "nope" })).toThrow(SETTING_KEYS.join(" / "));
  });
});

describe("settingsChangedText", () => {
  it("每种都以「已改：」开头、以「要改回来说一声」收尾；给别人看的那几种说清对方也会看到", () => {
    const all = [
      settingsChangedText({ kind: "quiet_hours", window: { start: "22:00", end: "08:00" } }),
      settingsChangedText({ kind: "quiet_hours", window: null }),
      settingsChangedText({ kind: "report", plan: null }),
      settingsChangedText({ kind: "tz", tz: "Australia/Brisbane" }),
      settingsChangedText({ kind: "push", patch: { friends: false, mentions: true } }),
      settingsChangedText({ kind: "friend_tier", friend: "stan", tier: "full" }, { friend: "Stan Yan" }),
      settingsChangedText({ kind: "lane_facing", friend: "Stan", facing: "both" }),
      settingsChangedText({ kind: "public_agent", agent: "雨姐" }),
      settingsChangedText({ kind: "agent", agent: "管理员", patch: { name: "雨姐", description: "x" } }),
      settingsChangedText({ kind: "profile_name", name: "继爸" }),
    ];
    for (const t of all) { expect(t.startsWith("已改：")).toBe(true); expect(t.endsWith("（要改回来说一声）")).toBe(true); }
    expect(all[4]).toContain("朋友消息关、有人 @ 我开");
    expect(all[5]).toContain("Stan Yan");
    expect(all[5]).toContain("TA 那边看到的也跟着变");
    expect(all[6]).toContain("TA 看得到");
    expect(all[8]).toContain("改名叫「雨姐」、职责改了");
  });
});
