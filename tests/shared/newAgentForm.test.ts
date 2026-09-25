// newAgentForm —— 手机「新建智能体」那张抽屉的纯逻辑（#1356 A2，spec §5.5）。
import { describe, expect, it, vi } from "vitest";
import { DUPLICATE_AGENT_NAME } from "../../src/shared/agentAdmin.js";
import { agentAvatarSlot } from "../../src/shared/agentAvatarSlot.js";
import { pickableFaces } from "../../src/shared/agentSettingsForm.js";
import type { FriendsResult } from "../../src/shared/friends.js";
import { createNewAgentFlow, defaultPickFor, newAgentNameError, type NewAgentPorts } from "../../src/shared/newAgentForm.js";
import { faceCharacterAt } from "../../src/shared/ottoFace/index.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const agent = (agentId: string, name: string): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
});
const WS: WorkspaceSnapshot = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [],
  agents: [agent("admin", "管理员"), agent("a_000000000001", "开发")],
};

describe("newAgentNameError", () => {
  it("空的 / 带空白 / 带 @：与落库前那道闸同一份 validateAgentName", () => {
    expect(newAgentNameError("", [])).toBe("名字不能为空");
    expect(newAgentNameError("收 发票", [])).toBe("名字里不能有空白");
    expect(newAgentNameError("发票@", [])).toContain("@");
  });
  it("按归一化之后的名字校验：全角 ＠ 归一化就是 @（落库前那道就是这么判的）", () => {
    expect(newAgentNameError("发票\uFF20", [])).toContain("@");
  });
  it("同名（含全角半角）→「已有同名的智能体」；前缀冲突两个方向都拦", () => {
    expect(newAgentNameError("开发", ["管理员", "开发"])).toBe(DUPLICATE_AGENT_NAME);
    expect(newAgentNameError("Ads", ["\uFF21\uFF44\uFF53"])).toBe(DUPLICATE_AGENT_NAME);
    expect(newAgentNameError("开发助手", ["开发"])).toMatch(/冲突/);
    expect(newAgentNameError("开", ["开发"])).toMatch(/冲突/);
  });
  it("合法 → null", () => {
    expect(newAgentNameError("发票", ["管理员", "开发"])).toBeNull();
    expect(newAgentNameError("  发票  ", ["管理员", "开发"])).toBeNull();
  });
});

describe("defaultPickFor", () => {
  const ids = Array.from({ length: 64 }, (_, i) => `a_${i.toString(16).padStart(12, "0")}`);
  it("默认选中这只 id 按名册派生会分到的那张；派生到墙外（cap 只借住在坑 2）就取墙上第一张", () => {
    const wall = pickableFaces();
    for (const id of ids) {
      const derived = faceCharacterAt(agentAvatarSlot(id, [...WS.agents.map((a) => a.agentId), id])).id;
      const pick = defaultPickFor(WS, id);
      if (wall.some((f) => f.id === derived)) expect(pick.id).toBe(derived);
      else expect(pick).toEqual(wall[0]);
    }
  });
  it("回的永远是墙上的一张（落库写的是它自己的坑位，不是暂借格）", () => {
    const wall = pickableFaces();
    for (const id of ids) expect(wall).toContainEqual(defaultPickFor(WS, id));
  });
});

function ports(o: { insert?: () => Promise<void>; dm?: () => Promise<FriendsResult<{ sessionId: string }>>; clear?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const p: NewAgentPorts = {
    insert: vi.fn(async () => { calls.push("insert"); await o.insert?.(); }),
    openDm: vi.fn(async () => { calls.push("dm"); return (await o.dm?.()) ?? { ok: true as const, value: { sessionId: "s1" } }; }),
    clearGreeting: vi.fn(async () => { calls.push("clear"); await o.clear?.(); }),
  };
  return { p, calls };
}
const INPUT = { name: "发票", avatarSlot: 5 };

describe("createNewAgentFlow", () => {
  it("两步都成：落行 → 建私聊，回 sessionId；再点一次不再落行也不再建", async () => {
    const { p, calls } = ports();
    const flow = createNewAgentFlow(p);
    expect(flow.step()).toBe("form");
    expect(await flow.submit(INPUT)).toEqual({ ok: true, sessionId: "s1" });
    expect(flow.step()).toBe("done");
    expect(await flow.submit(INPUT)).toEqual({ ok: true, sessionId: "s1" });
    expect(calls).toEqual(["insert", "dm"]);
    expect(p.insert).toHaveBeenCalledWith(INPUT);
  });
  it("私聊没建成：行留着（step=linking）、回一句说清哪一步没成；再试一次只重试私聊", async () => {
    let fail = true;
    const { p, calls } = ports({ dm: async () => (fail ? { ok: false, message: "云端无响应" } : { ok: true, value: { sessionId: "s9" } }) });
    const flow = createNewAgentFlow(p);
    const first = await flow.submit(INPUT);
    expect(first).toEqual({ ok: false, message: "它建好了，但还没接上线：云端无响应" });
    expect(flow.step()).toBe("linking");
    fail = false;
    expect(await flow.submit(INPUT)).toEqual({ ok: true, sessionId: "s9" });
    expect(calls).toEqual(["insert", "dm", "dm"]);
  });
  it("行没落成：回人话（同名 / 缺 migration 的原文都照翻）、下次点还是从落行开始", async () => {
    let n = 0;
    const { p, calls } = ports({ insert: async () => { if (n++ === 0) throw new Error(DUPLICATE_AGENT_NAME); } });
    const flow = createNewAgentFlow(p);
    expect(await flow.submit(INPUT)).toEqual({ ok: false, message: DUPLICATE_AGENT_NAME });
    expect(flow.step()).toBe("form");
    expect(await flow.submit(INPUT)).toEqual({ ok: true, sessionId: "s1" });
    expect(calls).toEqual(["insert", "insert", "dm"]);
  });
  it("不建了：只在「行已落、私聊没建成」时清那一格；没落行 / 已建成都不清", async () => {
    const a = ports();
    await createNewAgentFlow(a.p).abandon();
    expect(a.calls).toEqual([]);

    const b = ports({ dm: async () => ({ ok: false, message: "云端无响应" }) });
    const fb = createNewAgentFlow(b.p);
    await fb.submit(INPUT);
    await fb.abandon();
    expect(b.calls).toEqual(["insert", "dm", "clear"]);

    const c = ports();
    const fc = createNewAgentFlow(c.p);
    await fc.submit(INPUT);
    await fc.abandon();
    expect(c.calls).toEqual(["insert", "dm"]);
  });
  it("清那一格失败不抛（尽力而为）", async () => {
    const { p } = ports({ dm: async () => ({ ok: false, message: "x" }), clear: async () => { throw new Error("offline"); } });
    const flow = createNewAgentFlow(p);
    await flow.submit(INPUT);
    await expect(flow.abandon()).resolves.toBeUndefined();
  });
  it("同一时刻只跑一次：连点两下拿到的是同一个结果，只落一次行", async () => {
    let release = (): void => {};
    const { p, calls } = ports({ insert: () => new Promise<void>((r) => { release = r; }) });
    const flow = createNewAgentFlow(p);
    const a = flow.submit(INPUT);
    const b = flow.submit(INPUT);
    release();
    expect(await a).toEqual(await b);
    expect(calls).toEqual(["insert", "dm"]);
  });
});
