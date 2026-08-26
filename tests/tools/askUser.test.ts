import { describe, expect, it, vi } from "vitest";
import {
  ASK_USER_TOOL_NAME,
  createAskUserTool,
  parseAskUserArgs,
} from "../../src/tools/askUser.js";
import {
  formatAnswers,
  parseAskUserResult,
  type AskUserOutcome,
  type Asker,
} from "../../src/shared/askUser.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

/** 摸一下 world 就炸 —— 钉住"ask_user 的世界是人，不是文件系统" */
const forbiddenWorld = new Proxy({} as ExecutionWorld, {
  get(_t, prop) {
    throw new Error(`ask_user 不该碰 world（摸了 ${String(prop)}）`);
  },
});

const ok = { header: "路线", question: "走哪条?", options: [{ label: "A" }, { label: "B" }] };

function askerReturning(outcome: AskUserOutcome): Asker {
  return { ask: vi.fn(async () => outcome) };
}

describe("parseAskUserArgs", () => {
  it("最小合法形状：header + question + 两个选项", () => {
    expect(parseAskUserArgs({ questions: [ok] })).toEqual([
      { header: "路线", question: "走哪条?", options: [{ label: "A" }, { label: "B" }] },
    ]);
  });

  it("multiSelect / description 原样带上，缺省时不凭空补字段", () => {
    const parsed = parseAskUserArgs({
      questions: [
        {
          header: "开关",
          question: "开哪几个?",
          multiSelect: true,
          options: [
            { label: "A", description: "代价小" },
            { label: "B", description: "" },
          ],
        },
      ],
    });
    expect(parsed).toEqual([
      {
        header: "开关",
        question: "开哪几个?",
        multiSelect: true,
        // description 是空串 = 等于没写，不落进结果（UI 少一行空白）
        options: [{ label: "A", description: "代价小" }, { label: "B" }],
      },
    ]);
  });

  it("空题目表 / 超过 4 题都不收", () => {
    expect(parseAskUserArgs({ questions: [] })).toBeNull();
    expect(parseAskUserArgs({ questions: Array(5).fill(ok) })).toBeNull();
  });

  it("选项少于 2 个或多于 4 个不收——一个选项的题不是题", () => {
    expect(parseAskUserArgs({ questions: [{ ...ok, options: [{ label: "A" }] }] })).toBeNull();
    expect(
      parseAskUserArgs({
        questions: [{ ...ok, options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })) }],
      })
    ).toBeNull();
  });

  it("空 header / 空 question / 空 label 都不收——UI 上会变成瞎按钮", () => {
    expect(parseAskUserArgs({ questions: [{ ...ok, header: "  " }] })).toBeNull();
    expect(parseAskUserArgs({ questions: [{ ...ok, question: "" }] })).toBeNull();
    expect(parseAskUserArgs({ questions: [{ ...ok, options: [{ label: "" }, { label: "B" }] }] }))
      .toBeNull();
  });

  it("类型不对一律不收", () => {
    expect(parseAskUserArgs(null)).toBeNull();
    expect(parseAskUserArgs("questions")).toBeNull();
    expect(parseAskUserArgs({})).toBeNull();
    expect(parseAskUserArgs({ questions: "A" })).toBeNull();
    expect(parseAskUserArgs({ questions: [{ ...ok, multiSelect: "yes" }] })).toBeNull();
    expect(parseAskUserArgs({ questions: [{ ...ok, options: [{ label: "A" }, "B"] }] })).toBeNull();
  });
});

describe("formatAnswers", () => {
  it("逐题原样回述，选中项和自填并存", () => {
    expect(
      formatAnswers([
        { header: "路线", selected: ["A"] },
        { header: "开关", selected: ["x", "y"], custom: "还要 z" },
      ])
    ).toBe("【路线】A\n【开关】x；y；（自填）还要 z");
  });

  it("跳过的题明说跳过——空字符串会被模型当成「没选就是不要」", () => {
    expect(formatAnswers([{ header: "路线", selected: [] }])).toBe("【路线】用户跳过了这题");
  });

  it("一题都没答", () => {
    expect(formatAnswers([])).toBe("用户没有作答任何一题。");
  });
});

describe("parseAskUserResult", () => {
  // 往返是这组测试的主张：UI 读的那张卡和模型读的那段文本必须是同一份答卷。
  // formatAnswers 改了格式而 parseAskUserResult 没跟上，这里立刻红
  const roundTrip = (answers: Parameters<typeof formatAnswers>[0]) =>
    parseAskUserResult(formatAnswers(answers));

  it("单选 / 多选 / 自填 都能原样还原", () => {
    const answers = [
      { header: "路线", selected: ["A"] },
      { header: "开关", selected: ["x", "y"], custom: "还要 z" },
    ];
    expect(roundTrip(answers)).toEqual({ status: "answered", answers });
  });

  it("跳过的题还原成空 selected —— 不是「没这道题」", () => {
    expect(roundTrip([{ header: "路线", selected: [] }])).toEqual({
      status: "answered",
      answers: [{ header: "路线", selected: [] }],
    });
  });

  it("自填里带分号也不被切碎 —— 分隔符从「（自填）」起就不再生效", () => {
    const answers = [{ header: "备注", selected: [], custom: "先 A；再 B" }];
    expect(roundTrip(answers)).toEqual({ status: "answered", answers });
  });

  it("一题没答 / 被取消 各还原成自己的结局", () => {
    expect(parseAskUserResult("用户没有作答任何一题。")).toEqual({
      status: "answered",
      answers: [],
    });
    expect(parseAskUserResult("用户没有作答（turn 被用户中断）。")).toEqual({
      status: "cancelled",
      reason: "turn 被用户中断",
    });
  });

  it("不是这把工具的输出 → null，让 UI 落回通用工具行而不是编一张卡", () => {
    expect(parseAskUserResult("")).toBeNull();
    expect(parseAskUserResult("Error: 参数必须是 { questions: [...] }")).toBeNull();
    expect(parseAskUserResult("【路线】A\n这行没有题头")).toBeNull();
  });
});

describe("createAskUserTool", () => {
  const ctx = { toolCallId: "c1" };

  it("答卷回来 → 格式化文本喂回模型；全程不碰 world", async () => {
    const tool = createAskUserTool(
      askerReturning({ status: "answered", answers: [{ header: "路线", selected: ["A"] }] })
    );
    await expect(tool.run({ questions: [ok] }, forbiddenWorld, ctx)).resolves.toBe("【路线】A");
  });

  it("被取消 → 当步收口整个 turn，不让模型接着猜", async () => {
    const tool = createAskUserTool(
      askerReturning({ status: "cancelled", reason: "turn 被用户中断" })
    );
    await expect(tool.run({ questions: [ok] }, forbiddenWorld, ctx)).resolves.toEqual({
      output: "用户没有作答（turn 被用户中断）。",
      concludesTurn: true,
    });
  });

  it("toolCallId 和 signal 原样透给 asker —— 唤醒钥匙不能丢", async () => {
    const ask = vi.fn(async (): Promise<AskUserOutcome> => ({ status: "answered", answers: [] }));
    const signal = new AbortController().signal;
    await createAskUserTool({ ask }).run({ questions: [ok] }, forbiddenWorld, {
      toolCallId: "call-7",
      signal,
    });
    expect(ask).toHaveBeenCalledWith(
      { toolCallId: "call-7", questions: parseAskUserArgs({ questions: [ok] }) },
      signal
    );
  });

  it("参数不合法 → 抛错（status error），压根不惊动用户", async () => {
    const ask = vi.fn();
    await expect(
      createAskUserTool({ ask } as unknown as Asker).run({ questions: [] }, forbiddenWorld, ctx)
    ).rejects.toThrow(ASK_USER_TOOL_NAME);
    expect(ask).not.toHaveBeenCalled();
  });

  it("没有执行上下文（拿不到 toolCallId）→ 明说不支持，而不是永久悬停", async () => {
    const tool = createAskUserTool(askerReturning({ status: "answered", answers: [] }));
    await expect(tool.run({ questions: [ok] }, forbiddenWorld)).rejects.toThrow("不支持向用户提问");
  });

  it("不需要审批——问个问题不是危险操作", () => {
    expect(createAskUserTool(askerReturning({ status: "answered", answers: [] })).requiresApproval)
      .toBe(false);
  });
});
