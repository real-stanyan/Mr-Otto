// 长按消息派智能体的引用拼接（#1505，ADR-0352）：行 → 能引用的句、以被选那条为末尾往前取窗、开场白的形状。
import { describe, expect, it } from "vitest";
import { DISPATCH_DEFAULT_PROMPT, DISPATCH_QUOTE_MAX_CHARS, dispatchOpening, parseDispatchOpening, quoteLinesFromRows, quoteWindow } from "../../src/shared/dispatchQuote.js";
import type { ChatRow } from "../../src/shared/mobileChat.js";

const rows: ChatRow[] = [
  { kind: "time", key: "t1", label: "10:00" },
  { kind: "human", key: "e1", ts: 1, uid: "u2", name: "阿峰", text: "明天的货能到吗" },
  { kind: "note", key: "e2", ts: 2, text: "系统说了句话", tone: "muted", detail: null },
  { kind: "mine", key: "e3", ts: 3, text: "我问问仓库" },
  { kind: "agent", key: "e4", ts: 4, agentId: "a1", name: "运维", paragraphs: ["查到了。", "明天下午到。"] },
  { kind: "human", key: "e5", ts: 5, uid: "u2", name: "阿峰", text: "那帮我订 20 箱" },
];

describe("quoteLinesFromRows", () => {
  it("只留我 / 别人 / 智能体说的；智能体几段拼一句；我叫我的名字", () => {
    expect(quoteLinesFromRows(rows, "Stan")).toEqual([
      { key: "e1", who: "阿峰", text: "明天的货能到吗" },
      { key: "e3", who: "Stan", text: "我问问仓库" },
      { key: "e4", who: "运维", text: "查到了。\n明天下午到。" },
      { key: "e5", who: "阿峰", text: "那帮我订 20 箱" },
    ]);
  });
});

describe("quoteWindow", () => {
  const lines = quoteLinesFromRows(rows, "Stan");
  it("以被选那条为末尾、往前最多 before 句；换行折成空格", () => {
    expect(quoteWindow(lines, "e5", 2)?.map((l) => l.key)).toEqual(["e3", "e4", "e5"]);
    expect(quoteWindow(lines, "e5", 2)?.[1]?.text).toBe("查到了。 明天下午到。");
    expect(quoteWindow(lines, "e1")?.map((l) => l.key)).toEqual(["e1"]);
  });
  it("key 不在里面 → null；超过总字数从最旧的丢、被选那条永远在", () => {
    expect(quoteWindow(lines, "nope")).toBeNull();
    const long = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, who: "甲", text: "字".repeat(290) }));
    const w = quoteWindow(long, "k7", 7)!;
    expect(w[w.length - 1]?.key).toBe("k7");
    expect(w.length).toBeLessThan(8);
    expect(w.reduce((n, l) => n + l.who.length + l.text.length + 4, 0)).toBeLessThanOrEqual(DISPATCH_QUOTE_MAX_CHARS);
  });
});

describe("dispatchOpening", () => {
  it("[派活] + 提示 + 引用块；提示留空用默认那句；来源空就不写出处", () => {
    const text = dispatchOpening({ prompt: "  帮我把这单下了 ", source: "与峰同聊", lines: quoteWindow(quoteLinesFromRows(rows, "Stan"), "e5", 1)! });
    expect(text).toBe("[派活] 帮我把这单下了\n\n（引用自「与峰同聊」的对话，最后一条是要办的那条）\n> 运维：查到了。 明天下午到。\n> 阿峰：那帮我订 20 箱");
    expect(dispatchOpening({ prompt: "", source: "", lines: [] })).toBe(`[派活] ${DISPATCH_DEFAULT_PROMPT}\n\n（引用自的对话，最后一条是要办的那条）\n`);
  });
});

describe("parseDispatchOpening（#1665：派活那条画成卡，从开场白文本拆回来）", () => {
  const lines = [
    { key: "a", who: "Stan Yan", text: "是划算的" },
    { key: "b", who: "继爸", text: "帮我开个你本地会话" },
    { key: "c", who: "继爸", text: "[雨姐 代发] Stan，Mingxuan 让我跟你带个话：跑下 0066。" },
  ];

  it("dispatchOpening 拼出来的能原样拆回：要办什么 / 出处 / 前面几句 / 要办的那条", () => {
    const text = dispatchOpening({ prompt: "办一下", source: "和继爸的私聊", lines });
    expect(parseDispatchOpening(text)).toEqual({
      prompt: "办一下",
      source: "和继爸的私聊",
      before: [{ who: "Stan Yan", text: "是划算的" }, { who: "继爸", text: "帮我开个你本地会话" }],
      target: { who: "继爸", text: "[雨姐 代发] Stan，Mingxuan 让我跟你带个话：跑下 0066。" },
    });
  });

  it("没写提示 = 默认那句；出处空 = null；只引了一句 = before 为空", () => {
    const text = dispatchOpening({ prompt: "  ", source: " ", lines: [lines[0]!] });
    expect(parseDispatchOpening(text)).toEqual({
      prompt: DISPATCH_DEFAULT_PROMPT, source: null, before: [], target: { who: "Stan Yan", text: "是划算的" },
    });
  });

  it("那句里再有全角冒号：只按第一个切", () => {
    const text = dispatchOpening({ prompt: "看看", source: "群", lines: [{ key: "x", who: "阿峰", text: "注意：明天到" }] });
    expect(parseDispatchOpening(text)?.target).toEqual({ who: "阿峰", text: "注意：明天到" });
  });

  it("对不上形状的一律 null（照旧画普通气泡）", () => {
    const head = "[派活] 办一下\n\n（引用自「群」的对话，最后一条是要办的那条）";
    expect(parseDispatchOpening("办一下")).toBeNull();
    expect(parseDispatchOpening("[派活] 办一下")).toBeNull();
    expect(parseDispatchOpening(head)).toBeNull();
    expect(parseDispatchOpening(`${head}\n`)).toBeNull();
    expect(parseDispatchOpening(`${head}\n> 阿峰：好\n随手一行`)).toBeNull();
    expect(parseDispatchOpening(`${head}\n> 没有冒号`)).toBeNull();
    expect(parseDispatchOpening("[派活] 办一下\n\n随便写的\n> 阿峰：好")).toBeNull();
  });
});
