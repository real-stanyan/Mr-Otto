import { describe, expect, it } from "vitest";
import { rewindBranch } from "../../src/main/checkpointRewind.js";
import { isCloudTaskSession } from "../../src/shared/taskSync.js";
import { EventStore, type NewSessionEvent } from "../../src/session/store.js";

// 「回到这一步」分出的分支怎么落（#1252 / ADR-0311）：任务会话复制式、项目会话照旧零拷贝。
// 判据只有一条，就是同步层用来决定「推不推」的那一条（isCloudTaskSession）——两处分家的话，
// 落成的分支与同步层对它的判断会对不上，而那正是 #1252 这个洞本身。

let ts = 0;
type Loose = { type: NewSessionEvent["type"] } & Record<string, unknown>;
const put = (store: EventStore, sessionId: string, e: Loose): number =>
  store.append({ sessionId, ts: ++ts, ...e } as unknown as NewSessionEvent).seq;

/** 一轮：人话 + 回复 + 收口。回收口那条的 seq（唯一合法的分叉点） */
function turn(store: EventStore, id: string, n: number): number {
  put(store, id, { type: "user_message", content: `请求 ${n}` });
  put(store, id, { type: "assistant_message", content: `答复 ${n}`, model: "m" });
  return put(store, id, { type: "turn_ended", outcome: "completed" });
}

/** 任务会话 = 内置 Default 的主会话（ADR-0206 的 workspaceKind） */
function taskSession(store: EventStore, id = "t1"): number[] {
  put(store, id, { type: "session_created", workspace: "/默认/t1", workspaceKind: "default" });
  return [turn(store, id, 1), turn(store, id, 2)];
}

function projectSession(store: EventStore, id = "p1"): number[] {
  put(store, id, { type: "session_created", workspace: "/repo" });
  return [turn(store, id, 1), turn(store, id, 2)];
}

describe("rewindBranch（#1252 / ADR-0311）", () => {
  it("任务会话走复制式：一条独立会话、只有一条 session_created、不写 forkedFrom", () => {
    const store = new EventStore(":memory:");
    const ends = taskSession(store);
    expect(rewindBranch(store, "t1", ends[0]!, "t1br", ++ts)).toBe("copied");

    // 这三条合起来就是「推得上云」：0036 只许 seq 0 有 session_created，且不许链式前缀
    expect(store.forkOrigin("t1br")).toBeNull();
    const own = store.load("t1br");
    expect(own.filter((e) => e.type === "session_created").map((e) => e.seq)).toEqual([0]);
    // 同步层看它就是一条普通任务会话
    expect(isCloudTaskSession(store.load("t1br", { untilSeq: 0 })[0], store.forkOrigin("t1br"))).toBe(true);

    // 内容 = 父会话到分叉点为止那一段（第二轮没跟过来）
    expect(own.filter((e) => e.type === "user_message").map((e) => e.content)).toEqual(["请求 1"]);
    expect(own.at(-1)).toMatchObject({ type: "session_renamed" });
  });

  it("复制式不动父会话：父的行一条没少，也没被记上一个分支", () => {
    const store = new EventStore(":memory:");
    const ends = taskSession(store);
    const before = store.load("t1");
    rewindBranch(store, "t1", ends[0]!, "t1br", ++ts);
    expect(store.load("t1")).toEqual(before);
    // fork 保护（#352）不再挡删父会话——复制式分支的历史住在自己的行里，删父抽不走它
    expect(() => store.purge("t1")).not.toThrow();
    expect(store.load("t1br").filter((e) => e.type === "user_message")).toHaveLength(1);
  });

  it("复制式分支在侧栏上与父会话分得开：标题是「<父标题>（分支）」", () => {
    const store = new EventStore(":memory:");
    const ends = taskSession(store);
    rewindBranch(store, "t1", ends[0]!, "t1br", ++ts);
    // 不改名的话它会继承父会话的全部 user_message，标题投影逐字相同、两行分不出来
    expect(store.titleOf("t1")).toBe("请求 1");
    expect(store.titleOf("t1br")).toBe("请求 1（分支）");
  });

  it("项目会话照旧零拷贝：只写一条 session_created{forkedFrom}，前缀共享", () => {
    const store = new EventStore(":memory:");
    const ends = projectSession(store);
    expect(rewindBranch(store, "p1", ends[0]!, "p1br", ++ts)).toBe("referenced");
    expect(store.forkOrigin("p1br")).toEqual({ sessionId: "p1", endSeq: ends[0]! });
    expect(store.ofType("p1br", "session_created")).toHaveLength(1);
    // 零拷贝：库里只有那一行，父会话仍被分支引用着
    expect(store.load("p1br").filter((e) => e.type === "user_message").map((e) => e.content)).toEqual(["请求 1"]);
    expect(() => store.purge("p1")).toThrow(/分支/);
  });

  it("引用式分叉自己再回退一次仍走引用式：扁平化后第 0 条是父会话的，光看它会判错", () => {
    // isCloudTaskSession 的 forkOrigin 那一半不是冗余：load(id,{untilSeq:0}) 沿链读，
    // 一条任务会话的存量分叉在那里给出的是**父会话**那条 session_created。
    // 照它判 = 复制一段含两条 session_created 的流上云 = P0012 永久冻结，正是 #1252 要躲的
    const store = new EventStore(":memory:");
    const ends = taskSession(store);
    store.fork("t1", ends[0]!, "legacy", ++ts); // ADR-0311 之前留下的存量分叉
    const end = turn(store, "legacy", 3);
    expect(isCloudTaskSession(store.load("legacy", { untilSeq: 0 })[0], null)).toBe(true); // 少了那一半就判错
    expect(rewindBranch(store, "legacy", end, "legacy2", ++ts)).toBe("referenced");
    expect(store.forkOrigin("legacy2")).not.toBeNull();
  });

  it("两条路的前置校验逐字相同：分叉点不是 turn_ended / 目标会话已存在，都抛", () => {
    const store = new EventStore(":memory:");
    taskSession(store);
    projectSession(store);
    // seq 1 是 user_message
    expect(() => rewindBranch(store, "t1", 1, "x", ++ts)).toThrow(/turn_ended/);
    expect(() => rewindBranch(store, "p1", 1, "x", ++ts)).toThrow(/turn_ended/);
    expect(() => rewindBranch(store, "t1", 99999, "x", ++ts)).toThrow(/不存在/);
    expect(() => rewindBranch(store, "p1", 99999, "x", ++ts)).toThrow(/不存在/);
    expect(() => rewindBranch(store, "t1", 3, "t1", ++ts)).toThrow(/已存在/);
    expect(() => rewindBranch(store, "p1", 3, "p1", ++ts)).toThrow(/已存在/);
    // 抛了就一条行都别留下
    expect(store.has("x")).toBe(false);
  });
});
