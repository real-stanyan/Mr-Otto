import { describe, expect, it } from "vitest";
import {
  COWORK_LOG_NAME,
  fileNoticeFor,
  formatRecord,
  formatTs,
  lastForeignWrite,
  parseLog,
  staleWrite,
  staleWriteMessage,
  trimRecords,
  type CoworkRecord,
} from "../../src/shared/coworkLog.js";

// 协作记录（issue #658）：一行一条留言，人读得懂、机器解析得回来；
// 文件级的闸只在「别的家族在我看过之后动过同一个文件」时才响。

const rec = (over: Partial<CoworkRecord> = {}): CoworkRecord => ({
  ts: Date.parse("2026-08-28T10:40:12Z"),
  sessionId: "a7f3c1",
  path: "提案.md",
  reason: "把开头压到三行",
  ...over,
});

const mine = (id: string) => id === "me";

describe("formatTs", () => {
  it("带本地时区偏移，人不用心算时差", () => {
    expect(formatTs(Date.parse("2026-08-28T10:40:12Z"), 480)).toBe("2026-08-28T18:40:12+08:00");
    expect(formatTs(Date.parse("2026-08-28T10:40:12Z"), 0)).toBe("2026-08-28T10:40:12Z");
    expect(formatTs(Date.parse("2026-08-28T10:40:12Z"), -300)).toBe("2026-08-28T05:40:12-05:00");
  });
});

describe("formatRecord / parseLog 是一对逆函数", () => {
  it("写出去再读回来，四个字段一个不差", () => {
    const r = rec();
    const back = parseLog(formatRecord(r, 480));
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(r);
  });

  it("原因里带分隔符也不丢：前三段是结构，剩下的整段是自由文本", () => {
    const r = rec({ reason: "先删旧版 · 再补一段结论" });
    expect(parseLog(formatRecord(r, 0))[0]!.reason).toBe("先删旧版 · 再补一段结论");
  });

  it("没写原因时那一行只剩「谁动了什么」，读回来 reason 是空串", () => {
    const r = rec({ reason: "" });
    const line = formatRecord(r, 0);
    expect(line.endsWith("`提案.md`")).toBe(true);
    expect(parseLog(line)[0]).toEqual(r);
  });

  it("认不出的行跳过，不炸 —— 这是用户目录里的明文文件，他可能手改过", () => {
    const text = [
      "# Mr Otto 协作记录",
      "",
      "随便写的一句话",
      "- 这行不是记录",
      "- 不是时间 · x · `a.md` · 说明",
      formatRecord(rec(), 0),
      "- 2026-01-01T00:00:00Z · s2 · 路径没有反引号 · 说明",
    ].join("\n");
    const got = parseLog(text);
    expect(got).toHaveLength(1);
    expect(got[0]!.sessionId).toBe("a7f3c1");
  });
});

describe("lastForeignWrite", () => {
  const records = [
    rec({ ts: 100, sessionId: "me", path: "提案.md" }),
    rec({ ts: 200, sessionId: "other", path: "提案.md" }),
    rec({ ts: 300, sessionId: "other", path: "预算.md" }),
    rec({ ts: 400, sessionId: "me", path: "提案.md" }),
  ];

  it("只看别人动的那几次，取最近的一次", () => {
    expect(lastForeignWrite(records, "提案.md", mine)?.ts).toBe(200);
  });

  it("同家族不算别人 —— 子会话 / SideChat 共享工作区是故意的", () => {
    expect(lastForeignWrite(records, "提案.md", () => true)).toBeNull();
  });

  it("没人动过这个文件 → null", () => {
    expect(lastForeignWrite(records, "从没碰过.md", mine)).toBeNull();
  });
});

describe("staleWrite：只有撞上同一个文件才拦", () => {
  const records = [rec({ ts: 200, sessionId: "other", path: "提案.md" })];

  it("别人在我看过之后动了它 → 拦", () => {
    expect(staleWrite(records, "提案.md", 100, mine)?.ts).toBe(200);
  });

  it("我看过的版本比他的改动还新 → 放行", () => {
    expect(staleWrite(records, "提案.md", 300, mine)).toBeNull();
  });

  it("我从没看过它而别人动过 → 拦：这是闭着眼睛覆盖别人的文件", () => {
    expect(staleWrite(records, "提案.md", null, mine)?.ts).toBe(200);
  });

  it("别的文件一律放行 —— 一个写提案一个写预算，本来就不该互相打扰", () => {
    expect(staleWrite(records, "预算.md", null, mine)).toBeNull();
  });

  it("只有我在动的文件，永远不打扰", () => {
    const onlyMine = [rec({ ts: 200, sessionId: "me", path: "提案.md" })];
    expect(staleWrite(onlyMine, "提案.md", null, mine)).toBeNull();
  });
});

describe("给模型看的话", () => {
  it("拦下来时说清被谁改了、为什么，并且明写「先重读」", () => {
    const m = staleWriteMessage("提案.md", rec({ sessionId: "b2", reason: "客户要删掉第三段" }));
    expect(m).toContain("提案.md");
    expect(m).toContain("b2");
    expect(m).toContain("客户要删掉第三段");
    // 没有这句，模型的默认反应是原地重试
    expect(m).toContain("read_file");
    expect(m).toContain(COWORK_LOG_NAME);
  });

  it("那次没留原因时也不装作有", () => {
    expect(staleWriteMessage("a.md", rec({ reason: "" }))).toContain("没留原因");
  });

  it("按需注入：只报这一个文件的近况，不是整本", () => {
    const records = [
      rec({ ts: 200, sessionId: "other", path: "提案.md", reason: "压到三行" }),
      rec({ ts: 300, sessionId: "other", path: "预算.md", reason: "加差旅" }),
    ];
    const n = fileNoticeFor(records, "提案.md", mine, 0)!;
    expect(n).toContain("提案.md");
    expect(n).toContain("压到三行");
    expect(n).not.toContain("预算.md");
    expect(n).not.toContain("加差旅");
  });

  it("没人动过就不注入 —— 沉默是默认，不给模型加噪音", () => {
    expect(fileNoticeFor([], "提案.md", mine, 0)).toBeNull();
  });
});

describe("trimRecords", () => {
  it("超上限从最旧的开始扔，顺序不变", () => {
    const rs = Array.from({ length: 10 }, (_, i) => rec({ ts: i }));
    expect(trimRecords(rs, 3).map((r) => r.ts)).toEqual([7, 8, 9]);
  });

  it("没超就原样", () => {
    const rs = [rec({ ts: 1 }), rec({ ts: 2 })];
    expect(trimRecords(rs, 5)).toEqual(rs);
  });
});
