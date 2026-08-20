// 问卷卡 —— ask_user 的门面。模型问、人答，答案作为 tool_result 回上下文。
// 位置与审批卡一致（贴着输入框、挂靠当前会话）：两者是同一类东西——
// 「管线停在这，等一个人」。一致 = 用户不用学第二套规矩。
//
// 外壳用 elements/elicitation-form：审批卡已经穿上 permission-grant 的壳，
// 这两张卡是一对，壳不一样就等于告诉用户它们是两种东西。
// 身子仍是本仓的 Questionnaire —— 原件是「MCP server 要几个字段」，一屏填完、
// 只读展示；本仓是多步问卷（选项/多选/自填/可跳过/键盘直选），换过去是降级。

import { MessageCircleQuestion, X } from "lucide-react";
import type { AskUserAnswer } from "../../../shared/askUser.js";
import { useChat } from "../store.js";
import { ElicitationForm } from "./elements/elicitation-form.js";
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
    // key 换 = 新一张卷重新进场，而不是在旧卡上悄悄换字。
    // 圆角/底色压回审批卡那一套：并排出现的两张卡长得不一样，看着就像两个来源
    <ElicitationForm
      key={ask.toolCallId}
      server="Otto 想先问你几件事"
      state="request"
      icon={<MessageCircleQuestion className="size-3.5" />}
      headerEnd={
        <Button
          variant="ghost"
          size="icon"
          aria-label="不回答，关掉问卷"
          title="不回答（模型会知道没人答，并就此收手）"
          className="-mr-1 size-6 shrink-0 text-muted-foreground"
          onClick={() => void answerQuestions(null)}
        >
          <X className="size-3.5" />
        </Button>
      }
      /* 推进钮（上一题/跳过/下一题/提交）在问卷身子里，卡底不留空排 */
      actions={null}
      className="mx-5 mb-2 max-w-none gap-2 rounded-[10px] border-primary/40 bg-primary/[0.05] p-[14px] pt-2 transition-[opacity,transform] duration-[220ms] ease-strong starting:translate-y-2 starting:opacity-0 motion-reduce:transition-opacity motion-reduce:duration-200 motion-reduce:starting:translate-y-0 dark:bg-primary/[0.05]"
    >
      <Questionnaire
        className="pb-1"
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
    </ElicitationForm>
  );
}
