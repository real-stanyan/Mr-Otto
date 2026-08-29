// @vitest-environment jsdom
//
// 好友搜索命中行（issue #711）。原来那行只有一个名字 + 「发请求」按钮：
// 同名的人搜出来就是两行一模一样的字，用户没法判断该给谁发请求。
//
// 两条断言对着两个不同的失败：
// ① 每行有头像——好友列表、请求列表、GitGraph 一直有，唯独搜索结果没有（手机端
//    从一开始就画了，是桌面这一侧漏了）
// ② 有名字时把邮箱补成第二行——头像相同或都没设头像时，邮箱是唯一的判据
//
// 头像断言盯的是 data-slot="avatar" 这个壳而不是 <img>：Radix 的 AvatarImage 要等
// 图真的 load 完才换掉 fallback，jsdom 里那个 load 事件永远不来，断 <img> 必然假红。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { FriendsSection } from "../../src/renderer/src/components/FriendsSection.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { FriendProfile } from "../../src/shared/friends.js";

const HITS: FriendProfile[] = [
  { id: "u1", email: "stan@a.com", name: "Stan Yan", avatarUrl: "https://img/1.png" },
  { id: "u2", email: "stan@b.com", name: "Stan Yan", avatarUrl: "" },
  { id: "u3", email: "stanhavenoidea+cloudtest@x.com", name: "", avatarUrl: "" },
];

function seed(): void {
  vi.stubGlobal("window", Object.assign(window, { otter: {} }));
  useChat.setState({
    account: { signedIn: true, email: "me@x.com", name: "我", avatarUrl: "" },
    friendsSnapshot: { friends: [], incoming: [], outgoing: [] },
    onlineIds: [],
    unreadByFriend: {},
    friendError: null,
    realtimeHealth: "live",
    searchFriend: async () => HITS,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("好友搜索的命中行（issue #711）", () => {
  it("每一行都带头像——搜到的人是谁，先看脸", async () => {
    seed();
    const user = userEvent.setup();
    const { container } = render(<FriendsSection embedded />);

    await user.type(screen.getByPlaceholderText("搜用户名或邮箱加好友"), "stan");
    await waitFor(() => expect(screen.getAllByRole("button", { name: "发请求" })).toHaveLength(3));

    // 三行命中 = 三个头像壳（组件本身此时没有别的头像：好友/请求列表都是空的）
    expect(container.querySelectorAll('[data-slot="avatar"]')).toHaveLength(3);
  });

  it("有名字时邮箱补成第二行——同名的人只能靠它分辨", async () => {
    seed();
    const user = userEvent.setup();
    render(<FriendsSection embedded />);

    await user.type(screen.getByPlaceholderText("搜用户名或邮箱加好友"), "stan");
    await waitFor(() => expect(screen.getAllByText("Stan Yan")).toHaveLength(2));

    // 两个同名的人，靠邮箱分辨
    expect(screen.getByText("stan@a.com")).toBeInTheDocument();
    expect(screen.getByText("stan@b.com")).toBeInTheDocument();
    // 没设名字的那位，主行已经是邮箱了，不该再重复一遍
    expect(screen.getAllByText("stanhavenoidea+cloudtest@x.com")).toHaveLength(1);
  });
});
