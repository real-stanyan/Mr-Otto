// session_search 的端到端真链路：真 EventStore + 真 historyCapability + 真工具，
// 不打桩任何一层——上面几个模块的单测各自假设"下面那层"是对的，这个测试
// 校验它们焊在一起真的对得上（HistoryCapability 接口两头的实现一致）。
import { describe, it, expect } from "vitest";
import { EventStore } from "../../src/session/store.js";
import { createHistoryCapability } from "../../src/main/historyCapability.js";
import { createSessionSearchTool, parseSessionSearchResult } from "../../src/tools/sessionSearch.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function seed(store: EventStore, sessionId: string, content: string) {
  store.append({ sessionId, ts: 1, type: "session_created", workspace: "/w" });
  const userMsg = store.append({ sessionId, ts: 2, type: "user_message", content });
  store.append({ sessionId, ts: 3, type: "assistant_message", content: "记下了", model: "m" });
  return userMsg;
}

async function text(tool: ReturnType<typeof createSessionSearchTool>, args: unknown, world: ExecutionWorld) {
  const r = await tool.run(args, world);
  return typeof r === "string" ? r : r.output;
}

describe("session_search 真链路（EventStore + historyCapability + 工具）", () => {
  it("discovery 命中另一会话，read 读回自己那段，当前会话被自我排除", async () => {
    const store = new EventStore(":memory:");
    const userMsgA = seed(store, "A", "用户住悉尼北区");
    seed(store, "B", "今天改了 vitest 配置"); // 无关内容：不含目标关键词，才能证明后面 A 视角下零命中是"自我排除"而非"根本没匹配上"

    const historyAsB = createHistoryCapability(store, () => "B");
    const worldAsB = { history: historyAsB } as unknown as ExecutionWorld;
    const tool = createSessionSearchTool();

    // discovery：B 查关键词，应该命中 A（B 自己也有同样的种子内容，但 B 是"当前会话"要被排除）
    const discoveryOut = await text(tool, { query: "悉尼北区" }, worldAsB);
    expect(discoveryOut).toContain("悉尼北区");
    const discoveryResult = parseSessionSearchResult(discoveryOut)!;
    expect(discoveryResult.chunks![0]).toMatchObject({ sessionId: "A", seq: userMsgA.seq });

    // read：直接读 A 整段
    const readOut = await text(tool, { session_id: "A" }, worldAsB);
    const readResult = parseSessionSearchResult(readOut)!;
    expect(readResult.document).toMatchObject({ sessionId: "A", pages: 1 });

    // 自我排除：从 A 自己的视角查同一个词，A 被排除在结果外，零命中
    const historyAsA = createHistoryCapability(store, () => "A");
    const worldAsA = { history: historyAsA } as unknown as ExecutionWorld;
    const selfOut = await text(tool, { query: "用户住悉尼北区" }, worldAsA);
    expect(parseSessionSearchResult(selfOut)!.chunks).toEqual([]);

    store.close();
  });
});
