// relay_to_owner —— 外联里管理员替朋友带话给自己主人（#1655）。只管参数；找房 / 封顶在 outreachHub
import { describe, expect, it } from "vitest";
import { createRelayToOwnerTool } from "../../services/runtime/src/relayToOwnerTool.js";
import { RELAY_TEXT_MAX, RELAY_TO_OWNER_TOOL_NAME } from "../../src/shared/outreach.js";

const mk = () => {
  const sent: string[] = [];
  const tool = createRelayToOwnerTool({ send: async (t) => (sent.push(t), "带到了") });
  return { tool, sent };
};

describe("relay_to_owner", () => {
  it("名字、必填 text、直接暴露、不走审批门；描述说清什么时候用、别替主人答应", () => {
    const { tool } = mk();
    expect(tool.def.name).toBe(RELAY_TO_OWNER_TOOL_NAME);
    expect(tool.def.parameters).toMatchObject({ required: ["text"] });
    expect(tool.exposure).toBe("direct");
    expect(tool.requiresApproval).toBe(false);
    expect(tool.def.description).toContain("拍板");
    expect(tool.def.description).toContain("别替主人答应");
  });
  it("正文压空白后交给 send，回 send 的那句", async () => {
    const { tool, sent } = mk();
    expect(await tool.run({ text: "  周五\n借车  " }, null as never)).toBe("带到了");
    expect(sent).toEqual(["周五 借车"]);
  });
  it("空的 / 超长：抛错不发", async () => {
    const { tool, sent } = mk();
    await expect(tool.run({ text: "  " }, null as never)).rejects.toThrow("不能是空的");
    await expect(tool.run({ text: "字".repeat(RELAY_TEXT_MAX + 1) }, null as never)).rejects.toThrow(String(RELAY_TEXT_MAX));
    expect(sent).toEqual([]);
  });
});
