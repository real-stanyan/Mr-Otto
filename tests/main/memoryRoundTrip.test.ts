// 端到端护栏（ADR-0060）：memory 工具写盘 → index.ts 那套"现读文件"逻辑
// → createAgent 的 memory 快照 → deriveMessages 的 system 消息，四段接口
// 各自都有单元测试，但没人验证过它们接起来后模型真能在下一轮看到写进去的话。
// 这条测试就钉这一件事：真实 LocalWorld + 真实磁盘，从 memory 工具落笔
// 到 system 消息里出现那句话，中间不假设、不 mock。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalWorld } from "../../src/world/localWorld.js";
import { createMemoryTool } from "../../src/tools/memory.js";
import { createAgent, type AgentPush } from "../../src/main/agent.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { MEMORY_FILES } from "../../src/shared/memoryStore.js";
import { tempDir } from "../helpers/tempDir.js";

const push: AgentPush = {
  event: () => {},
  approvalRequest: () => {},
  askUserRequest: () => {},
  assistantDelta: () => {},
  toolOutput: () => {},
};

describe("记忆全链路：memory 工具落盘 → 下个 session 的 system 消息里能看到", () => {
  it("写一条 user 记忆，新会话的第一条投影消息里带着它", async () => {
    const configRoot = tempDir("otter-memory-e2e-config-");
    const world = createLocalWorld({ configRoot });

    const result = await createMemoryTool().run(
      { target: "user", action: "add", content: "用户住悉尼" },
      world
    );
    expect(result).toContain("已更新 USER");

    // 读回来的方式跟 index.ts 的 readMemoryFiles 一样：直接读磁盘，读不到当空
    // （这里是测试，允许碰 fs——工具层才是禁止 import fs 的那一层）
    const read = (rel: string): string => {
      try {
        return readFileSync(join(configRoot, rel), "utf8");
      } catch {
        return "";
      }
    };
    const memory = { memory: read(MEMORY_FILES.memory), user: read(MEMORY_FILES.user) };
    expect(memory.user).toContain("用户住悉尼");

    const store = new EventStore(":memory:");
    const attachments = new AttachmentStore(tempDir("otter-memory-e2e-attach-"));
    const agent = createAgent({
      store,
      workspace: "/proj/memory-e2e",
      push,
      attachments,
      world,
      memory,
    });

    const messages = deriveMessages(store.load(agent.sessionId));
    expect(messages[0]!.content).toContain("用户住悉尼");
    expect(messages[0]!.content).toContain("USER (about the user)");
    store.close();
  });
});
