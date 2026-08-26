// 好友/私信查询里那批纯逻辑。两条注入面(profileSearchOr / dmOr)是重点:
// 它们的输出会被原样拼进 PostgREST 的过滤串。

import { describe, expect, it } from "vitest";
import {
  dmOr, mergeChannelHealth, mergeMessages, needsTimeLabel, profileSearchOr,
  rankFriendship, timeLabel,
} from "../../src/shared/friendsQuery.js";
import type { DirectMessage } from "../../src/shared/friends.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const msg = (id: number, body = "x", createdAt = "2026-08-25T10:00:00.000Z"): DirectMessage =>
  ({ id, sender: A, recipient: B, body, createdAt });

describe("profileSearchOr", () => {
  it("普通词原样拼两列", () => {
    expect(profileSearchOr("stan")).toBe("name.ilike.%stan%,email.ilike.%stan%");
  });

  it("or 语法的分隔字符被剥掉,不会切出新条件", () => {
    expect(profileSearchOr(`a,b(c)"d'e`)).toBe("name.ilike.%abcde%,email.ilike.%abcde%");
  });

  it("LIKE 通配符转义成字面量", () => {
    expect(profileSearchOr("a_b%")).toBe("name.ilike.%a\\_b\\%%,email.ilike.%a\\_b\\%%");
  });
});

describe("dmOr", () => {
  it("两个方向各一条 and(),对称", () => {
    expect(dmOr(A, B)).toBe(
      `and(sender.eq.${A},recipient.eq.${B}),and(sender.eq.${B},recipient.eq.${A})`,
    );
  });

  it("不是 uuid 就不拼 —— 这是它存在的全部理由", () => {
    expect(() => dmOr(A, `${B},or(sender.eq.x)`)).toThrow(/uuid/);
    expect(() => dmOr("", B)).toThrow(/uuid/);
  });
});

describe("mergeChannelHealth", () => {
  it("全 SUBSCRIBED 才 live", () => {
    expect(mergeChannelHealth(["SUBSCRIBED", "SUBSCRIBED"])).toBe("live");
  });

  it("有一条没通就整体 degraded", () => {
    expect(mergeChannelHealth(["SUBSCRIBED", "CHANNEL_ERROR"])).toBe("degraded");
  });
});

describe("mergeMessages", () => {
  it("按 id 升序", () => {
    expect(mergeMessages([msg(3), msg(1)], [msg(2)]).map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("同 id 只留一条,后到的覆盖先到的(轮询重读的那份更权威)", () => {
    const out = mergeMessages([msg(1, "旧")], [msg(1, "新")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe("新");
  });

  it("空进空出,不动原数组", () => {
    const list = [msg(1)];
    expect(mergeMessages(list, [])).toEqual(list);
    expect(mergeMessages([], [])).toEqual([]);
  });
});

describe("rankFriendship", () => {
  it("待我处理的排最前,我发出的排最后", () => {
    expect(rankFriendship("pending", "incoming")).toBe(0);
    expect(rankFriendship("accepted", "outgoing")).toBe(1);
    expect(rankFriendship("accepted", "incoming")).toBe(1);
    expect(rankFriendship("pending", "outgoing")).toBe(2);
  });
});

/** 本地时区里造一个时刻 —— 断言不能因为跑在哪个时区而变 */
const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

describe("timeLabel", () => {
  const now = at(2026, 8, 25, 20, 0);

  it("今天只给时分", () => {
    expect(timeLabel(at(2026, 8, 25, 9, 5).toISOString(), now.getTime())).toBe("09:05");
  });

  it("昨天带「昨天」——按日历日算,不是按 24 小时", () => {
    // 只差 21 小时,但跨了零点
    expect(timeLabel(at(2026, 8, 24, 23, 30).toISOString(), now.getTime())).toBe("昨天 23:30");
  });

  it("同年更早的带月日", () => {
    expect(timeLabel(at(2026, 3, 2, 8, 7).toISOString(), now.getTime())).toBe("3月2日 08:07");
  });

  it("跨年才带年份", () => {
    expect(timeLabel(at(2025, 12, 31, 8, 7).toISOString(), now.getTime())).toBe("2025年12月31日 08:07");
  });

  it("解不动的时间不抛,给空串", () => {
    expect(timeLabel("不是时间", now.getTime())).toBe("");
  });
});

describe("needsTimeLabel", () => {
  it("第一条一定插", () => {
    expect(needsTimeLabel(at(2026, 8, 25, 9, 0).toISOString(), null)).toBe(true);
  });

  it("五分钟以内不插", () => {
    expect(needsTimeLabel(
      at(2026, 8, 25, 9, 4).toISOString(),
      at(2026, 8, 25, 9, 0).toISOString(),
    )).toBe(false);
  });

  it("满五分钟就插", () => {
    expect(needsTimeLabel(
      at(2026, 8, 25, 9, 5).toISOString(),
      at(2026, 8, 25, 9, 0).toISOString(),
    )).toBe(true);
  });
});
