// UIQuestioner — Asker 的 GUI 实现，UIApprover 的孪生兄弟。
// ask() 返回一个不 resolve 的 Promise → ask_user 这次调用在管线里悬停，
// 直到渲染进程交了答卷、IPC 调 resolve(toolCallId, outcome) 把它唤醒。
// 引擎对此毫无感知——它只是在 await 一个工具的 run。

import type { AskUserOutcome, AskUserQuestion, Asker } from "../shared/askUser.js";

export class UIQuestioner implements Asker {
  private pending = new Map<string, (outcome: AskUserOutcome) => void>();

  constructor(
    /** 怎么把问卷送到 UI（主进程注入 webContents.send） */
    private readonly requestFromUI: (toolCallId: string, questions: AskUserQuestion[]) => void
  ) {}

  ask(
    request: { toolCallId: string; questions: AskUserQuestion[] },
    signal?: AbortSignal
  ): Promise<AskUserOutcome> {
    const { toolCallId, questions } = request;
    return new Promise((resolve) => {
      // turn 中断（ADR-0006）：挂起的问卷立即以"已取消"收场。
      // 已中止的信号直接短路，不给 UI 发一张必死的卡
      const abortOutcome: AskUserOutcome = { status: "cancelled", reason: "turn 被用户中断" };
      if (signal?.aborted) return resolve(abortOutcome);
      this.pending.set(toolCallId, resolve);
      this.requestFromUI(toolCallId, questions);
      signal?.addEventListener(
        "abort",
        () => {
          // 人已经交卷（pending 里没了）就不重复收场
          if (this.pending.delete(toolCallId)) resolve(abortOutcome);
        },
        { once: true }
      );
    });
  }

  /** IPC 入口：用户交卷（或关掉了卡片）。没有对应挂起项 = 重复提交/过期卡，忽略 */
  resolve(toolCallId: string, outcome: AskUserOutcome): void {
    const wake = this.pending.get(toolCallId);
    if (!wake) return;
    this.pending.delete(toolCallId);
    wake(outcome);
  }
}
