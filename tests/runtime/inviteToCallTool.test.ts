// invite_to_call（#1163）：agent 把人拉进语音通话那把刀。**不过审批门**——维护者拍板
// 「用户口头同意就行」，先问再调的纪律在提示词里（deriveMessages 的通话块）；这把刀
// 只管四条判据：没有通话 / 名单里没这个名字 / 已经在通话里 / 拉进来。
import { describe, expect, it } from "vitest";
import { createInviteToCallTool } from "../../services/runtime/src/inviteToCallTool.js";
import { INVITE_TO_CALL_TOOL_NAME, type VoiceCallState } from "../../src/shared/voiceCall.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld; // 这把刀不碰 world
const ROSTER = [
  { agentId: "admin", name: "管理员" },
  { agentId: "a_dev", name: "开发" },
  { agentId: "a_qa", name: "测试" },
];

function harness(call: VoiceCallState | null, roster: { agentId: string; name: string; degraded?: true }[] = ROSTER) {
  const invited: { agentId: string; name: string }[] = [];
  const tool = createInviteToCallTool({
    agentId: "a_dev",
    currentCall: () => call,
    roster: async () => roster,
    invite: (t) => { invited.push(t); },
  });
  return { tool, invited };
}
const call = (ids: string[]): VoiceCallState => ({
  participants: ids.map((id) => ({ agentId: id, name: ROSTER.find((r) => r.agentId === id)!.name })), sinceSeq: 1, sinceTs: 1,
});

describe("invite_to_call 工具", () => {
  it("工具名、不过审批门、初始可见、参数只要 name、描述里说先问用户", () => {
    const { tool } = harness(call(["a_dev"]));
    expect(tool.def.name).toBe(INVITE_TO_CALL_TOOL_NAME);
    expect(tool.requiresApproval).toBe(false);
    expect(tool.exposure ?? "direct").toBe("direct");
    expect((tool.def.parameters as { required: string[] }).required).toEqual(["name"]);
    expect(tool.def.description).toContain("先问");
  });

  it("成功：invite 一次、带 id 与名字，回执告诉模型可以 @ 了", async () => {
    const { tool, invited } = harness(call(["a_dev"]));
    const out = await tool.run({ name: "测试" }, world);
    expect(invited).toEqual([{ agentId: "a_qa", name: "测试" }]);
    expect(String(out)).toContain("已把「测试」拉进通话");
    expect(String(out)).toContain("@测试");
  });

  it("名字先 NFKC + trim：全角空格与兼容字符也认得", async () => {
    const { tool, invited } = harness(call(["a_dev"]));
    await tool.run({ name: " 测试　" }, world);
    expect(invited).toHaveLength(1);
  });

  it("没有通话：抛「没有语音通话」，不 invite", async () => {
    const { tool, invited } = harness(null);
    await expect(tool.run({ name: "测试" }, world)).rejects.toThrow("没有语音通话");
    expect(invited).toEqual([]);
  });

  it("名单里没这个名字：抛，提示看花名册；参数不是字符串也抛", async () => {
    const { tool, invited } = harness(call(["a_dev"]));
    await expect(tool.run({ name: "运营" }, world)).rejects.toThrow("没有叫「运营」的智能体");
    await expect(tool.run({}, world)).rejects.toThrow("name");
    expect(invited).toEqual([]);
  });

  it("已经在通话里：回一句、不 invite（幂等，别落第二条名单）", async () => {
    const { tool, invited } = harness(call(["a_dev", "a_qa"]));
    const out = await tool.run({ name: "测试" }, world);
    expect(String(out)).toContain("已经在通话里");
    expect(invited).toEqual([]);
  });

  it("名单读不出来（降级占位）：抛「读不出来」，不猜", async () => {
    const { tool, invited } = harness(call(["a_dev"]), [{ agentId: "default", name: "default", degraded: true as const }]);
    await expect(tool.run({ name: "测试" }, world)).rejects.toThrow("读不出来");
    expect(invited).toEqual([]);
  });
});
