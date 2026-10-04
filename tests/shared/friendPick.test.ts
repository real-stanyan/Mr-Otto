// 选人卡的判定与折叠（#1520）：纯函数，runtime 与手机共用
import { describe, expect, it } from "vitest";
import {
  FRIEND_PICK_TTL_MS, friendPickFailureText, friendPickFoldOf, friendPickStatus, friendPickToolText, namesSimilar, pickFriend, recentPeerUids,
} from "../../src/shared/friendPick.js";
import { outreachFoldOf } from "../../src/shared/outreach.js";
import { outreachTierProblem } from "../../src/shared/friendTier.js";
import type { SessionEvent } from "../../src/session/events.js";

const F = (uid: string, name: string, tier?: "chat" | "agents" | "full") => ({ uid, name, ...(tier !== undefined ? { tier } : {}) });

describe("namesSimilar", () => {
  it("包含：短的一边至少 2 个字", () => {
    expect(namesSimilar("小明", "王小明")).toBe(true);
    expect(namesSimilar("明", "王小明")).toBe(false);
  });
  it("有一个相同的词（至少 2 个字），大小写与空白不计", () => {
    expect(namesSimilar("Mingxuan Zhang", "mingxuan zhou")).toBe(true);
    expect(namesSimilar("Li Zhang", "Wu Zhang")).toBe(true);
  });
  it("编辑距离 ≤ ⌊较长 / 3⌋，较长至少 3 个字", () => {
    expect(namesSimilar("张明轩", "张铭轩")).toBe(true);
    expect(namesSimilar("小红", "小绿")).toBe(false); // 较长只有 2 个字
    expect(namesSimilar("Mingxuan Zhang", "爸爸")).toBe(false);
  });
});

describe("pickFriend", () => {
  const friends = [F("u_baba", "爸爸"), F("u_mz", "Mingxuan Zhou"), F("u_hong", "小红"), F("u_lee", "小李")];

  it("精确命中一人：直接拨", () => {
    expect(pickFriend({ friends, wanted: "小红", recentUids: [] })).toEqual({ kind: "dial", uid: "u_hong", name: "小红" });
  });

  it("精确命中一人但档位不够：回拒绝那句（同现状）", () => {
    const r = pickFriend({ friends: [F("u_hong", "小红", "chat")], wanted: "小红", recentUids: [] });
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.message).toContain("全部开放");
  });

  it("截图那一例：旧名字对不上，最近打过的（改了名）排第一，名字相近的跟在后面", () => {
    const r = pickFriend({ friends, wanted: "Mingxuan Zhang", recentUids: ["u_baba"] });
    expect(r).toEqual({
      kind: "card",
      question: "好友里没有叫「Mingxuan Zhang」的。你要打给哪位？点一下我就拨。",
      candidates: [
        { uid: "u_baba", name: "爸爸", why: "上次打的就是他" },
        { uid: "u_mz", name: "Mingxuan Zhou", why: "名字相近" },
      ],
    });
  });

  it("重名：同名的都上卡，与最近打过重叠写「同名 · 最近打过」，且排前面", () => {
    const fs = [F("x1", "小明"), F("x2", "小明"), F("u_hong", "小红")];
    const r = pickFriend({ friends: fs, wanted: "小明", recentUids: ["u_hong", "x2"] });
    expect(r).toEqual({
      kind: "card",
      question: "好友里有 2 位叫「小明」。你要打给哪位？点一下我就拨。",
      candidates: [
        { uid: "u_hong", name: "小红", why: "上次打的就是他" },
        { uid: "x2", name: "小明", why: "同名 · 最近打过" },
        { uid: "x1", name: "小明", why: "同名" },
      ],
    });
  });

  it("模型给了 candidates：按名字换成好友、不附理由、问话是通用那句", () => {
    const r = pickFriend({ friends, wanted: "她", candidates: ["小红", "小李"], recentUids: ["u_baba"] });
    expect(r).toEqual({
      kind: "card",
      question: "你要打给哪位？点一下我就拨。",
      candidates: [{ uid: "u_hong", name: "小红", why: "" }, { uid: "u_lee", name: "小李", why: "" }],
    });
  });

  it("模型的 candidates 一个都对不上 / 都打不了：当没给，回到按 wanted 判", () => {
    expect(pickFriend({ friends, wanted: "小红", candidates: ["大刘", "老王"], recentUids: [] }))
      .toEqual({ kind: "dial", uid: "u_hong", name: "小红" });
  });

  it("不能打的人不上卡；一个能打的都没有就回现在那句文字", () => {
    const fs = [F("x1", "小明", "chat"), F("x2", "小明", "agents")];
    const r = pickFriend({ friends: fs, wanted: "小明", recentUids: [] });
    expect(r).toEqual({ kind: "text", message: "好友里有 2 位叫「小明」，分不出是哪一位，问问他。" });
    const none = pickFriend({ friends, wanted: "大刘", recentUids: [] });
    expect(none).toEqual({ kind: "text", message: "好友里没有叫「大刘」的。他的好友有：爸爸、Mingxuan Zhou、小红、小李。问问他指的是哪一位。" });
    expect(pickFriend({ friends: [], wanted: "大刘", recentUids: [] })).toEqual({ kind: "text", message: "他还没有好友，打不了。" });
  });

  it("最多 4 位", () => {
    const fs = ["a", "b", "c", "d", "e"].map((x) => F(`u_${x}`, `小明${x}`));
    const r = pickFriend({ friends: fs, wanted: "小明", recentUids: [] });
    expect(r.kind === "card" ? r.candidates.length : -1).toBe(4);
  });

  it("最近打过但已不是好友：不上卡", () => {
    const r = pickFriend({ friends, wanted: "Mingxuan Zhang", recentUids: ["u_gone", "u_baba"] });
    expect(r.kind === "card" ? r.candidates.map((c) => c.uid) : []).toEqual(["u_baba", "u_mz"]);
  });

  it("排在最近第一位的人已不是好友：第二位不顶替「上次打的就是他」，写「最近打过」（M-5 的裁定）", () => {
    const r = pickFriend({ friends, wanted: "Mingxuan Zhang", recentUids: ["u_gone", "u_baba"] });
    expect(r.kind === "card" ? r.candidates[0] : null).toEqual({ uid: "u_baba", name: "爸爸", why: "最近打过" });
  });
});

describe("friendPickFailureText（I-2：模型向的拒绝改成对主人说的话）", () => {
  it("去掉开头的「电话没打出去：」", () => {
    expect(friendPickFailureText("电话没打出去：额度用完了，周五恢复")).toBe("额度用完了，周五恢复");
  });
  it("档位拒绝：「告诉他…」那句整句删掉", () => {
    const out = friendPickFailureText(outreachTierProblem("agents", "小红")!);
    expect(out).not.toContain("告诉他");
    expect(out).toBe("小红 没有把好友权限开到「全部开放」，智能体不能直接给 小红 打电话或发消息。");
  });
  it("没有设备：保留前一句", () => {
    expect(friendPickFailureText("小红 的手机上还没有能接电话的 App，打不了。告诉他换个方式联系。"))
      .toBe("小红 的手机上还没有能接电话的 App，打不了。");
  });
  it("删完是空的：落到通用那句", () => {
    expect(friendPickFailureText("告诉他换个方式联系。")).toBe("电话没打出去，稍后再试。");
    expect(friendPickFailureText("电话没打出去：")).toBe("电话没打出去，稍后再试。");
  });
  it("本来就是对主人说的话：原样", () => {
    expect(friendPickFailureText("电话没打出去，稍后再试。")).toBe("电话没打出去，稍后再试。");
  });
});

let seq = 0;
const ev = (o: Record<string, unknown>, ts = 1000): SessionEvent => ({ seq: seq++, sessionId: "s", ts, ...o }) as unknown as SessionEvent;
const offered = (pickId: string, ts = 1000) => ev({
  type: "friend_pick", pickId, phase: "offered", fromAgentId: "ops", question: "q",
  candidates: [{ uid: "u1", name: "小红", why: "" }], brief: "b", opening: "o", ignorable: true,
}, ts);

describe("friendPickFold / friendPickStatus", () => {
  it("offered 之后是 open；10 分钟整还开着，过了就 expired", () => {
    seq = 0;
    const st = friendPickFoldOf([offered("p1")]).get("p1")!;
    expect(st).toMatchObject({ pickId: "p1", fromAgentId: "ops", brief: "b", opening: "o", phase: "offered", superseded: false });
    expect(friendPickStatus(st, 1000 + FRIEND_PICK_TTL_MS)).toBe("open");
    expect(friendPickStatus(st, 1001 + FRIEND_PICK_TTL_MS)).toBe("expired");
  });

  it("最后一条说了算：picked → failed 带 message", () => {
    seq = 0;
    const fold = friendPickFoldOf([
      offered("p1"),
      ev({ type: "friend_pick", pickId: "p1", phase: "picked", fromAgentId: "ops", uid: "u1", ignorable: true }),
      ev({ type: "friend_pick", pickId: "p1", phase: "failed", fromAgentId: "ops", message: "没设备", ignorable: true }),
    ]);
    const st = fold.get("p1")!;
    expect(st.uid).toBe("u1");
    expect(st.message).toBe("没设备");
    expect(friendPickStatus(st, 1000)).toBe("failed");
  });

  it("新卡顶掉还开着的旧卡；已经点过的旧卡不受影响", () => {
    seq = 0;
    const fold = friendPickFoldOf([
      offered("p0"),
      ev({ type: "friend_pick", pickId: "p0", phase: "dismissed", fromAgentId: "ops", ignorable: true }),
      offered("p1"),
      offered("p2"),
    ]);
    expect(friendPickStatus(fold.get("p0")!, 1000)).toBe("dismissed");
    expect(friendPickStatus(fold.get("p1")!, 1000)).toBe("expired");
    expect(friendPickStatus(fold.get("p2")!, 1000)).toBe("open");
  });

  it("没有 offered 开头（窗口裁掉了）：不入账", () => {
    seq = 0;
    expect(friendPickFoldOf([ev({ type: "friend_pick", pickId: "p9", phase: "picked", fromAgentId: "ops", uid: "u1", ignorable: true })]).size).toBe(0);
  });
});

describe("recentPeerUids / friendPickToolText", () => {
  it("按 started 的时间新的在前、去重", () => {
    seq = 0;
    const fold = outreachFoldOf([
      ev({ type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops", peerUid: "a", peerName: "A", ignorable: true }, 1),
      ev({ type: "outreach", phase: "started", outreachId: "o2", fromAgentId: "ops", peerUid: "b", peerName: "B", ignorable: true }, 2),
      ev({ type: "outreach", phase: "started", outreachId: "o3", fromAgentId: "ops", peerUid: "a", peerName: "A", ignorable: true }, 3),
    ]);
    expect(recentPeerUids(fold)).toEqual(["a", "b"]);
  });
  it("工具回模型的那句", () => {
    expect(friendPickToolText(["爸爸", "Mingxuan Zhou"])).toBe(
      "没认准是哪位，已经弹了张卡让他点选（候选：爸爸、Mingxuan Zhou）。卡片自己会问，你这一轮不用再说话；他点了电话会直接拨出去，不用你再调 call_friend。",
    );
  });
});
