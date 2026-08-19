// userProfile — 名字收敛、头像准入、列补丁、管理器四段。
// 这一层是用户输入进库前的最后一道关,所以拒绝的理由要和接受的理由一样明确。

import { describe, expect, it, vi } from "vitest";
import {
  buildColumnPatch, sanitizeName, toMyProfile, UserProfileManager,
  type MyProfileRow, type UserProfileApi,
} from "../../src/main/userProfile.js";
import { AVATAR_MAX_CHARS, NAME_MAX } from "../../src/shared/profile.js";
import { validateAvatar } from "../../src/main/userProfile.js";

const NOW = "2026-08-19T04:00:00.000Z";

function row(over: Partial<MyProfileRow> = {}): MyProfileRow {
  return {
    id: "u1", email: "a@b.c", name: "阿獭", avatar_url: "", onboarded_at: null, ...over,
  };
}

function fakeApi(over: Partial<UserProfileApi> = {}): UserProfileApi {
  return {
    getUserId: async () => "u1",
    loadProfile: async () => row(),
    saveProfile: async (_uid, patch) =>
      row({ name: patch["name"] ?? "阿獭", avatar_url: patch["avatar_url"] ?? "" }),
    ...over,
  };
}

describe("sanitizeName", () => {
  it("首尾空白裁掉,中间的连续空白压成一个", () => {
    expect(sanitizeName("  水   獭  先生 ")).toBe("水 獭 先生");
  });

  it("换行和制表符不是空格的替代品,一律压平", () => {
    // 名字只显示在单行里:留着它们只会变成看不见的宽度
    expect(sanitizeName("水獭\n\t先生")).toBe("水獭 先生");
  });

  it("超长按码点截断,不切碎 emoji", () => {
    // slice 按 UTF-16 单元切,会把代理对切成半个字符,渲染成 U+FFFD
    const name = "🦦".repeat(NAME_MAX + 5);
    const cut = sanitizeName(name);
    expect([...cut]).toHaveLength(NAME_MAX);
    expect(cut).not.toContain("�");
  });

  it("全是空白 → 空串(交给上层判成'名字不能是空的')", () => {
    expect(sanitizeName("   \n  ")).toBe("");
  });
});

describe("validateAvatar", () => {
  it("空串合法:那是'清掉自定义头像'", () => {
    expect(validateAvatar("")).toEqual({ ok: true, value: "" });
  });

  it("https 和 data:image 放行", () => {
    expect(validateAvatar("https://x/a.png")).toEqual({ ok: true, value: "https://x/a.png" });
    const data = "data:image/webp;base64,AAAA";
    expect(validateAvatar(data)).toEqual({ ok: true, value: data });
  });

  it("javascript: 之类的一律挡下 —— 这个串会被当成 <img src> 塞进 DOM", () => {
    const r = validateAvatar("javascript:alert(1)");
    expect(r.ok).toBe(false);
  });

  it("http(非 s)也挡:头像是跨网络取的,别在这里开明文口子", () => {
    expect(validateAvatar("http://x/a.png").ok).toBe(false);
  });

  it("超过上限的 data URL 拒收,理由带 KB 数", () => {
    const huge = "data:image/png;base64," + "A".repeat(AVATAR_MAX_CHARS);
    const r = validateAvatar(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("KB");
  });
});

describe("toMyProfile", () => {
  it("null 列收敛成空串,onboarded_at 有值即已引导", () => {
    expect(toMyProfile(row({ email: null, name: null, avatar_url: null, onboarded_at: NOW })))
      .toEqual({ id: "u1", email: "", name: "", avatarUrl: "", onboarded: true });
  });

  it("onboarded_at 为 null = 还没走过引导", () => {
    expect(toMyProfile(row()).onboarded).toBe(false);
  });
});

describe("buildColumnPatch", () => {
  it("只写传了的列,并且总是带上 updated_at", () => {
    const r = buildColumnPatch({ name: " 阿獭 " }, NOW);
    expect(r).toEqual({ ok: true, value: { name: "阿獭", updated_at: NOW } });
  });

  it("名字收敛后为空 = 拒绝(不能把自己改成无名氏)", () => {
    expect(buildColumnPatch({ name: "   " }, NOW)).toEqual({ ok: false, message: "名字不能是空的" });
  });

  it("头像校验不过时整个补丁作废,不做'能写多少写多少'", () => {
    const r = buildColumnPatch({ name: "阿獭", avatarUrl: "javascript:x" }, NOW);
    expect(r.ok).toBe(false);
  });

  it("onboarded: true 落成 onboarded_at 时间戳", () => {
    const r = buildColumnPatch({ onboarded: true }, NOW);
    expect(r).toEqual({ ok: true, value: { onboarded_at: NOW, updated_at: NOW } });
  });

  it("空补丁被拒 —— 否则会发出一条只更新 updated_at 的无意义写", () => {
    expect(buildColumnPatch({}, NOW).ok).toBe(false);
  });

  it("头像可以被清空(空串是合法值,不是'没传')", () => {
    const r = buildColumnPatch({ avatarUrl: "" }, NOW);
    expect(r).toEqual({ ok: true, value: { avatar_url: "", updated_at: NOW } });
  });
});

describe("UserProfileManager", () => {
  it("未登录时 load 回 value:null,不是错误", async () => {
    const m = new UserProfileManager({ api: fakeApi({ getUserId: async () => null }) });
    expect(await m.load()).toEqual({ ok: true, value: null });
  });

  it("行还没建出来(注册那一瞬)同样回 null", async () => {
    const m = new UserProfileManager({ api: fakeApi({ loadProfile: async () => null }) });
    expect(await m.load()).toEqual({ ok: true, value: null });
  });

  it("网络错变成 ok:false,不炸穿 IPC", async () => {
    const m = new UserProfileManager({
      api: fakeApi({ loadProfile: async () => { throw new Error("下线了"); } }),
    });
    expect(await m.load()).toEqual({ ok: false, message: "下线了" });
  });

  it("未登录时 save 直接拒,不发请求", async () => {
    const saveProfile = vi.fn();
    const m = new UserProfileManager({
      api: fakeApi({ getUserId: async () => null, saveProfile }),
    });
    expect(await m.save({ name: "阿獭" })).toEqual({ ok: false, message: "没登录" });
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it("校验没过时也不发请求 —— 拒绝要发生在往返之前", async () => {
    const saveProfile = vi.fn();
    const m = new UserProfileManager({ api: fakeApi({ saveProfile }) });
    expect((await m.save({ name: "  " })).ok).toBe(false);
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it("save 回的是改完的真行(乐观 UI 的落地依据)", async () => {
    const m = new UserProfileManager({ api: fakeApi(), now: () => new Date(NOW) });
    const r = await m.save({ name: "新名字" });
    expect(r).toEqual({
      ok: true,
      value: { id: "u1", email: "a@b.c", name: "新名字", avatarUrl: "", onboarded: false },
    });
  });

  it("时间戳取自注入的 now,不是墙上时钟", async () => {
    const saveProfile = vi.fn(async () => row({ onboarded_at: NOW }));
    const m = new UserProfileManager({ api: fakeApi({ saveProfile }), now: () => new Date(NOW) });
    await m.save({ onboarded: true });
    expect(saveProfile).toHaveBeenCalledWith("u1", { onboarded_at: NOW, updated_at: NOW });
  });
});
