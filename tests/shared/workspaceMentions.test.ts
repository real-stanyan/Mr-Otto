import { describe, it, expect } from "vitest";
import {
  MENTION_EXCERPT_MAX, markSessionRead, mentionExcerpt, mergeMentionRow,
  unreadMentionCounts, type WorkspaceMentionRow,
} from "../../src/shared/workspaceMentions.js";

const ROW = (over: Partial<WorkspaceMentionRow> = {}): WorkspaceMentionRow => ({
  workspaceId: "w1", sessionId: "s1", seq: 1, uid: "me", fromUid: "u2",
  fromLabel: "小红", excerpt: "看一下", createdTs: 1000, read: false, ...over,
});

describe("mentionExcerpt", () => {
  it("压平空白", () => {
    expect(mentionExcerpt("看\n一   下\t吧")).toBe("看 一 下 吧");
  });

  it("超上限截断并加省略号，总长仍不超上限", () => {
    const out = mentionExcerpt("啊".repeat(MENTION_EXCERPT_MAX + 50));
    expect(out.length).toBe(MENTION_EXCERPT_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("刚好等于上限不截断", () => {
    const text = "啊".repeat(MENTION_EXCERPT_MAX);
    expect(mentionExcerpt(text)).toBe(text);
  });
});

describe("unreadMentionCounts", () => {
  it("总数、按工作区、按会话各一份，已读不计", () => {
    const rows = [
      ROW({ seq: 1 }),
      ROW({ seq: 2, read: true }),
      ROW({ seq: 3, sessionId: "s2" }),
      ROW({ seq: 4, workspaceId: "w2", sessionId: "s9" }),
    ];
    expect(unreadMentionCounts(rows)).toEqual({
      total: 3,
      byWorkspace: { w1: 2, w2: 1 },
      bySession: { s1: 1, s2: 1, s9: 1 },
    });
  });

  it("全读完了 = 总数 0 + 两份都空（不是 0 这个键）", () => {
    expect(unreadMentionCounts([ROW({ read: true })])).toEqual({
      total: 0,
      byWorkspace: {},
      bySession: {},
    });
  });

  // 切换器上那颗点只认 total（#1087）：它是跨工作区的和，不是某一格的投影 ——
  // 拿 byWorkspace 里最大的那格当它，两个工作区各有一条未读时就少报一条
  it("total 是跨工作区的和", () => {
    const rows = [ROW({ seq: 1 }), ROW({ seq: 2, workspaceId: "w2", sessionId: "s9" })];
    expect(unreadMentionCounts(rows).total).toBe(2);
  });
});

describe("mergeMentionRow", () => {
  it("同一主键重推一次不会让未读 +1（realtime 断线重连会重放）", () => {
    const rows = [ROW({ seq: 7 })];
    const merged = mergeMentionRow(rows, ROW({ seq: 7, excerpt: "改过的正文" }));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.excerpt).toBe("改过的正文");
  });

  it("同 seq 但不同会话是两条（主键是三元组）", () => {
    expect(mergeMentionRow([ROW({ seq: 7 })], ROW({ seq: 7, sessionId: "s2" }))).toHaveLength(2);
  });

  it("按时间升序，同刻按 seq", () => {
    const merged = mergeMentionRow(
      [ROW({ seq: 2, createdTs: 2000 }), ROW({ seq: 1, createdTs: 1000 })],
      ROW({ seq: 3, createdTs: 1500 })
    );
    expect(merged.map((r) => r.seq)).toEqual([1, 3, 2]);
  });
});

describe("markSessionRead", () => {
  it("把那条会话的未读翻成已读，别的会话不动", () => {
    const rows = [ROW({ seq: 1 }), ROW({ seq: 2, sessionId: "s2" })];
    const out = markSessionRead(rows, "s1");
    expect(out.map((r) => r.read)).toEqual([true, false]);
  });

  // 引用相等是侧栏那些 selector 唯一的判据：内容没变却造一个新数组，
  // 每次 openCloudSession 都会让整个侧栏白重渲染一遍
  it("没有未读时把原数组原样还回去（引用相等）", () => {
    const rows = [ROW({ read: true }), ROW({ seq: 2, sessionId: "s2" })];
    expect(markSessionRead(rows, "s1")).toBe(rows);
  });

  it("这条会话一条都没有时同样是原数组", () => {
    const rows = [ROW()];
    expect(markSessionRead(rows, "s-none")).toBe(rows);
  });
});
