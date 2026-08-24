import { describe, expect, it } from "vitest";
import { EventStore } from "../../src/session/store.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { NewSessionEvent } from "../../src/session/store.js";

// 会话 fork：引用型零拷贝分支（issue #352）。
// 只存 fork 点不复制事件行；load 沿链取数；seq 播种保证链视图全局递增。

let ts = 0;
type LooseEvent = { type: NewSessionEvent["type"] } & Record<string, unknown>;
function put(store: EventStore, sessionId: string, e: LooseEvent): number {
  return store.append({ sessionId, ts: ++ts, ...e } as unknown as NewSessionEvent).seq;
}

function turn(store: EventStore, id: string, n: number): number {
  put(store, id, { type: "user_message", content: `请求 ${n}` });
  put(store, id, { type: "assistant_message", content: `答复 ${n}`, model: "m" });
  return put(store, id, { type: "turn_ended", outcome: "completed" });
}

function seed(store: EventStore, id = "src"): number[] {
  put(store, id, { type: "session_created", title: "源会话", workspace: "/w" });
  const ends: number[] = [];
  for (let i = 1; i <= 3; i++) ends.push(turn(store, id, i));
  return ends; // 各 turn 收口的 seq
}

describe("EventStore.fork（issue #352）", () => {
  it("零拷贝：fork 只写一条 session_created，load 沿链读出父前缀 + 自己的追加段", () => {
    const store = new EventStore(":memory:");
    const ends = seed(store);
    store.fork("src", ends[1]!, "fork1", ++ts); // 到第 2 个 turn（含）为止

    // 库里 fork1 只有一行（零拷贝）
    expect(store.ofType("fork1", "session_created")).toHaveLength(1);

    const chain = store.load("fork1");
    // 前缀 = 源会话到 endSeq 为止；sessionId 被投影成分支自己的
    expect(chain.filter((e) => e.type === "user_message").map((e) => e.content)).toEqual([
      "请求 1",
      "请求 2",
    ]);
    expect(chain.every((e) => e.sessionId === "fork1")).toBe(true);
    // seq 播种：全链严格递增，分支首事件 seq = endSeq + 1
    const seqs = chain.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(chain.at(-1)!.seq).toBe(ends[1]! + 1);
    store.close();
  });

  it("分叉后各自生长：父的新事件不进分支，分支的追加不进父", () => {
    const store = new EventStore(":memory:");
    const ends = seed(store);
    store.fork("src", ends[2]!, "fork1", ++ts);
    turn(store, "src", 4); // 父继续
    turn(store, "fork1", 40); // 分支继续（append 的 MAX(seq)+1 从播种续上）

    const src = store.load("src").filter((e) => e.type === "user_message").map((e) => e.content);
    const fork = store.load("fork1").filter((e) => e.type === "user_message").map((e) => e.content);
    expect(src).toEqual(["请求 1", "请求 2", "请求 3", "请求 4"]);
    expect(fork).toEqual(["请求 1", "请求 2", "请求 3", "请求 40"]);
    // 分支 seq 仍全局递增（equivalence 的前提）
    const seqs = store.load("fork1").map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    store.close();
  });

  it("等价性：引用型 fork 重建的模型上下文 == 复制式 fork（验收②）", () => {
    const store = new EventStore(":memory:");
    const ends = seed(store);
    store.fork("src", ends[1]!, "fork1", ++ts);
    turn(store, "fork1", 9);

    // 复制式对照组：把父前缀逐条重放进一个普通会话，再追加同样的分支段
    const copyId = "copy";
    for (const e of store.load("src", { untilSeq: ends[1]! })) {
      const { seq: _seq, sessionId: _sid, ...rest } = e;
      store.append({ sessionId: copyId, ...rest } as NewSessionEvent);
    }
    turn(store, copyId, 9);

    expect(deriveMessages(store.load("fork1"))).toEqual(deriveMessages(store.load(copyId)));
    store.close();
  });

  it("fork 点必须是 turn_ended：半截 turn / 不存在的 seq 拒绝", () => {
    const store = new EventStore(":memory:");
    seed(store);
    put(store, "src", { type: "user_message", content: "半截" }); // 没收口
    const half = store.load("src").at(-1)!.seq;
    expect(() => store.fork("src", half, "f", ++ts)).toThrow(/turn_ended/);
    expect(() => store.fork("src", 99999, "f", ++ts)).toThrow(/不存在/);
    store.close();
  });

  it("删除保护：有分支引用时父会话拒绝 purge；删掉分支后父可删", () => {
    const store = new EventStore(":memory:");
    const ends = seed(store);
    store.fork("src", ends[0]!, "fork1", ++ts);
    expect(() => store.purge("src")).toThrow(/分支/);
    store.purge("fork1"); // 分支自己可删（只有自己的行）
    expect(store.purge("src")).toEqual(["src"]); // 分支没了，父可删
    store.close();
  });

  it("链式 fork（分支再分支）：递归取数，环保护存在", () => {
    const store = new EventStore(":memory:");
    const ends = seed(store);
    store.fork("src", ends[2]!, "f1", ++ts);
    const f1End = turn(store, "f1", 10);
    store.fork("f1", f1End, "f2", ++ts);
    const contents = store.load("f2").filter((e) => e.type === "user_message").map((e) => e.content);
    expect(contents).toEqual(["请求 1", "请求 2", "请求 3", "请求 10"]);
    store.close();
  });
});
