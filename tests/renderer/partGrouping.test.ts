import { describe, it, expect } from "vitest";
import { OTTO_GROUP_PARTS_BY } from "../../src/renderer/src/lib/partGrouping.js";

// groupBy 拿到的是 PartState;测试只喂它认的那几个字段,别为了类型把一整个
// 假 PartState 拼出来——那会把测试变成上游类型的镜子
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const path = (part: Record<string, unknown>): readonly string[] => OTTO_GROUP_PARTS_BY(part as any);

const CHAIN = "group-chainOfThought";

describe("消息 part 的分组路径", () => {
  it("思考走自己的子组 —— 不进工具时间线", () => {
    expect(path({ type: "reasoning", text: "嗯" })).toEqual([CHAIN, "group-reasoning"]);
  });

  it("工具调用走时间线子组", () => {
    expect(path({ type: "tool-call", toolName: "bash", toolCallId: "1" })).toEqual([
      CHAIN,
      "group-tool",
    ]);
  });

  it("旁白(narration)算工具那边,不算思考", () => {
    // 「bash → 说一句 → bash」要留在一条时间线里:旁白若归到思考那一组,
    // 相邻合并会把这一段切成三块
    expect(path({ type: "reasoning", text: "我看一下", narration: true })).toEqual([
      CHAIN,
      "group-tool",
    ]);
  });

  it("思考与工具是**兄弟**而不是同一组 —— 这是「思考拿出时间线」的判据", () => {
    const think = path({ type: "reasoning", text: "嗯" });
    const tool = path({ type: "tool-call", toolName: "bash", toolCallId: "1" });
    expect(think[0]).toBe(tool[0]); // 同在过程区
    expect(think[1]).not.toBe(tool[1]); // 但各有各的折叠头
  });

  it("ask_user 不进时间线 —— 答卷卡留在过程区顶层,不跟着工具组折叠", () => {
    // 答卷是用户说过的话、后面每一步的前提;收进折叠区等于把前提藏起来。
    // 原先靠「组内有答卷就自动展开整组」补救,现在组根本不收它
    expect(path({ type: "tool-call", toolName: "ask_user", toolCallId: "1" })).toEqual([CHAIN]);
  });

  it("正文不分组 —— 最终回复留在过程区外", () => {
    expect(path({ type: "text", text: "好了" })).toEqual([]);
  });

  it("来源 chip 排成一行,不跟着过程折叠", () => {
    expect(path({ type: "source", id: "s1" })).toEqual(["group-sources"]);
  });
});
