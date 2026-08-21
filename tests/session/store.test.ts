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

  it("sessions()：标题 = 第一条 user_message 的首行（多行输入只取首行）", () => {
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/p" });
    store.append(userMsg("s1", "  帮我修登录 bug\n报错信息如下：\nTypeError…"));
    store.append(userMsg("s1", "第二句不该当标题"));

    expect(store.sessions()[0]?.title).toBe("帮我修登录 bug"); // 首行 + 去首尾空白
  });

  it("sessions()：还没发过话 / 首条是纯空白 → title 为 null（UI 兜底）", () => {
    store.append({ sessionId: "silent", ts: 1, type: "session_created", workspace: "/p" });
    store.append({ sessionId: "blank", ts: 2, type: "session_created", workspace: "/q" });
    store.append(userMsg("blank", "   \n\n  "));

    const byId = Object.fromEntries(store.sessions().map((s) => [s.sessionId, s.title]));
    expect(byId["silent"]).toBeNull();
    expect(byId["blank"]).toBeNull();
  });

  it("sessions()：手动改名（session_renamed）压过自动标题，改两次取最后一条", () => {
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/p" });
    store.append(userMsg("s1", "第一句话（自动标题）"));
    store.append({ sessionId: "s1", ts: 3, type: "session_renamed", title: "手动名 v1" });
    store.append({ sessionId: "s1", ts: 4, type: "session_renamed", title: "手动名 v2" });

    expect(store.sessions()[0]?.title).toBe("手动名 v2"); // 最后一条胜出，历史全留
    expect(store.load("s1")).toHaveLength(4); // 改名不改旧事件，只追加
  });

  it("sessions()：日志里混进空白改名 → 当没有，退回自动标题", () => {
    // 主进程会拒绝空白标题，但投影不赌上游守规矩：日志是别人也能写的
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/p" });
    store.append(userMsg("s1", "自动标题"));
    store.append({ sessionId: "s1", ts: 3, type: "session_renamed", title: "   " });

    expect(store.sessions()[0]?.title).toBe("自动标题");
  });

  it("sessions()：spawnedFrom 从第 0 条 session_created 的 spawnedBy 投影出来", () => {
    store.append({ sessionId: "parent", ts: 1, type: "session_created", workspace: "/p" });
    store.append({
      sessionId: "child",
      ts: 2,
      type: "session_created",
      workspace: "/p",
      spawnedBy: { sessionId: "parent", toolCallId: "call_1", agent: "reviewer" },
    });

    const byId = Object.fromEntries(store.sessions().map((s) => [s.sessionId, s.spawnedFrom]));
    expect(byId["child"]).toBe("parent");
    expect(byId["parent"]).toBeNull(); // 普通会话没有 spawnedBy → null
  });

  it("遗留兼容：旧日志里的 session_archived 标记仍让会话从列表消失", () => {
    // 现版本删除走 purge，不再产生 session_archived；但旧库里可能有，投影必须继续认它
    store.append({ sessionId: "keep", ts: 1, type: "session_created", workspace: "/a" });
    store.append({ sessionId: "old-archived", ts: 2, type: "session_created", workspace: "/b" });
    store.append({ sessionId: "old-archived", ts: 3, type: "session_archived" });

    expect(store.sessions().map((s) => s.sessionId)).toEqual(["keep"]);
    expect(store.load("old-archived")).toHaveLength(2); // 旧日志本身原样可读
  });

  it("purge：整会话物理抹除，邻居会话一个字节不少", () => {
    store.append({ sessionId: "keep", ts: 1, type: "session_created", workspace: "/a" });
    store.append(userMsg("keep", "我要活下来"));
    store.append({ sessionId: "gone", ts: 2, type: "session_created", workspace: "/b" });
    store.append(userMsg("gone", "我会被遗忘"));

    store.purge("gone");

    expect(store.load("gone")).toEqual([]); // 库里真没了
    expect(store.load("keep")).toHaveLength(2); // 邻居毫发无损
    expect(store.sessions().map((s) => s.sessionId)).toEqual(["keep"]);
  });

  it("purge 之后 append-only trigger 原样归位：UPDATE / 零散 DELETE 依旧被拒", () => {
    store.append(userMsg("s1", "历史不可改"));
    store.purge("nobody"); // 空目标也要走完 卸 trigger → 删 → 装回 的全程
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;

    expect(() => db.prepare("UPDATE events SET payload = '{}' ").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(store.load("s1")).toHaveLength(1); // purge 别的会话不伤及无辜
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

  describe("billedUsage", () => {
    const assistant = (
      sessionId: string,
      ts: number,
      model: string,
      usage?: { promptTokens: number; completionTokens: number }
    ): NewSessionEvent => ({
      sessionId,
      ts,
      type: "assistant_message",
      content: "x",
      model,
      ...(usage ? { usage } : {}),
    });

    it("捞出四类计费事件的用量,跨会话", () => {
      store.append(assistant("s1", 100, "deepseek-v4-pro", { promptTokens: 10, completionTokens: 2 }));
      store.append(assistant("s2", 200, "claude-opus-5", { promptTokens: 30, completionTokens: 4 }));
      store.append({
        sessionId: "s1",
        ts: 300,
        type: "suggestions_generated",
        model: "deepseek-v4-flash",
        suggestions: ["a"],
        usage: { promptTokens: 7, completionTokens: 1 },
      });

      expect(store.billedUsage(0)).toEqual([
        { ts: 100, model: "deepseek-v4-pro", promptTokens: 10, completionTokens: 2 },
        { ts: 200, model: "claude-opus-5", promptTokens: 30, completionTokens: 4 },
        { ts: 300, model: "deepseek-v4-flash", promptTokens: 7, completionTokens: 1 },
      ]);
    });

    it("没记 usage 的调用不出现 —— 没记 ≠ 没花", () => {
      store.append(assistant("s1", 100, "deepseek-v4-pro"));
      expect(store.billedUsage(0)).toEqual([]);
    });

    it("不计费的事件不出现", () => {
      store.append(userMsg("s1", "你好"));
      expect(store.billedUsage(0)).toEqual([]);
    });

    it("since 之前的不过桥", () => {
      store.append(assistant("s1", 100, "deepseek-v4-pro", { promptTokens: 1, completionTokens: 1 }));
      store.append(assistant("s1", 500, "deepseek-v4-pro", { promptTokens: 2, completionTokens: 2 }));
      expect(store.billedUsage(400).map((r) => r.ts)).toEqual([500]);
    });

    it("归档的会话照样算 —— archive 是从列表里消失,不是这笔钱没花过", () => {
      store.append(assistant("s1", 100, "deepseek-v4-pro", { promptTokens: 9, completionTokens: 1 }));
      store.append({ sessionId: "s1", ts: 110, type: "session_archived" });
      expect(store.sessions()).toEqual([]);
      expect(store.billedUsage(0)).toHaveLength(1);
    });
  });
});
