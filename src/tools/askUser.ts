// ask_user — 把抉择权交回给人。模型在动手规划之前，用它把关键分岔抛出来，
// 用户在问卷卡片上选/自填，答案作为 tool_result 回到上下文。
//
// 这是唯一一个既不碰 ExecutionWorld 也不碰模型的工具：它的"世界"是人。
// 依赖注入的 Asker 决定"问人"怎么实现——GUI 是一次 IPC 往返，测试是脚本假人。

import type { Tool } from "./tool.js";
import type { AskUserAnswer, AskUserQuestion, Asker } from "../shared/askUser.js";

export const ASK_USER_TOOL_NAME = "ask_user";

/** 一次最多问几道题。超过就该拆成两轮——一屏答不完的问卷没人愿意答 */
const MAX_QUESTIONS = 4;
/** 一道题最多几个选项。选项多过四个说明这题还没想清楚 */
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** 参数校验。返回 null = 形状不对，run 会抛错让模型看到具体哪不对。
    校验严格是有意的：一张缺 label 的问卷发到 UI 上，用户面对的是个瞎按钮 */
export function parseAskUserArgs(args: unknown): AskUserQuestion[] | null {
  if (typeof args !== "object" || args === null) return null;
  const raw = (args as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return null;

  const questions: AskUserQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) return null;
    const { header, question, options, multiSelect } = q as Record<string, unknown>;
    if (!nonEmptyString(header) || !nonEmptyString(question)) return null;
    if (multiSelect !== undefined && typeof multiSelect !== "boolean") return null;
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return null;
    }
    const parsed = [];
    for (const o of options) {
      if (typeof o !== "object" || o === null) return null;
      const { label, description } = o as Record<string, unknown>;
      if (!nonEmptyString(label)) return null;
      if (description !== undefined && typeof description !== "string") return null;
      parsed.push({
        label,
        ...(nonEmptyString(description) ? { description } : {}),
      });
    }
    questions.push({
      header,
      question,
      options: parsed,
      ...(multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

/** 答案 → 喂回模型的文本。逐题原样回述，不做归纳——
    模型下一步要照着这个做决定，任何"帮它总结"都是在替用户改口供 */
export function formatAnswers(answers: AskUserAnswer[]): string {
  if (answers.length === 0) return "用户没有作答任何一题。";
  return answers
    .map((a) => {
      const picked = [...a.selected, ...(a.custom ? [`（自填）${a.custom}`] : [])];
      return `【${a.header}】${picked.length > 0 ? picked.join("；") : "用户跳过了这题"}`;
    })
    .join("\n");
}

/** 造一把 ask_user。asker 决定"问人"落到哪——注入而非 import，
    工具层因此对 Electron / IPC / 渲染进程一无所知 */
export function createAskUserTool(asker: Asker): Tool {
  return {
    def: {
      name: ASK_USER_TOOL_NAME,
      description:
        "把关键抉择交回给用户。在开始规划一个非平凡任务之前——尤其是当不同的合理理解会导出完全不同的做法时——" +
        "先用这个工具问清楚，别自己替用户拍板。也用于需求含糊、有多条技术路线、或某个决定难以回头的时候。\n" +
        "一次最多 4 题，每题 2-4 个选项，选项要互斥且具体（写清各自的代价，不要写「其他」——" +
        "用户永远可以自填）。推荐的选项放第一个，并在 label 末尾标注「（推荐）」。\n" +
        "用户可以跳过任何一题；跳过就是「你看着办」，不要再追问同一件事。\n" +
        "不要用它问那些看代码就能查到的事实，也不要用它确认你已经打算做的事。",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "1-4 道题",
            items: {
              type: "object",
              properties: {
                header: {
                  type: "string",
                  description: "卡片顶上的短标签（几个字的分类，如「收敛机制」「鉴权方式」），不是一句话",
                },
                question: { type: "string", description: "完整的问题，一句话说清在问什么" },
                multiSelect: {
                  type: "boolean",
                  description: "true = 可多选（选项互不排斥）。缺省单选",
                },
                options: {
                  type: "array",
                  description: "2-4 个互斥且具体的选项",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", description: "选项标题，简短" },
                      description: {
                        type: "string",
                        description: "这个选项意味着什么、代价是什么",
                      },
                    },
                    required: ["label"],
                  },
                },
              },
              required: ["header", "question", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    requiresApproval: false,

    async run(args, _world, ctx) {
      const questions = parseAskUserArgs(args);
      if (!questions) {
        throw new Error(
          `${ASK_USER_TOOL_NAME}: 参数必须是 { questions: [{ header, question, options: [{ label, description? }], multiSelect? }] }` +
            `，1-${MAX_QUESTIONS} 题，每题 ${MIN_OPTIONS}-${MAX_OPTIONS} 个选项`
        );
      }
      // 拿不到 toolCallId = 没跑在正经执行器里（裸管线/老测试）。
      // 此时没有唤醒钥匙，问了也没人能答——直接说清楚，别悬停到天荒地老
      if (!ctx) throw new Error(`${ASK_USER_TOOL_NAME}: 当前执行环境不支持向用户提问`);

      const outcome = await asker.ask(
        { toolCallId: ctx.toolCallId, questions },
        ctx.signal
      );
      if (outcome.status === "cancelled") {
        // 收口整个 turn：没人回答就别继续猜着往下做——这正是 concludesTurn 的用途
        return { output: `用户没有作答（${outcome.reason}）。`, concludesTurn: true };
      }
      return formatAnswers(outcome.answers);
    },
  };
}
