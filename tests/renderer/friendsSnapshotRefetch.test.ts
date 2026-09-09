// @vitest-environment jsdom
//
// 好友快照的主动补拉（#704）。`friendsSnapshot` 唯一的数据源是主进程推送，而推送只在
// 登录态 / 好友关系**变化**时开火——渲染层重载（Cmd+R、崩溃重建）或冷启动竞速错过的
// 那一拍没人补，@ 补全就一直空着，直到下一次关系真的变动。
//
// 修法是补一扇查询窗口（同 runtimeHydration 的思路，ADR-0133）：登录态就位后
// `refreshSocialMirrors()` 主动拉一次（本人资料 + 好友快照）。这里的断言对着三件事：
//   ① 已登录 → 真的去拉，快照落进 store
//   ② 未登录 → 一帧都不拉（登出清场后不会再被旧快照回填）
//   ③ 补拉是 quiet 的——拉不到只 console.error，不落 friendError 横幅
//     （不是用户刚发起的动作，同 refreshMyProfile 的纪律）；而用户自己点的刷新照旧落
//   外加一条源码断言：两个调用点（boot 冷启动 / onAccountChanged 登录态变化）都得接着——
//   这条 issue 的病根就是「refreshFriends 写好了但零调用」，光测行为钉不住调用点被摘

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { useChat } from "../../src/renderer/src/store.js";
import type { FriendsSnapshot } from "../../src/shared/friends.js";
import type { MyProfile } from "../../src/shared/profile.js";

const SIGNED_IN = { signedIn: true, id: "u-me", email: "me@x.com", name: "我", avatarUrl: "" };
const SIGNED_OUT = { signedIn: false, id: "", email: "", name: "", avatarUrl: "" };

const SNAP: FriendsSnapshot = {
  friends: [
    {
      friendshipId: "f1",
      status: "accepted",
      direction: "incoming",
      profile: { id: "u-friend", email: "f@x.com", name: "好友", avatarUrl: "" },
    },
  ],
  incoming: [],
  outgoing: [],
};

const PROFILE: MyProfile = { id: "u-me", email: "me@x.com", name: "我", avatarUrl: "", onboarded: true };

function seed(account: typeof SIGNED_IN | typeof SIGNED_OUT) {
  const friendsList = vi.fn(async () => ({ ok: true as const, value: SNAP }));
  const myProfile = vi.fn(async () => ({ ok: true as const, value: PROFILE }));
  vi.stubGlobal("window", Object.assign(window, { otter: { friendsList, myProfile } }));
  useChat.setState({ account, friendsSnapshot: { friends: [], incoming: [], outgoing: [] }, friendError: null });
  return { friendsList, myProfile };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refreshSocialMirrors（#704）", () => {
  it("已登录：拉好友快照与本人资料，快照落进 store", async () => {
    const { friendsList, myProfile } = seed(SIGNED_IN);
    await useChat.getState().refreshSocialMirrors();
    // 两个 pull 是 void 出去的，各自等一拍
    await vi.waitFor(() => {
      expect(useChat.getState().friendsSnapshot).toBe(SNAP);
    });
    expect(friendsList).toHaveBeenCalledTimes(1);
    expect(myProfile).toHaveBeenCalledTimes(1);
  });

  it("未登录：一个都不拉——登出清场后不会被旧快照回填", async () => {
    const { friendsList, myProfile } = seed(SIGNED_OUT);
    await useChat.getState().refreshSocialMirrors();
    await new Promise((r) => setTimeout(r, 20));
    expect(friendsList).not.toHaveBeenCalled();
    expect(myProfile).not.toHaveBeenCalled();
  });

  it("补拉失败是 quiet 的：不落 friendError 横幅；用户自己点的刷新照旧落", async () => {
    const err = { ok: false as const, message: "网络断了" };
    const friendsList = vi.fn(async () => err);
    const myProfile = vi.fn(async () => ({ ok: true as const, value: PROFILE }));
    vi.stubGlobal("window", Object.assign(window, { otter: { friendsList, myProfile } }));
    useChat.setState({ account: SIGNED_IN, friendError: null });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await useChat.getState().refreshSocialMirrors();
    await vi.waitFor(() => expect(friendsList).toHaveBeenCalled());
    // quiet 那一路不该动 friendError
    await new Promise((r) => setTimeout(r, 20));
    expect(useChat.getState().friendError).toBeNull();
    expect(spy).toHaveBeenCalled();

    // 同一个动作，用户发起的那次（非 quiet）照旧把原因摆出来
    await useChat.getState().refreshFriends();
    expect(useChat.getState().friendError).toBe("网络断了");
  });
});

describe("调用点接线（#704 的病根是零调用，所以这里钉调用点）", () => {
  it("boot 与 onAccountChanged 两处都接着 refreshSocialMirrors", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "renderer", "src", "store.ts"),
      "utf8"
    );
    const calls = src.match(/void get\(\)\.refreshSocialMirrors\(\);/g) ?? [];
    expect(calls.length).toBe(2);
  });
});
