// ask_user 那张「已作答」卡的纯逻辑：args 里的问题 + tool_result 里的答案 → 一行行可画的行。
// 抽出来不写进 OttoThread.tsx 的理由同 sessionSearchCard.ts：这层不碰 React，能被单测直接钉住
// （tests/renderer 没有 RTL，组件本体测不了，这一层能测）。
//
// 为什么问题要从 args 读：答卷文本（formatAnswers）只带 header，不带题面——
// 而「我当时被问的是什么」正是这张卡存在的理由。两半各在各的事件里，投影时才合起来
// （不为这件事加新事件类型，见 shared/askUser.ts 顶上那段）。
//
// 这里不 import src/tools/askUser.ts 的 parseAskUserArgs（渲染进程不许 import 工具层）。
// 也不是把那份校验抄一遍：那份的职责是「参数不合法就让模型看见哪不对」，这份的职责是
// 「认得出多少就画多少」——认不出就返回空表，让调用方落回通用工具行。

import type { AskUserOutcome } from "../../../shared/askUser.js";

/** 一枚选项 chip。picked = 用户当时选了它 */
export interface AskCardOption {
  label: string;
  picked: boolean;
}

/** 卡上的一题 */
export interface AskCardRow {
  header: string;
  question: string;
  options: AskCardOption[];
  /** 用户自填的答案。没有就整个字段不出现——它不是选项，画在 chip 里等于伪造了一个选项 */
  custom?: string;
  /** 明确跳过（选了「不答这题」），和「没选中任何选项」不是一回事 */
  skipped: boolean;
}

/** args 里那道题的最小可画形状。校验到能画为止，多一分都不管 */
interface RawQuestion {
  header: string;
  question: string;
  options: { label: string }[];
}

function readQuestions(args: unknown): RawQuestion[] | null {
  if (typeof args !== "object" || args === null) return null;
  const raw = (args as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return null;
  const out: RawQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) return null;
    const { header, question, options } = q as Record<string, unknown>;
    if (typeof header !== "string" || typeof question !== "string") return null;
    if (!Array.isArray(options)) return null;
    const labels: { label: string }[] = [];
    for (const o of options) {
      if (typeof o !== "object" || o === null) return null;
      const { label } = o as Record<string, unknown>;
      if (typeof label !== "string") return null;
      labels.push({ label });
    }
    out.push({ header, question, options: labels });
  }
  return out;
}

/** 问题（args）+ 结局（tool_result）→ 卡上的行。args 认不出来就返回空表。

    答案按**下标**配对，不按 header：模型完全可能两题同名（QuestionnaireCard 的表单 key
    是同一个理由）。取消的那次没有答案，只画题面——题面本身是已经发生过的事，不该被吞掉。

    选中的 label 在选项表里找不到（旧日志、或模型两次调用改了题面）就补一枚 chip：
    宁可多画一枚来路不明的 chip，也不能让用户的回答从时间线上消失。 */
export function askCardRows(args: unknown, outcome: AskUserOutcome): AskCardRow[] {
  const questions = readQuestions(args);
  if (questions === null) return [];
  const answers = outcome.status === "answered" ? outcome.answers : [];

  return questions.map((q, i) => {
    const a = answers[i];
    const picked = new Set(a?.selected ?? []);
    const options: AskCardOption[] = q.options.map((o) => ({
      label: o.label,
      picked: picked.has(o.label),
    }));
    const known = new Set(q.options.map((o) => o.label));
    for (const label of picked) if (!known.has(label)) options.push({ label, picked: true });

    const custom = a?.custom ?? "";
    return {
      header: q.header,
      question: q.question,
      options,
      ...(custom !== "" ? { custom } : {}),
      skipped: a !== undefined && picked.size === 0 && custom === "",
    };
  });
}
