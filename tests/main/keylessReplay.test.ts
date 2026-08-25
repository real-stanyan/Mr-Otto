import { describe, it, expect, vi, afterEach } from "vitest";
import { createAgent, type AgentPush } from "../../src/main/agent.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import { buildTrajectory } from "../../src/renderer/src/replay/trajectory.js";
import { tempDir } from "../helpers/tempDir.js";

// keyless 回放（issue #389）单元层：key 门只在「发送」那一刻（modelRoute
// blocked），查看历史（resume 装配 → 轨迹投影）全程不碰 key。e2e 那份
// （tests/e2e/keylessReplay.e2e.ts）验真 GUI，这里钉住主进程与投影的契约。

const push: AgentPush = {
  event: () => {},
  approvalRequest: () => {},
  askUserRequest: () => {},
  assistantDelta: () => {},
  toolOutput: () => {},
};
const attachments = new AttachmentStore(tempDir("otter-keyless-test-"));

afterEach(() => vi.unstubAllEnvs());

describe("keyless 回放（issue #389）", () => {
  it("没有 key：resume 照常装配，轨迹投影照常出行——查看路径零 key 依赖", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("OTTER_MODEL", "");
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s-k", ts: 1, type: "session_created", workspace: "/proj/x" });
    store.append({ sessionId: "s-k", ts: 2, type: "user_message", content: "跑一下测试" });
    store.append({
      sessionId: "s-k", ts: 3, type: "assistant_message", content: "好", model: "m",
    });
    store.append({ sessionId: "s-k", ts: 4, type: "turn_ended", outcome: "completed" });

    // 装配不抛：缺 key 不拦启动/恢复（agent.ts 明文契约）
    const agent = createAgent({ store, workspace: "/proj/x", push, resumeSessionId: "s-k", attachments });
    expect(agent.sessionId).toBe("s-k");

    // 轨迹 = 纯投影，不碰模型
    const t = buildTrajectory(store.load("s-k"));
    expect(t.rows.length).toBeGreaterThan(0);
    store.close();
  });

  it("没有 key 发送：turn 失败给人话（还没配 key），错误落盘、历史仍可回放", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("OTTER_MODEL", "");
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });

    await expect(agent.engine.runTurn("你好")).rejects.toThrow(/还没配 key/);
    expect(store.load(agent.sessionId).at(-1)).toMatchObject({
      type: "turn_ended",
      outcome: "error",
      error: expect.stringContaining("还没配 key"),
    });
    // 失败的会话照样能投影成轨迹（错误也是历史）
    expect(buildTrajectory(store.load(agent.sessionId)).rows.length).toBeGreaterThan(0);
    store.close();
  });
});
