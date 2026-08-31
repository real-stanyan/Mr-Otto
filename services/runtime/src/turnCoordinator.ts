// 云 runtime 的 turn 协调器：@触发、单 turn 互斥、无隐形队列（ADR-0199）

export type ChatDecision = "start_turn" | "logged_only";

export interface TurnCoordinator {
  /** 一条已落盘的成员发言进来，决定它是否点火。turn 跑着时永远 logged_only（注入靠投影层）。 */
  onChat(mention: boolean): ChatDecision;
  turnStarted(): void; // daemon 真正起跑后回报
  turnEnded(): void;
  isRunning(): boolean;
}

type State = "idle" | "claimed" | "running";

export function createTurnCoordinator(): TurnCoordinator {
  let state: State = "idle";

  return {
    onChat(mention: boolean): ChatDecision {
      if (!mention) {
        return "logged_only";
      }

      // mention = true
      if (state === "idle") {
        state = "claimed";
        return "start_turn";
      }

      // state is "claimed" or "running"
      return "logged_only";
    },

    turnStarted(): void {
      // claimed → running
      if (state === "claimed") {
        state = "running";
      }
    },

    turnEnded(): void {
      // running → idle
      if (state === "running") {
        state = "idle";
      }
    },

    isRunning(): boolean {
      return state === "running";
    },
  };
}
