import { describe, expect, it, vi } from "vitest";
import { applyUserEdit, MEMORY_EDITS_SESSION } from "../../src/main/memoryEdit.js";
import { EventStore } from "../../src/session/store.js";
import { createMemoryTool } from "../../src/tools/memory.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function deps() {
  const files = new Map<string, string>();
  const store = new EventStore(":memory:");
  return {
    store,
    files,
    readFile: async (rel: string) => files.get(rel) ?? "",
    writeFile: vi.fn(async (rel: string, c: string) => { files.set(rel, c); }),
  };
}

describe("applyUserEdit", () => {
  it("写盘 + 在给定会话落 memory_user_edit（before/after）", async () => {
    const d = deps();
    d.store.append({ sessionId: "s1", ts: 0, type: "session_created", workspace: "/w" });
    await applyUserEdit(d, "user", "用户住悉尼", "s1");
    expect(d.files.get("memories/USER.md")).toBe("用户住悉尼");
    expect(d.store.load("s1").at(-1)).toMatchObject({ type: "memory_user_edit", target: "user", before: "", after: "用户住悉尼" });
  });

  it("没给会话 = 落到保留会话，首次自动建且归档", async () => {
    const d = deps();
    await applyUserEdit(d, "memory", "a");
    const log = d.store.load(MEMORY_EDITS_SESSION);
    expect(log.map((e) => e.type)).toEqual(["session_created", "session_archived", "memory_user_edit"]);
    await applyUserEdit(d, "memory", "b");
    expect(d.store.load(MEMORY_EDITS_SESSION).filter((e) => e.type === "session_created")).toHaveLength(1);
  });

  it("文本先归一化再落盘（去空条目/去重）", async () => {
    const d = deps();
    await applyUserEdit(d, "memory", "a\n§\n\n§\na\n§\n b ");
    expect(d.files.get("memories/MEMORY.md")).toBe("a\n§\nb");
  });

  it("归一化后与磁盘现状相同（no-op）：不写盘、不落事件", async () => {
    const d = deps();
    d.files.set("memories/MEMORY.md", "a\n§\nb");
    await applyUserEdit(d, "memory", "a\n§\n b \n§\n", "s1");
    expect(d.writeFile).not.toHaveBeenCalled();
    expect(d.store.load("s1")).toEqual([]);
  });

  // issue #185：设置页编辑与 memory 工具共用同一把 per-target 锁。
  // 无锁时：工具先读（旧视图）、用户编辑落盘、工具再写 → 用户的编辑被覆盖，
  // 且 memory_user_edit 的 before 不再等于写入时刻的磁盘原文。
  it("与 memory 工具并发：编辑排在工具写之后，before 是工具写完的最新内容", async () => {
    const d = deps();
    d.store.append({ sessionId: "s1", ts: 0, type: "session_created", workspace: "/w" });
    const tool = createMemoryTool(null);
    const world = {
      config: {
        read: async (rel: string) => d.files.get(rel) ?? null,
        write: async (rel: string, c: string) => { d.files.set(rel, c); },
      },
    } as unknown as ExecutionWorld;
    await Promise.all([
      tool.run({ target: "memory", action: "add", content: "甲" }, world),
      applyUserEdit(d, "memory", "手编", "s1"),
    ]);
    expect(d.files.get("memories/MEMORY.md")).toBe("手编");
    expect(d.store.load("s1").at(-1)).toMatchObject({ type: "memory_user_edit", before: "甲", after: "手编" });
  });
});
