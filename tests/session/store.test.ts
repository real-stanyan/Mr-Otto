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

  // issue #197：微压缩写侧收口前只需要问"我开跑之后有没有落新的 context_compacted"，
  // 长会话全量重读一遍日志是白花的
  it("load({afterSeq})：只读该 seq 之后的事件", () => {
    const e0 = store.append({ sessionId: "s1", ts: 1, type: "session_created", title: "t" });
    const e1 = store.append(userMsg("s1", "你好"));
    const e2 = store.append(userMsg("s1", "又来"));
    expect(store.load("s1", { afterSeq: e0.seq })).toEqual([e1, e2]);
    expect(store.load("s1", { afterSeq: e2.seq })).toEqual([]);
  });

  // 性能一轮（issue #275）：session_search 的 scroll 模式只要 ±5 条，
  // 区间查询下推到 SQL，不再全量 load 后 filter
  it("window()：按 seq 闭区间读一小段，与 load 同一种事件形状", () => {
    const all = [
      store.append({ sessionId: "s1", ts: 1, type: "session_created", title: "t" }),
      store.append(userMsg("s1", "a")),
      store.append(userMsg("s1", "b")),
      store.append(userMsg("s1", "c")),
    ];
    expect(store.window("s1", 1, 2)).toEqual([all[1], all[2]]);
    expect(store.window("s1", 3, 99)).toEqual([all[3]]);
    expect(store.window("nope", 0, 9)).toEqual([]);
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

  it("sessions()：浓缩标题（session_autotitled）压过首行、被手动改名压过（issue #335）", () => {
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/p" });
    store.append(userMsg("s1", "搜一下 vite 官网，把找到的链接写进 sources-test.md"));
    store.append({ sessionId: "s1", ts: 3, type: "session_autotitled", title: "搜 vite 官网写文档", model: "cheap" });
    expect(store.sessions()[0]?.title).toBe("搜 vite 官网写文档");

    store.append({ sessionId: "s1", ts: 4, type: "session_renamed", title: "手动名" });
    expect(store.sessions()[0]?.title).toBe("手动名"); // 手动永远压过模型
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

  it("sessions()：sideChat 从第 0 条 session_created 投影出来（issue #502）", () => {
    store.append({ sessionId: "main", ts: 1, type: "session_created", workspace: "/p" });
    store.append({ sessionId: "side", ts: 2, type: "session_created", workspace: "/p", sideChat: true });

    const byId = Object.fromEntries(store.sessions().map((s) => [s.sessionId, s.sideChat]));
    expect(byId["side"]).toBe(true);
    expect(byId["main"]).toBe(false); // 普通会话 / 旧日志没有该字段 → false
  });

  it("遗留兼容：旧日志里的 session_archived 标记（无 reason）仍让会话从列表消失", () => {
    // 早期"删除" = 归档标记，无 reason 字段；ADR-0087 后按 system 解读——
    // 列表和召回都排除，跟写下它时的本意（彻底藏起）一致
    store.append({ sessionId: "keep", ts: 1, type: "session_created", workspace: "/a" });
    store.append({ sessionId: "old-archived", ts: 2, type: "session_created", workspace: "/b" });
    store.append({ sessionId: "old-archived", ts: 3, type: "session_archived" });

    expect(store.sessions().map((s) => s.sessionId)).toEqual(["keep"]);
    expect(store.load("old-archived")).toHaveLength(2); // 旧日志本身原样可读
  });

  it("系统归档（reason=system）同样不进列表", () => {
    store.append({ sessionId: "sys", ts: 1, type: "session_created", workspace: "/a" });
    store.append({ sessionId: "sys", ts: 2, type: "session_archived", reason: "system" });
    expect(store.sessions()).toEqual([]);
  });

  it("用户归档（ADR-0087）：留在列表里、带 archived 标志", () => {
    store.append({ sessionId: "active", ts: 1, type: "session_created", workspace: "/a" });
    store.append({ sessionId: "shelved", ts: 2, type: "session_created", workspace: "/b" });
    store.append({ sessionId: "shelved", ts: 3, type: "session_archived", reason: "user" });

    const byId = Object.fromEntries(store.sessions().map((s) => [s.sessionId, s.archived]));
    expect(byId).toEqual({ active: false, shelved: true });
  });

  it("归档状态最后一条胜出：归档→恢复→再归档", () => {
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/a" });
    store.append({ sessionId: "s1", ts: 2, type: "session_archived", reason: "user" });
    store.append({ sessionId: "s1", ts: 3, type: "session_unarchived" });
    expect(store.sessions()[0]).toMatchObject({ sessionId: "s1", archived: false });

    store.append({ sessionId: "s1", ts: 4, type: "session_archived", reason: "user" });
    expect(store.sessions()[0]).toMatchObject({ sessionId: "s1", archived: true });
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

  it("purge 级联抹掉它派出去的子会话（review I3：孤儿子会话够不着也删不掉）", () => {
    store.append({ sessionId: "parent", ts: 1, type: "session_created", workspace: "/a" });
    store.append({
      sessionId: "child",
      ts: 2,
      type: "session_created",
      workspace: "/a",
      spawnedBy: { sessionId: "parent", toolCallId: "call_1", agent: "searcher" },
    });
    store.append({
      sessionId: "child",
      ts: 3,
      type: "assistant_message",
      content: "文件里写着密码",
      model: "deepseek-chat",
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    const purged = store.purge("parent");

    // 父日志一没，子会话就是谁也够不着（不进侧栏、不进 ⌘K、时间线没了）、
    // 谁也删不掉的孤儿——而它的 token 账还在 billedUsage 里继续算，
    // 存的还是同一个 workspace 的文件内容。ADR-0002 承诺的是"整会话物理抹除"
    expect(purged.sort()).toEqual(["child", "parent"]);
    expect(store.load("child")).toEqual([]);
    expect(store.billedUsage(0)).toEqual([]);
  });

  it("purge 不级联无关会话：只认 spawnedBy 指回自己的那些", () => {
    store.append({ sessionId: "gone", ts: 1, type: "session_created", workspace: "/a" });
    store.append({ sessionId: "keep", ts: 2, type: "session_created", workspace: "/b" });
    // 别人家的孩子不能连坐
    store.append({
      sessionId: "keep-child",
      ts: 3,
      type: "session_created",
      workspace: "/b",
      spawnedBy: { sessionId: "keep", toolCallId: "call_1", agent: "searcher" },
    });
    // fork 出来的会话带的是 forkedFrom 不是 spawnedBy，同样不该被连坐
    store.append({ sessionId: "forked", ts: 4, type: "session_created", workspace: "/a" });

    expect(store.purge("gone")).toEqual(["gone"]);
    expect(store.load("keep")).toHaveLength(1);
    expect(store.load("keep-child")).toHaveLength(1);
    expect(store.load("forked")).toHaveLength(1);
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
      usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }
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
        // cachedTokens: 不报 cache 的调用提出来是 null（≠0,计价时才归 0）
        { ts: 100, model: "deepseek-v4-pro", promptTokens: 10, completionTokens: 2, cachedTokens: null },
        { ts: 200, model: "claude-opus-5", promptTokens: 30, completionTokens: 4, cachedTokens: null },
        { ts: 300, model: "deepseek-v4-flash", promptTokens: 7, completionTokens: 1, cachedTokens: null },
      ]);
    });

    it("报了 cachedTokens 的调用原样过桥 —— 缓存价计费靠它", () => {
      store.append(assistant("s1", 100, "deepseek-v4-pro", { promptTokens: 10, completionTokens: 2, cachedTokens: 8 }));
      expect(store.billedUsage(0)).toEqual([
        { ts: 100, model: "deepseek-v4-pro", promptTokens: 10, completionTokens: 2, cachedTokens: 8 },
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

// issue #279：turn 收口钩子的尾段读取靠这批小查询，语义各自钉死
describe("尾段读取原语（issue #279）", () => {
  it("lastSeqOf：最后一条的 seq；beforeSeq 只看它之前（不含）；没有 = -1", () => {
    store.append(userMsg("s1", "一"));                                        // seq 0
    store.append({ sessionId: "s1", ts: 2, type: "turn_ended", outcome: "completed" }); // seq 1
    store.append(userMsg("s1", "二"));                                        // seq 2
    expect(store.lastSeqOf("s1", "user_message")).toBe(2);
    expect(store.lastSeqOf("s1", "user_message", 2)).toBe(0);
    expect(store.lastSeqOf("s1", "turn_ended", 1)).toBe(-1);
    expect(store.lastSeqOf("nope", "user_message")).toBe(-1);
  });

  it("countType：afterSeq 之后（不含）某类型的条数", () => {
    store.append(userMsg("s1", "一")); // 0
    store.append(userMsg("s1", "二")); // 1
    store.append({ sessionId: "s1", ts: 3, type: "memory_nudge", userTurns: 10 }); // 2
    store.append(userMsg("s1", "三")); // 3
    expect(store.countType("s1", "user_message")).toBe(3);
    expect(store.countType("s1", "user_message", 2)).toBe(1);
    expect(store.countType("nope", "user_message")).toBe(0);
  });

  it("eventsOfType：某类型全部事件，seq 升序，形状和 load 一致", () => {
    store.append(userMsg("s1", "一"));
    const c1 = store.append({ sessionId: "s1", ts: 2, type: "section_classified", title: "甲", model: "c" });
    store.append(userMsg("s1", "二"));
    const c2 = store.append({ sessionId: "s1", ts: 4, type: "section_classified", title: null, model: "c" });
    expect(store.eventsOfType("s1", "section_classified")).toEqual([c1, c2]);
    expect(store.eventsOfType("s1", "memory_nudge")).toEqual([]);
  });

  it("has：有任何事件 = 存在", () => {
    store.append(userMsg("s1", "一"));
    expect(store.has("s1")).toBe(true);
    expect(store.has("nope")).toBe(false);
  });

  it("titleOf：改名胜出，否则浓缩标题，否则第一条 user_message 首行，否则 null（同 sessions() 规则）", () => {
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    expect(store.titleOf("s1")).toBeNull();
    store.append(userMsg("s1", "修登录\n第二行不要"));
    expect(store.titleOf("s1")).toBe("修登录");
    store.append({ sessionId: "s1", ts: 3, type: "session_autotitled", title: "浓缩的名", model: "cheap" });
    expect(store.titleOf("s1")).toBe("浓缩的名");
    store.append({ sessionId: "s1", ts: 4, type: "session_renamed", title: "手动改的名" });
    expect(store.titleOf("s1")).toBe("手动改的名");
    expect(store.titleOf("nope")).toBeNull();
  });

  it("firstUserMessage：第一条 user_message 全文（自动命名素材），没有 = null", () => {
    expect(store.firstUserMessage("s1")).toBeNull();
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    expect(store.firstUserMessage("s1")).toBeNull();
    store.append(userMsg("s1", "第一条\n带第二行"));
    store.append(userMsg("s1", "第二条"));
    expect(store.firstUserMessage("s1")).toBe("第一条\n带第二行");
  });
});
