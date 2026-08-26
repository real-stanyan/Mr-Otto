import { describe, expect, it } from "vitest";
import { askCardRows } from "../../src/renderer/src/lib/askUserCard.js";
import type { AskUserOutcome } from "../../src/shared/askUser.js";

const args = {
  questions: [
    {
      header: "展示形态",
      question: "答完的问卷怎么留在时间线上?",
      options: [{ label: "内联工具卡" }, { label: "用户气泡", description: "右对齐" }],
    },
  ],
};

describe("askCardRows", () => {
  it("问题来自 args、答案来自 tool_result —— 选中的那个选项被标出来", () => {
    expect(
      askCardRows(args, {
        status: "answered",
        answers: [{ header: "展示形态", selected: ["内联工具卡"] }],
      })
    ).toEqual([
      {
        header: "展示形态",
        question: "答完的问卷怎么留在时间线上?",
        options: [
          { label: "内联工具卡", picked: true },
          { label: "用户气泡", picked: false },
        ],
        skipped: false,
      },
    ]);
  });

  it("自填答案单独出一行 —— 它不在选项表里，混进 chip 就成了「我给的选项」", () => {
    const [row] = askCardRows(args, {
      status: "answered",
      answers: [{ header: "展示形态", selected: [], custom: "两个都要" }],
    });
    expect(row?.custom).toBe("两个都要");
    expect(row?.options.every((o) => !o.picked)).toBe(true);
    expect(row?.skipped).toBe(false);
  });

  it("跳过的题标成 skipped —— 和「一个都没选中」是两件事", () => {
    const [row] = askCardRows(args, {
      status: "answered",
      answers: [{ header: "展示形态", selected: [] }],
    });
    expect(row?.skipped).toBe(true);
  });

  it("答案里出现选项表里没有的 label（旧日志 / 模型改过题面）→ 补一枚 chip，不丢答案", () => {
    const [row] = askCardRows(args, {
      status: "answered",
      answers: [{ header: "展示形态", selected: ["第三种"] }],
    });
    expect(row?.options).toEqual([
      { label: "内联工具卡", picked: false },
      { label: "用户气泡", picked: false },
      { label: "第三种", picked: true },
    ]);
  });

  it("按下标配对，不按 header —— 模型完全可能两题同名", () => {
    const twoSameHeader = {
      questions: [
        { header: "选项", question: "第一题?", options: [{ label: "A" }, { label: "B" }] },
        { header: "选项", question: "第二题?", options: [{ label: "A" }, { label: "B" }] },
      ],
    };
    const rows = askCardRows(twoSameHeader, {
      status: "answered",
      answers: [
        { header: "选项", selected: ["A"] },
        { header: "选项", selected: ["B"] },
      ],
    });
    expect(rows.map((r) => r.options.filter((o) => o.picked).map((o) => o.label))).toEqual([
      ["A"],
      ["B"],
    ]);
  });

  it("取消的那次只剩问题 —— 一个答案都没有，也不能把题面吞掉", () => {
    const rows = askCardRows(args, { status: "cancelled", reason: "turn 被用户中断" });
    expect(rows).toEqual([
      {
        header: "展示形态",
        question: "答完的问卷怎么留在时间线上?",
        options: [
          { label: "内联工具卡", picked: false },
          { label: "用户气泡", picked: false },
        ],
        skipped: false,
      },
    ]);
  });

  it("args 形状不对 → 空表，调用方据此落回通用工具行", () => {
    const outcome: AskUserOutcome = { status: "answered", answers: [] };
    expect(askCardRows(null, outcome)).toEqual([]);
    expect(askCardRows({ questions: "一堆字" }, outcome)).toEqual([]);
    expect(askCardRows({ questions: [{ question: 42 }] }, outcome)).toEqual([]);
  });
});
