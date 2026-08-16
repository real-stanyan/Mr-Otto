import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventStore, type NewSessionEvent } from "../../src/session/store.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

let store: EventStore;

beforeEach(() => {
  store = new EventStore(":memory:");
});

afterEach(() => {
  store.close();
});

function userMsg(sessionId: string, content: string): NewSessionEvent {
  return { sessionId, ts: 1700000000000, type: "user_message", content };
}

describe("EventStore", () => {
  it("roundtrip：append 后 load 原样读回，seq 从 0 单调分配", () => {
    const e0 = store.append({ sessionId: "s1", ts: 1, type: "session_created", title: "t" });
    const e1 = store.append(userMsg("s1", "你好"));
    const e2 = store.append({
      sessionId: "s1",
      ts: 3,
      type: "assistant_message",
      content: "",
      model: "deepseek-v4-pro",
      toolCalls: [{ id: "call_1", name: "bash", args: { cmd: "ls" } }],
    });

    expect([e0.seq, e1.seq, e2.seq]).toEqual([0, 1, 2]);
    expect(store.load("s1")).toEqual([e0, e1, e2]);
  });

  it("seq 按会话独立计数", () => {
    store.append(userMsg("s1", "a"));
    const other = store.append(userMsg("s2", "b"));
    expect(other.seq).toBe(0);
  });

  it("未知会话 load 返回空数组", () => {
    expect(store.load("nope")).toEqual([]);
  });

  it("sandboxId 缺省时读回的事件不带该字段", () => {
    store.append(userMsg("s1", "x"));
    expect(store.load("s1")[0]).not.toHaveProperty("sandboxId");
  });

  it("数据库层拒绝 UPDATE / DELETE（append-only trigger）", () => {
    store.append(userMsg("s1", "历史不可改"));
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;

    expect(() => db.prepare("UPDATE events SET payload = '{}' ").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
  });

  it("sessions()：workspace 从第 0 条 payload 投影出来，按最后活跃倒序", () => {
    store.append({ sessionId: "old", ts: 10, type: "session_created", workspace: "/proj/a" });
    store.append({ sessionId: "old", ts: 20, type: "user_message", content: "早" });
    store.append({ sessionId: "fresh", ts: 50, type: "session_created", workspace: "/proj/b" });

    const list = store.sessions();
    expect(list.map((s) => s.sessionId)).toEqual(["fresh", "old"]); // 最近活跃在前
    expect(list[0]).toMatchObject({ workspace: "/proj/b", events: 1, startedTs: 50, lastTs: 50 });
    expect(list[1]).toMatchObject({ workspace: "/proj/a", events: 2, startedTs: 10, lastTs: 20 });
  });

  it("sessions()：旧日志没记 workspace → null（向后兼容）", () => {
    store.append({ sessionId: "legacy", ts: 1, type: "session_created", title: "无围栏时代" });
    expect(store.sessions()[0]?.workspace).toBeNull();
  });

  it("归档 = 追加标记：列表里消失，日志一个字节不少", () => {
    store.append({ sessionId: "keep", ts: 1, type: "session_created", workspace: "/a" });
    store.append({ sessionId: "gone", ts: 2, type: "session_created", workspace: "/b" });
    store.append({ sessionId: "gone", ts: 3, type: "user_message", content: "要被删的会话" });
    store.append({ sessionId: "gone", ts: 4, type: "session_archived" });

    expect(store.sessions().map((s) => s.sessionId)).toEqual(["keep"]); // 投影里没了
    expect(store.load("gone")).toHaveLength(3); // 日志还在，包括归档标记本身
    expect(store.load("gone").at(-1)?.type).toBe("session_archived");
  });

  it("集成：落盘的日志能直接投影出模型上下文", () => {
    store.append(userMsg("s1", "在吗"));
    store.append({
      sessionId: "s1",
      ts: 2,
      type: "assistant_message",
      content: "在",
      model: "deepseek-v4-pro",
    });

    expect(deriveMessages(store.load("s1"))).toEqual([
      { role: "user", content: "在吗" },
      { role: "assistant", content: "在" },
    ]);
  });
});
