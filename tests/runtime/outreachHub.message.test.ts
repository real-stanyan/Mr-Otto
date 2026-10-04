// outreachHub.message —— message_friend 的出口（#1549）：解析好友、档位、每小时窗、以主人名义落库。daemon.ts 进不了 vitest，判断都在这里验。
import { describe, expect, it } from "vitest";
import { createOutreachHub, type OutreachHubDeps } from "../../services/runtime/src/outreachHub.js";
import { FRIEND_MESSAGE_PER_HOUR_MAX } from "../../src/shared/outreach.js";

const MSG = { workspaceId: "w1", ownerUid: "owner", agentId: "admin", agentName: "管理员", friend: "小红", text: "三条原话：设置公开智能体、跑迁移、出新包" };

function rig(over: Partial<OutreachHubDeps> = {}) {
  const sent: unknown[][] = [];
  const logs: string[] = [];
  let t = 1_000_000;
  const deps: OutreachHubDeps = {
    friendsOf: async () => [{ uid: "u-hong", name: "小红", tier: "full" }, { uid: "u-ming", name: "小明", tier: "full" }],
    deviceCount: async () => { throw new Error("发消息不该查设备"); },
    ownerBlocked: async () => { throw new Error("发消息不该查额度"); },
    activeFor: async () => { throw new Error("发消息不该查在打的电话"); },
    ensureSession: async () => { throw new Error("发消息不建会话"); },
    origin: async () => { throw new Error("发消息不开原会话房"); },
    agentName: async () => "管理员",
    labelOf: async (uid) => uid,
    newId: () => "id",
    now: () => t,
    log: (m) => void logs.push(m),
    sendDm: async (...a) => void sent.push(a),
    ...over,
  };
  return { hub: createOutreachHub(deps), sent, logs, tick: (ms: number) => void (t += ms) };
}

describe("outreachHub.message", () => {
  it("正常：以主人名义（sender = owner）写给解析出的好友，正文带「[<智能体> 代发]」前缀，回话说清对方看到什么", async () => {
    const r = rig();
    const msg = await r.hub.message(MSG);
    expect(r.sent).toEqual([["owner", "u-hong", `[管理员 代发] ${MSG.text}`]]);
    expect(msg).toContain("小红");
    expect(msg).toContain("[管理员 代发]");
    expect(msg).toContain("看不到");
  });

  it("好友查不出来：「稍后再试」，不当成没有好友，不落库", async () => {
    const r = rig({ friendsOf: async () => { throw new Error("db down"); } });
    const msg = await r.hub.message(MSG);
    expect(msg).toContain("稍后再试");
    expect(msg).not.toContain("没有好友");
    expect(r.sent).toEqual([]);
    expect(r.logs.join("\n")).toContain("db down");
  });

  it("没有这个好友：回名单让它问主人；一个都没有；重名——三种都不落库", async () => {
    const a = rig();
    const none = await a.hub.message({ ...MSG, friend: "大刘" });
    expect(none).toContain("小红");
    expect(none).toContain("小明");
    expect(await rig({ friendsOf: async () => [] }).hub.message(MSG)).toContain("没有好友");
    expect(await rig({ friendsOf: async () => [{ uid: "a", name: "小红" }, { uid: "b", name: "小红" }] }).hub.message(MSG)).toContain("分不出");
    expect(a.sent).toEqual([]);
  });

  it("档位没开到全部开放：拒，话里说清是档位（文案本来就写着「打电话或发消息」）；没给档位照旧放（老调用方）", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "u-hong", name: "小红", tier: "agents" }] });
    const msg = await r.hub.message(MSG);
    expect(msg).toContain("全部开放");
    expect(msg).toContain("发消息");
    expect(r.sent).toEqual([]);
    const legacy = rig({ friendsOf: async () => [{ uid: "u-hong", name: "小红" }] });
    await legacy.hub.message(MSG);
    expect(legacy.sent).toHaveLength(1);
  });

  it("写不进去：回「稍后再试」并记日志，窗口不计这一条", async () => {
    const r = rig({ sendDm: async () => { throw new Error("rls"); } });
    expect(await r.hub.message(MSG)).toContain("稍后再试");
    expect(r.logs.join("\n")).toContain("rls");
  });

  it(`每（主场，智能体，好友）每小时封顶 ${FRIEND_MESSAGE_PER_HOUR_MAX} 条：到顶拒，换一位好友不受影响，过一小时放开`, async () => {
    const r = rig();
    for (let i = 0; i < FRIEND_MESSAGE_PER_HOUR_MAX; i++) expect(await r.hub.message(MSG)).not.toContain("上限");
    expect(await r.hub.message(MSG)).toContain("上限");
    expect(r.sent).toHaveLength(FRIEND_MESSAGE_PER_HOUR_MAX);
    expect(await r.hub.message({ ...MSG, friend: "小明" })).not.toContain("上限");
    r.tick(60 * 60_000 + 1);
    expect(await r.hub.message(MSG)).not.toContain("上限");
  });
});
