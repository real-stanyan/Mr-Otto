import { describe, expect, it } from "vitest";
import { planChatCreate } from "../../services/runtime/src/chatCreate.js";

const TEAM = [
  { agentId: "admin", name: "管理员" },
  { agentId: "a_000000000001", name: "运营" },
  { agentId: "a_000000000002", name: "开发" },
];

describe("planChatCreate（#1280）", () => {
  it("私聊：一只，标题恒空（界面写的是智能体名）", () => {
    expect(planChatCreate({ kind: "dm", agentId: "a_000000000001" }, TEAM)).toEqual({
      ok: true,
      chatKind: "dm",
      agentIds: ["a_000000000001"],
      title: "",
      entries: [{ agentId: "a_000000000001", name: "运营" }],
    });
  });

  it("群聊：标题就是群名；名单按团队名单的顺序落，不按勾选的先后", () => {
    const r = planChatCreate({ kind: "group", name: "上线冲刺", agentIds: ["a_000000000002", "admin"] }, TEAM);
    expect(r).toMatchObject({
      ok: true,
      chatKind: "group",
      title: "上线冲刺",
      agentIds: ["admin", "a_000000000002"],
    });
  });

  it("名单里没有的那只：说清有几只，不建", () => {
    expect(planChatCreate({ kind: "dm", agentId: "a_00000000dead" }, TEAM)).toEqual({
      ok: false,
      message: "这只智能体已经不在了（名单可能刚变过，刷新再试）",
    });
    expect(planChatCreate({ kind: "group", name: "群", agentIds: ["admin", "a_00000000dead"] }, TEAM)).toEqual({
      ok: false,
      message: "有 1 只智能体已经不在了（名单可能刚变过，刷新再试）",
    });
  });

  it("建群至少两只（库里的下限更松，是给删智能体留的路，不是给建群留的）", () => {
    expect(planChatCreate({ kind: "group", name: "群", agentIds: ["admin"] }, TEAM)).toEqual({
      ok: false,
      message: "群聊至少要两只智能体",
    });
  });

  it("团队名单读不出来时不建：拿一份降级名单去核对，等于核对了个寂寞", () => {
    expect(
      planChatCreate({ kind: "dm", agentId: "admin" }, [{ agentId: "admin", name: "管理员", degraded: true }]),
    ).toEqual({ ok: false, message: "智能体名单这会儿读不出来，稍后再试" });
  });
});
