import { describe, expect, it } from "vitest";
import { createHumansProblem, friendSetOf, friendshipFilter, planHumansChange } from "../../services/runtime/src/chatHumans.js";

const ME = "00000000-0000-4000-8000-0000000000aa";
const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";

describe("friendshipFilter（#1393）", () => {
  it("两个方向都查；只拼 uid 形状的候选，自己跳过", () => {
    expect(friendshipFilter(ME, [U1, "x),or(requester.neq.0", ME, U2])).toBe(
      `and(requester.eq.${ME},addressee.in.(${U1},${U2})),and(addressee.eq.${ME},requester.in.(${U1},${U2}))`,
    );
  });
  it("没有可查的候选 / 自己不是 uid：null（调用方不查库，当成一个朋友都没有）", () => {
    expect(friendshipFilter(ME, [])).toBeNull();
    expect(friendshipFilter(ME, ["bad"])).toBeNull();
    expect(friendshipFilter(ME, [ME])).toBeNull();
    expect(friendshipFilter("bad", [U1])).toBeNull();
  });
});

describe("friendSetOf", () => {
  it("两个方向都认、取对方；跟自己无关的行不算", () => {
    const set = friendSetOf(ME, [
      { requester: ME, addressee: U1 },
      { requester: U2, addressee: ME },
      { requester: U1, addressee: U2 },
    ]);
    expect([...set].sort()).toEqual([U1, U2].sort());
  });
});

describe("planHumansChange", () => {
  const nameOf = (uid: string) => (uid === U2 ? "小明" : "？");
  it("留下的人沿用日志里的名字快照（改名不改史），新来的现取", () => {
    const r = planHumansChange({
      actorUid: ME, actorIsOwner: true, ownerUid: ME,
      before: [{ uid: U1, name: "小红（旧名）" }], after: [U1, U2],
      friendsOfActor: new Set([U2]), nameOf,
    });
    expect(r).toEqual({ ok: true, next: [{ uid: U1, name: "小红（旧名）" }, { uid: U2, name: "小明" }], added: [U2], removed: [] });
  });
  it("不允许时回那句人话，不回半份名单", () => {
    const r = planHumansChange({
      actorUid: U1, actorIsOwner: false, ownerUid: ME,
      before: [{ uid: U1, name: "小红" }, { uid: U2, name: "小明" }], after: [U1],
      friendsOfActor: new Set(), nameOf,
    });
    expect(r).toEqual({ ok: false, message: "只有群主能把别人移出群聊。" });
  });
  it("客人退出：removed 里是他自己", () => {
    const r = planHumansChange({
      actorUid: U1, actorIsOwner: false, ownerUid: ME,
      before: [{ uid: U1, name: "小红" }], after: [],
      friendsOfActor: new Set(), nameOf,
    });
    expect(r).toEqual({ ok: true, next: [], added: [], removed: [U1] });
  });
});

describe("createHumansProblem", () => {
  it("没拉人：null（今天的建群一字不变）", () => {
    expect(createHumansProblem({ creatorUid: ME, humans: [], friendsOfCreator: new Set(), home: false })).toBeNull();
  });
  it("团队里的群不收朋友：团队有自己的成员名单", () => {
    expect(createHumansProblem({ creatorUid: ME, humans: [U1], friendsOfCreator: new Set([U1]), home: false })).toBe(
      "团队里的群聊拉人走团队成员。",
    );
  });
  it("主场：只能拉朋友、不能拉自己", () => {
    expect(createHumansProblem({ creatorUid: ME, humans: [U1], friendsOfCreator: new Set([U1]), home: true })).toBeNull();
    expect(createHumansProblem({ creatorUid: ME, humans: [U1, U2], friendsOfCreator: new Set([U1]), home: true })).toBe(
      "只能拉你的朋友进群。",
    );
    expect(createHumansProblem({ creatorUid: ME, humans: [ME], friendsOfCreator: new Set([ME]), home: true })).toBe("你本来就在群里。");
  });
});
