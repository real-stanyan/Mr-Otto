// ask_user 的共享世界 —— 形状 + 答卷的编解码，主进程/渲染进程/工具三边共 import。
// 编解码放这儿而不是 src/tools/askUser.ts：时间线上那张「问了什么、答了什么」的卡
// 由渲染进程画，而渲染进程不许 import 工具层（同 shared/sessionSearch.ts 的理由）。
// 与 shellBridge.ts 同一法理：形状定义放中间，两端各自实现。
//
// 为什么问卷不需要新事件类型：问题存在 assistant_message.toolCalls[].args 里，
// 答案存在 tool_result.output 里，两头本来就落盘、本来就进投影——
// 再加一个 question_asked 事件就是把同一件事记两遍（ADR-0018，先例见 ADR-0017）。

/** 一个选项。description 是选项底下那行小字（讲清代价/取舍），可省 */
export interface AskUserOption {
  label: string;
  description?: string;
}

/** 一道题。header 是卡片顶上的短标签（分类用，别写成一句话）；
    multiSelect = 可多选（互不排斥的选项），缺省单选 */
export interface AskUserQuestion {
  header: string;
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean;
}

/** 主进程推给渲染层的一张问卷卡。toolCallId 是唤醒挂起 Promise 的钥匙 */
export interface AskUserRequest {
  sessionId: string;
  toolCallId: string;
  questions: AskUserQuestion[];
}

/** 一道题的作答。selected 空数组 = 跳过（用户明确表示"这题不答"）；
    custom = 用户自填的答案（"其他"），与 selected 可并存 */
export interface AskUserAnswer {
  header: string;
  selected: string[];
  custom?: string;
}

/** 作答结果。cancelled = 用户关了卡片 / turn 被中断，模型得知道没人回答，
    而不是收到一份空答卷误以为"用户全跳过了" */
export type AskUserOutcome =
  | { status: "answered"; answers: AskUserAnswer[] }
  | { status: "cancelled"; reason: string };

/** 问人的能力接口 —— 工具只认这个形状。
    GUI 实现 = 一次 UI 往返（UIQuestioner）；测试假人 = 直接返回脚本答案。
    signal：turn 被中断时必须让挂起的 ask 立即返回，否则管线卡死等一个不会来的人 */
export interface Asker {
  ask(request: Omit<AskUserRequest, "sessionId">, signal?: AbortSignal): Promise<AskUserOutcome>;
}

// 答卷文本的几个记号。抽成常量不是为了少打字，是为了让 formatAnswers 和
// parseAskUserResult 咬同一份字面量——一边改了另一边不改，编译期就不该放过
const NO_ANSWERS = "用户没有作答任何一题。";
const SKIPPED = "用户跳过了这题";
const CUSTOM_PREFIX = "（自填）";
const SEP = "；";

/** 答案 → 喂回模型的文本。逐题原样回述，不做归纳——
    模型下一步要照着这个做决定，任何"帮它总结"都是在替用户改口供 */
export function formatAnswers(answers: AskUserAnswer[]): string {
  if (answers.length === 0) return NO_ANSWERS;
  return answers
    .map((a) => {
      const picked = [...a.selected, ...(a.custom ? [`${CUSTOM_PREFIX}${a.custom}`] : [])];
      return `【${a.header}】${picked.length > 0 ? picked.join(SEP) : SKIPPED}`;
    })
    .join("\n");
}

/** formatAnswers 的逆函数 —— 把回给模型的那段文本读回成答卷。
    给 UI 用：时间线上「模型问了什么、我答了什么」只有这段文本记着答案
    （问题那半边在 call.args 里，见本文件顶上那段：不为这件事加新事件类型）。
    放在 formatAnswers 正下方是有意的：两个函数是一对，同文件才不会各自漂——
    格式改了而这边没跟上，tests/tools/askUser.test.ts 的往返用例当场红。

    认不出来就返回 null（空串、报错文本、缺题头的行），让调用方落回通用工具行：
    编一张半真的卡比不画更糟。 */
export function parseAskUserResult(output: string): AskUserOutcome | null {
  const text = output.trim();
  if (text === "") return null;
  if (text === NO_ANSWERS) return { status: "answered", answers: [] };
  const cancelled = /^用户没有作答（([\s\S]*)）。$/.exec(text);
  if (cancelled) return { status: "cancelled", reason: cancelled[1] ?? "" };

  const answers: AskUserAnswer[] = [];
  for (const line of text.split("\n")) {
    const m = /^【([^】]*)】([\s\S]*)$/.exec(line);
    if (!m) return null;
    const [, header = "", payload = ""] = m;
    if (payload === SKIPPED) {
      answers.push({ header, selected: [] });
      continue;
    }
    // 「（自填）」一出现，后面整段都是用户自己敲的字——分隔符从这里起就不再生效，
    // 否则自填里带一个「；」就会被切成两个选项
    const at = payload.indexOf(CUSTOM_PREFIX);
    const head = at === -1 ? payload : payload.slice(0, at);
    const custom = at === -1 ? "" : payload.slice(at + CUSTOM_PREFIX.length);
    const selected = head.split(SEP).filter((s) => s !== "");
    answers.push({ header, selected, ...(custom !== "" ? { custom } : {}) });
  }
  return { status: "answered", answers };
}
