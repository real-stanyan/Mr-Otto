// request_app_connect —— 智能体请主人连一个连接器目录应用（#1666）。只管参数与目录解析；发不发卡在 sessionService
import { describe, expect, it } from "vitest";
import { createRequestAppConnectTool } from "../../services/runtime/src/requestAppConnectTool.js";
import { APP_CONNECT_WHY_MAX, REQUEST_APP_CONNECT_TOOL_NAME } from "../../src/shared/appConnect.js";

const mk = () => {
  const offered: { catalogId: string; appName: string; why: string }[] = [];
  const tool = createRequestAppConnectTool({ offer: (o) => (offered.push(o), "卡发出去了") });
  return { tool, offered };
};

describe("request_app_connect", () => {
  it("名字、必填 app+why、直接暴露、不走审批门；描述说清目录与「这一轮就停下」", () => {
    const { tool } = mk();
    expect(tool.def.name).toBe(REQUEST_APP_CONNECT_TOOL_NAME);
    expect(tool.def.parameters).toMatchObject({ required: ["app", "why"] });
    expect(tool.exposure).toBe("direct");
    expect(tool.requiresApproval).toBe(false);
    expect(tool.def.description).toContain("目录");
    expect(tool.def.description).toContain("这一轮就停下");
  });
  it("目录外的应用：抛错不发卡", async () => {
    const { tool, offered } = mk();
    await expect(tool.run({ app: "不存在的东西", why: "要用" }, null as never)).rejects.toThrow("目录里没有「不存在的东西」");
    expect(offered).toEqual([]);
  });
  it("手机上接不了的（blocked，如 vercel）：抛错带原因，不发卡", async () => {
    const { tool, offered } = mk();
    await expect(tool.run({ app: "vercel", why: "要部署" }, null as never)).rejects.toThrow(/Vercel/);
    expect(offered).toEqual([]);
  });
  it("why 空：抛「不能是空的」", async () => {
    const { tool, offered } = mk();
    await expect(tool.run({ app: "supabase", why: "  \n " }, null as never)).rejects.toThrow("不能是空的");
    expect(offered).toEqual([]);
  });
  it("why 超长：截到上限加「…」再交给 offer，不抛", async () => {
    const { tool, offered } = mk();
    await tool.run({ app: "supabase", why: "字".repeat(APP_CONNECT_WHY_MAX + 30) }, null as never);
    expect(offered[0]!.why).toBe(`${"字".repeat(APP_CONNECT_WHY_MAX)}…`);
  });
  it("正常：offer 收到目录 id / 名字 / 压过空白的 why，回 offer 的那句；按名字（大小写不敏感）也认", async () => {
    const { tool, offered } = mk();
    expect(await tool.run({ app: "Supabase", why: "要建  一张表\n存订单" }, null as never)).toBe("卡发出去了");
    expect(offered).toEqual([{ catalogId: "supabase", appName: "Supabase", why: "要建 一张表 存订单" }]);
  });
});
