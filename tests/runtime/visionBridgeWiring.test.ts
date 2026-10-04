// runtime 代读员的接线与纯判据（#1491 P4，ADR-0349）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModelAdapter } from "../../src/model/adapter.js";
import { bridgeModelFor, describeImagesWith, describePrompt } from "../../services/runtime/src/visionBridge.js";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("bridgeModelFor", () => {
  it("网关清单里最便宜那款带眼睛的；一款都没有 → null", () => {
    expect(bridgeModelFor(["deepseek-chat", "glm-4.6v-flash", "gpt-5.6-sol"])).toBe("glm-4.6v-flash");
    expect(bridgeModelFor(["glm-4.7-flash"])).toBeNull();
    expect(bridgeModelFor([])).toBeNull();
  });
});

describe("describeImagesWith", () => {
  it("非流式、一条 user、text + image_ref；空回复算失败", async () => {
    const calls: unknown[] = [];
    const adapter = {
      model: "v",
      chat: async (messages: unknown) => {
        calls.push(messages);
        return { content: "一只水獭", usage: { promptTokens: 10, completionTokens: 5 }, creditCostMicro: 7 };
      },
    } as unknown as ModelAdapter;
    const refs = [{ id: "sha256:" + "a".repeat(64), mediaType: "image/jpeg", bytes: 1 }];
    const d = await describeImagesWith(adapter, refs, "这是什么");
    expect(d).toEqual({ content: "一只水獭", usage: { promptTokens: 10, completionTokens: 5 }, creditCostMicro: 7 });
    expect(calls[0]).toEqual([{ role: "user", content: [{ type: "text", text: describePrompt("这是什么") }, { type: "image_ref", id: refs[0]!.id, mediaType: "image/jpeg" }] }]);
    const empty = { model: "v", chat: async () => ({ content: "   " }) } as unknown as ModelAdapter;
    await expect(describeImagesWith(empty, refs, "x")).rejects.toThrow(/没有产出/);
  });
  it("提示词与桌面那份逐字同一段", () => {
    const desktop = read("src/main/visionBridge.ts");
    expect(desktop).toContain("请逐张仔细解析以下图片(文字内容、版面结构、图表数据、关键细节)。");
    expect(describePrompt("q")).toContain("请逐张仔细解析以下图片(文字内容、版面结构、图表数据、关键细节)。");
  });
});

describe("sessionService / daemon 接线", () => {
  const svc = read("services/runtime/src/sessionService.ts");
  it("engineFor 之前先代读；判据是 prepare 之后的 model 查目录的 supportsVision", () => {
    expect(svc).toMatch(/await describeIfBlind\(job, runSpec\);\s*const engine = engineFor\(runSpec\);/);
    expect(svc).toMatch(/await probe\.prepare\?\.\(\);\s*const sees = findModel\(probe\.model\)\?\.supportsVision;/);
  });
  it("落的是 image_described{agentId, forSeq, route:'hosted'}；失败不拦 turn、落一句系统旁白", () => {
    expect(svc).toMatch(/type: "image_described",\s*content: d\.content, model, agentId: job\.agentId, forSeq: p\.seq, route: "hosted"/);
    expect(svc).toMatch(/logChat\("system", "系统", `看图模型（\$\{model\}）没读出来/);
  });
  it("daemon 给的代读员走托管 adapter + 附件库，账记在所有者名下（withUsage）", () => {
    const d = read("services/runtime/src/daemon.ts");
    expect(d).toMatch(/vision: \{\s*bridgeModel: async \(\) => \{/);
    expect(d).toMatch(/return bridgeModelFor\(me\.models\);/);
    expect(d).toMatch(/describeImagesWith\(\s*withUsage\(\s*createHostedRuntimeAdapter\(\{/);
    expect(d).toMatch(/preferredModels: \(\) => \[model\],/);
  });
});
