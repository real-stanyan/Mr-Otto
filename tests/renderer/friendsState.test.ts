import { describe, it, expect } from "vitest";
import {
  buildChatRows, dayLabel, failOptimistic, mergeDm, nextTempId, optimisticMessage,
  prependOlder, settleOptimistic, timeLabel, type ChatMessage,
} from "../../src/renderer/src/lib/friendsState.js";
import type { DirectMessage } from "../../src/shared/friends.js";

const M = (id: number): DirectMessage =>
  ({ id, sender: "a", recipient: "b", body: `m${id}`, createdAt: "t" });

describe("mergeDm", () => {
  it("升序插入", () => {
    expect(mergeDm([M(1), M(3)], M(2)).map((m) => m.id)).toEqual([1, 2, 3]);
  });
  it("重复 id 去重(Realtime 推送与本地回显撞车)", () => {
    expect(mergeDm([M(1), M(2)], M(2)).map((m) => m.id)).toEqual([1, 2]);
  });
});

describe("prependOlder", () => {
  it("新→旧的一页翻转拼头部", () => {
    expect(prependOlder([M(5), M(6)], [M(4), M(3)]).map((m) => m.id)).toEqual([3, 4, 5, 6]);
  });
  it("与现有重叠的去重", () => {
    expect(prependOlder([M(4), M(5)], [M(4), M(3)]).map((m) => m.id)).toEqual([3, 4, 5]);
  });
});

// ── 乐观发送(响应先于确认) ──────────────────────────────────────
describe("乐观气泡", () => {
  it("临时 id 是负数,不与服务端 identity 撞", () => {
    expect(nextTempId()).toBeLessThan(0);
    expect(nextTempId()).not.toBe(nextTempId());
  });

  it("settleOptimistic:占位换成真行,按 id 落回队尾", () => {
    const temp = nextTempId();
    const list: ChatMessage[] = [
      M(7), optimisticMessage(temp, "", "b", "在吗", "2026-08-19T10:00:00Z"),
    ];
    const settled = settleOptimistic(list, temp, {
      id: 8, sender: "me", recipient: "b", body: "在吗", createdAt: "2026-08-19T10:00:01Z",
    });
    expect(settled.map((m) => m.id)).toEqual([7, 8]);
    expect(settled.at(-1)?.status).toBeUndefined(); // 落库了就不再是"发送中"
  });

  it("failOptimistic:占位留在原地标红——悄悄消失才是最坏的", () => {
    const temp = nextTempId();
    const list = [optimisticMessage(temp, "", "b", "在吗", "2026-08-19T10:00:00Z")];
    expect(failOptimistic(list, temp)[0]?.status).toBe("failed");
    expect(failOptimistic(list, temp)).toHaveLength(1);
  });
});

// ── 聊天排版(FriendChatView 只渲染,不判断) ─────────────────────
const AT = (h: number, m: number): string => new Date(2026, 7, 19, h, m).toISOString();

describe("dayLabel", () => {
  const now = new Date(2026, 7, 19, 12, 0).getTime();

  it("今天/昨天说人话", () => {
    expect(dayLabel(AT(9, 0), now)).toBe("今天");
    expect(dayLabel(new Date(2026, 7, 18, 23, 0).toISOString(), now)).toBe("昨天");
  });

  it("再往前给月日,跨年才带年份", () => {
    expect(dayLabel(new Date(2026, 7, 1, 9, 0).toISOString(), now)).toBe("8月1日");
    expect(dayLabel(new Date(2025, 11, 31, 9, 0).toISOString(), now)).toBe("2025年12月31日");
  });
});

describe("timeLabel", () => {
  it("24 小时制补零", () => {
    expect(timeLabel(AT(9, 5))).toBe("09:05");
  });
});

describe("buildChatRows", () => {
  const now = new Date(2026, 7, 19, 12, 0).getTime();
  const msg = (id: number, sender: string, at: string): ChatMessage =>
    ({ id, sender, recipient: "x", body: `m${id}`, createdAt: at });

  it("同一边、五分钟内连着说的摞成一组", () => {
    const rows = buildChatRows(
      [msg(1, "peer", AT(9, 0)), msg(2, "peer", AT(9, 2))], "peer", now);
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(1);
  });

  it("超过窗口就断组", () => {
    const rows = buildChatRows(
      [msg(1, "peer", AT(9, 0)), msg(2, "peer", AT(9, 30))], "peer", now);
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(2);
  });

  it("换人必断组,mine 按 peerId 判(非对方即自己)", () => {
    const rows = buildChatRows(
      [msg(1, "peer", AT(9, 0)), msg(2, "me", AT(9, 1))], "peer", now);
    const groups = rows.filter((r) => r.kind === "group");
    expect(groups.map((g) => g.kind === "group" && g.mine)).toEqual([false, true]);
  });

  // 乐观气泡的 sender 是空串:按 sender 分组会让"刚发出去那条"自己单开一组,
  // 落库后又跳回上一组里——同一句话在屏幕上换过位置,这是最刺眼的那种抖动
  it("乐观气泡与已落库的自己消息同组", () => {
    const rows = buildChatRows(
      [msg(1, "me", AT(9, 0)), optimisticMessage(-1, "", "peer", "hi", AT(9, 1))], "peer", now);
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(1);
  });

  it("跨天插日期分隔线,并且必断组", () => {
    const rows = buildChatRows([
      msg(1, "peer", new Date(2026, 7, 18, 23, 58).toISOString()),
      msg(2, "peer", new Date(2026, 7, 19, 0, 1).toISOString()),
    ], "peer", now);
    expect(rows.map((r) => r.kind)).toEqual(["day", "group", "day", "group"]);
    expect(rows[0]).toMatchObject({ label: "昨天" });
    expect(rows[2]).toMatchObject({ label: "今天" });
  });

  it("空列表 → 空行", () => {
    expect(buildChatRows([], "peer", now)).toEqual([]);
  });
});
