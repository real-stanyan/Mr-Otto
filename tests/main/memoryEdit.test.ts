import { describe, expect, it, vi } from "vitest";
import { applyUserEdit, MEMORY_EDITS_SESSION } from "../../src/main/memoryEdit.js";
import { EventStore } from "../../src/session/store.js";

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
});
