// 问卷卡 —— ask_user 的门面。模型问、人答，答案作为 tool_result 回上下文。
// 位置与审批卡一致（贴着输入框、挂靠当前会话）：两者是同一类东西——
// 「管线停在这，等一个人」。一致 = 用户不用学第二套规矩。

import { X } from "lucide-react";
import type { AskUserAnswer } from "../../../shared/askUser.js";
import { useChat } from "../store.js";
import { Button } from "./ui/button.js";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoiceLabel,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
  type QuestionnaireValues,
} from "./ui/questionnaire.js";

/** 题目的表单 key。用下标而不是 header：模型完全可能两题同名，
    同名 key 会让第二题的答案覆盖第一题 */
const keyOf = (index: number) => `q${index}`;

export function QuestionnaireCard() {
  // 只渲染挂靠在当前会话上的卷——别的会话的提问留在它自己的视图里
  const ask = useChat((s) => s.asks[s.sessionId] ?? null);
  const answerQuestions = useChat((s) => s.answerQuestions);

  if (!ask) return null;

  const submit = (values: QuestionnaireValues) => {
    const answers: AskUserAnswer[] = ask.questions.map((q, i) => {
      const v = values[keyOf(i)] ?? { selected: [], custom: "" };
      const custom = v.custom.trim();
      return { header: q.header, selected: v.selected, ...(custom ? { custom } : {}) };
    });
    void answerQuestions(answers);
  };

  return (
    // 与审批卡同一进场：从下方 8px 淡入——它物理上贴着输入框，从来处进场。
    // key 换 = 新一张卷重新进场，而不是在旧卡上悄悄换字
    <div
      key={ask.toolCallId}
      className="mx-5 mb-2 rounded-[10px] border border-primary/40 bg-primary/[0.05] transition-[opacity,transform] duration-[220ms] ease-strong starting:translate-y-2 starting:opacity-0 motion-reduce:transition-opacity motion-reduce:duration-200 motion-reduce:starting:translate-y-0"
    >
      <div className="flex items-center gap-2 px-[14px] pt-2">
        <span className="text-xs font-semibold text-primary">Otto 想先问你几件事</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="不回答，关掉问卷"
          title="不回答（模型会知道没人答，并就此收手）"
          className="ml-auto size-6 text-muted-foreground"
          onClick={() => void answerQuestions(null)}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <Questionnaire
        className="px-[14px] pt-1 pb-3"
        items={ask.questions.map((q, i) => ({
          name: keyOf(i),
          ...(q.multiSelect ? { multiple: true } : {}),
        }))}
        onSubmit={submit}
      >
        <QuestionnaireProgress />
        {ask.questions.map((q, i) => (
          <QuestionnaireItem
            key={keyOf(i)}
            name={keyOf(i)}
            {...(q.multiSelect ? { multiple: true } : {})}
          >
            <QuestionnaireDescription>{q.header}</QuestionnaireDescription>
            <QuestionnaireTitle>{q.question}</QuestionnaireTitle>
            <QuestionnaireChoices>
              {q.options.map((o, oi) => (
                <QuestionnaireChoice key={o.label} value={o.label} shortcut={oi + 1}>
                  <QuestionnaireChoiceLabel>{o.label}</QuestionnaireChoiceLabel>
                  <QuestionnaireChoiceDescription>{o.description}</QuestionnaireChoiceDescription>
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
            <QuestionnaireInput />
            <QuestionnaireError />
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          {ask.questions.length > 1 && <QuestionnairePrevious />}
          <QuestionnaireSkip />
          <QuestionnaireNext />
          <QuestionnaireSubmit>提交</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}
