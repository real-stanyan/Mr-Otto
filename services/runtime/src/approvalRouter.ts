// 审批路由 — cs approve 帧落到哪个 pending decide、谁能批（ADR-0199）
// decide 挂起 + onRequest 回调（daemon 拿去落盘/广播）+ 定时器超时自动 deny。
// resolve 只认发起人或 owner；无关成员回 false 且不消化 pending（daemon 只回 error 帧，不落盘）。

import type { Approver, ApprovalOutcome } from "../../../src/loop/approvalGate.js";
import type { ToolCallRequest } from "../../../src/session/events.js";
import type { Tool } from "../../../src/tools/tool.js";
import { approvalTimeoutMinutes } from "../../../src/shared/agentRelay.js";

/** cs approve 帧的三态回执（#957 A-11/#927）：`resolve` 原来把「无此 pending」
    和「无权批」两种拒绝都糊成同一个 false，frameHandler 因此只能回一句
    看不出原因的错误、也没有任何一行日志——拒绝是这一层唯一的失败出口，
    含糊等于让"谁拒的、为什么"永远只能靠读代码倒推（同 #915 的教训）。
    `no_pending` = 这个 callId 已经被消化过或从没存在过；`not_allowed` =
    pending 还在，但这个 uid 既不是发起人也不是 owner */
export type ApproveOutcome = "ok" | "no_pending" | "not_allowed";

export interface ApprovalRouterOpts {
  ownerUid: string;
  timeoutMs?: number; // 默认 600_000
  /** 接力棒上那一轮的超时（#959），默认 RELAY_APPROVAL_TIMEOUT_MS = 120_000。
      为什么另开一档而不是把 600s 一起调小：600s 是照着「人自己点的这一轮，他
      就在屏幕前」定的，那个前提对接力棒不成立——审批人是**点火的那个人**
      （spec §4.2），而这一棒是上一只 agent 替他叫起来的，他多半早就不看了。
      而 drain 是串行的：一张没人批的卡把这条会话之后的每一个 turn 都压住，
      默认口径下整个群聊冻十分钟。短超时是把冻结时长封顶，出声那一半在
      sessionService（relayApprovalWaitText） */
  relayTimeoutMs?: number;
  now?: () => number;
  onRequest: (req: {
    callId: string;
    toolName: string;
    argsSummary: string;
    /** 逐字段版（#957 B-C2）——`summarizeFields` 回非 null 时才在场。
        缺席 ≠ 空数组：落盘那一头按「在不在」决定摊不摊进事件 */
    argsFields?: { label: string; value: string }[];
    initiatorUid: string;
    /** 这张卡什么时候自己 deny——**按这一轮实际用的那档超时算**（#959）：
        卡上的倒计时与日志里的 expiresTs 都读它，写着 600s 却在第 2 分钟拒掉
        是最难查的那种撒谎 */
    expiresTs: number;
    /** 这一轮是不是接力棒起的（#959）。落盘那一头不用它，sessionService 拿它
        决定要不要在群里补一句「谁在等谁批」——冻结拦不住，至少要有声 */
    relay: boolean;
  }) => void; // daemon 拿去落盘+广播
  /** 审批卡上「参数摘要」那一段的文案（#954）：回字符串就用它，回 null 退回默认
      `JSON.stringify(args).slice(0, 200)`。默认那 200 字对 bash/write_file 够用，对
      create_agent 不够——一条 4000 字的提示词被截成 200 字，等于让人批一段没看见的
      提示词（ADR-0118 第二条：卡片含糊 = 闸形同虚设）。可选：不传 = 现状一字不变 */
  summarizeArgs?: (toolName: string, args: unknown) => string | null;
  /** 审批卡的逐字段版（#957 B-C2）：回数组就随 `approval_request` 落盘，回 null =
      这个工具没有逐字段呈现，卡上照旧画 `argsSummary`。
      为什么两个钩子并存而不是让 summarizeArgs 回结构：`argsSummary` 是旧客户端
      与旧日志唯一读得到的那一份，必须无条件继续生成——逐字段是**加**上去的一层，
      不是替换。可选：不传 = 现状一字不变。
      同一次 decide 里 `summarizeArgs` 与 `summarizeFields` 各解析一遍参数（create_agent
      那条是两次 `parseCreateAgentArgs`）——刻意不缓存：审批一条一次、参数就那么大，
      共享一次解析结果要么加一层按 callId 的旁路状态（decidedBy 那条教训），要么把两个
      钩子合成一个而牺牲「argsSummary 无条件生成」这条兼容承诺。 */
  summarizeFields?: (toolName: string, args: unknown) => { label: string; value: string }[] | null;
}

export interface ApprovalRouter extends Approver {
  setInitiator(uid: string): void; // 每条 turn 起跑前设
  /** 这一轮是不是接力棒起的（#959）。与 setInitiator 挨着设，同一个时机。
      **decide 那一刻取值定死**（不是定时器触发时现读）：下一轮的设置不该回头
      改一张已经挂起的卡的超时口径 */
  setRelayTurn(relay: boolean): void;
  /** cs approve 帧进来。回 false = 无此 pending 或无权（daemon 只回 error 帧，不落盘）。
      decidedBy：这次决定是谁按下的按钮，随 outcome 一起喂给 decide() 的 resolve——
      **显式参数，不是旁路存取**（复审 Important，issue #799 系列）：早先版本让调用方
      在 resolve() 之前把 {uid,label} 存进一个按 callId 键控的旁路 Map、resolve 内部
      再回读，这在"同 callId 背靠背两次 approve、不 await 中间态"时有 TOCTOU 窗口——
      第二次调用可能先覆盖 Map 里的条目、又因为 resolve 失败（pending 已被第一次消化）
      把整个 key 删掉，等第一次 resolve 触发的 decide() 续体去读时 Map 已空，
      decidedBy 静默丢失（decision 本身仍对，但审计"谁批的"这一列空了）。改成参数直接
      随 settle() 一起传，同一个 callId 的 pending 只能被消化一次（pending.delete 在
      settle 里发生），第二次调用连 entry 都查不到，早早短路返回 false——不存在
      "读到别人刚写的值"的窗口，因为压根没有共享的旁路状态可读 */
  resolve(callId: string, byUid: string, decision: "approved" | "denied", decidedBy?: { uid: string; label: string }): ApproveOutcome;
  canDecide(uid: string): boolean; // uid === initiator || uid === owner
}

interface Pending {
  initiatorUid: string;
  settle: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

const DEFAULT_TIMEOUT_MS = 600_000;
/** 接力棒上的审批超时（#959）。2 分钟不是"够人反应"的时长——接力棒上的审批人
    多半不在场，这个数封的是**别人被冻住多久**：drain 串行，这张卡挂着的每一秒
    群里其它回复都在排队。批不到就按拒绝处理，那一棒失败，链条继续往下走 */
export const RELAY_APPROVAL_TIMEOUT_MS = 120_000;

export function createApprovalRouter(opts: ApprovalRouterOpts): ApprovalRouter {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const relayTimeoutMs = opts.relayTimeoutMs ?? RELAY_APPROVAL_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const pending = new Map<string, Pending>();
  let initiatorUid = "";
  let relayTurn = false;

  function canDecide(uid: string): boolean {
    // 答的是「此 uid 此刻能不能当审批人」（用 live initiator），不是「能不能批某个具体 pending」
    // 具体归属判定以 resolve() 的快照为准
    return uid === initiatorUid || uid === opts.ownerUid;
  }

  return {
    setInitiator(uid: string): void {
      initiatorUid = uid;
    },

    setRelayTurn(relay: boolean): void {
      relayTurn = relay;
    },

    canDecide,

    async decide(call: ToolCallRequest, tool: Tool, signal?: AbortSignal): Promise<ApprovalOutcome> {
      const callId = call.id;
      // 这一刻取值定死（#959）：定时器触发在几分钟之后，那时 relayTurn 早就
      // 是下一轮的了——回头现读等于让别人的一轮决定这张卡的口径
      const relay = relayTurn;
      const ms = relay ? relayTimeoutMs : timeoutMs;
      const expiresTs = now() + ms;

      return new Promise<ApprovalOutcome>((resolvePromise) => {
        const cleanup = () => {
          clearTimeout(entry.timer);
          if (entry.abortHandler && signal) {
            signal.removeEventListener("abort", entry.abortHandler);
          }
          if (pending.get(callId) === entry) {
            pending.delete(callId);
          }
        };

        const settle = (outcome: ApprovalOutcome) => {
          cleanup();
          resolvePromise(outcome);
        };

        const timer = setTimeout(() => {
          // 两句话分开说（#959）：接力棒那一档拒得早，reason 不说清是"接力棒
          // 上的调用 + 只等了 2 分钟"的话，读日志的人只会以为自己的 10 分钟
          // 白等了。分钟数与群里那句旁白共用 approvalTimeoutMinutes——两处
          // 各写一遍 Math.round，改超时那天两句话会给出不同的数
          settle({
            decision: "denied",
            reason: relay ? `审批超时（接力棒上的调用，${approvalTimeoutMinutes(ms)} 分钟内没人批）` : "审批超时",
          });
        }, ms);

        const entry: Pending = { initiatorUid, settle, timer };
        pending.set(callId, entry);

        if (signal) {
          if (signal.aborted) {
            settle({ decision: "denied", reason: "turn 已中断" });
            return;
          }
          const abortHandler = () => {
            settle({ decision: "denied", reason: "turn 已中断" });
          };
          entry.abortHandler = abortHandler;
          signal.addEventListener("abort", abortHandler, { once: true });
        }

        const fields = opts.summarizeFields?.(tool.def.name, call.args) ?? null;
        opts.onRequest({
          callId,
          toolName: tool.def.name,
          argsSummary: opts.summarizeArgs?.(tool.def.name, call.args) ?? JSON.stringify(call.args).slice(0, 200),
          // 展开而不是恒定写 undefined：exactOptionalPropertyTypes 下
          // `{argsFields: undefined}` 与「没有这个键」是两件事，而落盘那一头
          // 正是按「在不在」决定摊不摊进事件的。
          // **空数组也算缺席**：桌面有 argsFields 就只画逐字段，一个空数组会画出
          // 一张什么都没有的卡，比退回 argsSummary 更糟（复审 Minor 3）
          ...(fields && fields.length > 0 ? { argsFields: fields } : {}),
          initiatorUid,
          expiresTs,
          relay,
        });
      });
    },

    resolve(
      callId: string,
      byUid: string,
      decision: "approved" | "denied",
      decidedBy?: { uid: string; label: string }
    ): ApproveOutcome {
      const entry = pending.get(callId);
      if (!entry) return "no_pending";
      if (byUid !== entry.initiatorUid && byUid !== opts.ownerUid) return "not_allowed";
      entry.settle({ decision, ...(decidedBy ? { decidedBy } : {}) });
      return "ok";
    },
  };
}
