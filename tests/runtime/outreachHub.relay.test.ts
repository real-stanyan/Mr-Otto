// outreachHub 的带话两条路（#1655）：找房、档位、每小时窗、回给模型的话
import { describe, expect, it } from "vitest";
import { createOutreachHub, type OutreachHubDeps } from "../../services/runtime/src/outreachHub.js";
import { RELAY_TO_OWNER_PER_HOUR_MAX } from "../../src/shared/outreach.js";

function deps(over: Partial<OutreachHubDeps> = {}): OutreachHubDeps {
  return {
    friendsOf: async () => [{ uid: "u-stan", name: "Stan", tier: "full" }],
    deviceCount: async () => 1, ownerBlocked: async () => null, activeFor: async () => false,
    ensureSession: async () => { throw new Error("不该建"); }, origin: async () => null,
    agentName: async () => "雨姐", labelOf: async (uid) => (uid === "owner" ? "继爸" : uid),
    newId: () => "id", now: () => 1_000_000, log: () => {}, sendDm: async () => {},
    ...over,
  };
}
const R = { workspaceId: "w", ownerUid: "owner", agentName: "雨姐", peerUid: "u-stan", peerName: "Stan", text: "周五借车行吗" };

describe("relayToOwner", () => {
  it("开主人的管理员私聊、落带话开场白（含原话与名字）、回 relaySentText", async () => {
    const texts: string[] = [];
    const hub = createOutreachHub(deps({ ownerDm: async () => ({ relayFromFriend: async (r) => (texts.push(r.text), "ok") }) }));
    const out = await hub.relayToOwner(R);
    expect(texts[0]).toContain("周五借车行吗");
    expect(texts[0]).toContain("继爸");
    expect(out).toContain("已经带给 继爸 了");
  });
  it("没接 ownerDm / 找不到私聊 / 开房抛错 / no_agent：回「没带到」，不抛", async () => {
    for (const ownerDm of [undefined, async () => null, async () => { throw new Error("x"); }, async () => ({ relayFromFriend: async () => "no_agent" as const })]) {
      const hub = createOutreachHub(deps(ownerDm === undefined ? {} : { ownerDm }));
      expect(await hub.relayToOwner(R)).toContain("没带到");
    }
  });
  it(`每小时第 ${RELAY_TO_OWNER_PER_HOUR_MAX + 1} 次被拒；失败的不计数`, async () => {
    let ok = 0;
    const hub = createOutreachHub(deps({ ownerDm: async () => ({ relayFromFriend: async () => (ok++, "ok") }) }));
    for (let i = 0; i < RELAY_TO_OWNER_PER_HOUR_MAX; i++) await hub.relayToOwner(R);
    expect(await hub.relayToOwner(R)).toContain("这一小时");
    expect(ok).toBe(RELAY_TO_OWNER_PER_HOUR_MAX);
  });
  it("失败不占窗：连失败几次之后成功仍然带得出去", async () => {
    let fail = true;
    const hub = createOutreachHub(deps({ ownerDm: async () => ({ relayFromFriend: async () => (fail ? "no_agent" as const : "ok" as const) }) }));
    for (let i = 0; i < RELAY_TO_OWNER_PER_HOUR_MAX + 2; i++) expect(await hub.relayToOwner(R)).toContain("没带到");
    fail = false;
    expect(await hub.relayToOwner(R)).toContain("已经带给");
  });
});

describe("replyToFriend", () => {
  const P = { workspaceId: "w", ownerUid: "owner", agentId: "admin", agentName: "雨姐", friend: "Stan", text: "行" };
  it("解析好友、找外联房、落回话开场白、回 ownerReplySentText", async () => {
    const seen: unknown[] = [];
    const texts: string[] = [];
    const hub = createOutreachHub(deps({
      outreachRoom: async (...a) => (seen.push(a), { ownerReply: async (r) => (texts.push(r.text), "ok") }),
    }));
    const out = await hub.replyToFriend(P);
    expect(seen).toEqual([["w", "admin", "u-stan"]]);
    expect(texts[0]).toContain("行");
    expect(out).toContain("Stan");
  });
  it("没有那条线：让它改用 message_friend", async () => {
    const hub = createOutreachHub(deps({ outreachRoom: async () => null }));
    expect(await hub.replyToFriend(P)).toContain("message_friend");
  });
  it("没这个好友 / 档位不够：同 message 的口径", async () => {
    expect(await createOutreachHub(deps({ outreachRoom: async () => null })).replyToFriend({ ...P, friend: "小明" })).toContain("好友里没有叫「小明」的");
    const low = createOutreachHub(deps({ friendsOf: async () => [{ uid: "u-stan", name: "Stan", tier: "agents" }], outreachRoom: async () => null }));
    expect(await low.replyToFriend(P)).toContain("全部开放");
  });
});
