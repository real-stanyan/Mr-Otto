// 「这一款走哪条路」—— 同一个型号可能有两条路可走，lane 说的是走哪条。
//
//   auto  = 老规矩：自带 key 优先，没有 key 才用官方赠额（ADR-0020）
//   grant = 明确要花官方赠额，**哪怕自己配了 key**（ADR-0045）
//
// 为什么需要它：赠额只覆盖 DeepSeek，而 DeepSeek 恰好是最可能同时有两条路的一家。
// 没有 lane 的时候，"配了 key" 这一个事实同时决定了两件事——用不用自己的 key、
// 以及赠额那一组还显不显示。把它拆出来之后，显示归显示，付钱归付钱。
//
// lane 落进 model_changed 事件（可选字段，旧日志没有 = auto）：它决定这一个 turn
// 的钱从谁的账上出，那是"发生过什么"的一部分，不是运行时偏好。

export type ModelLane = "auto" | "grant";

/** 选单里赠额那一份的 id 前缀。同一款型号在选单里可能出现两次（自己的 key 一份、
    赠额一份），cmdk 按 value 认唯一项，所以两份得有不同的 id */
const GRANT_PREFIX = "grant:";

/** 型号 + lane → 选单里的 id */
export function laneValue(model: string, lane: ModelLane): string {
  return lane === "grant" ? `${GRANT_PREFIX}${model}` : model;
}

/** 选单里的 id → 型号 + lane。不带前缀的一律是 auto（也就是绝大多数） */
export function parseLaneValue(value: string): { model: string; lane: ModelLane } {
  return value.startsWith(GRANT_PREFIX)
    ? { model: value.slice(GRANT_PREFIX.length), lane: "grant" }
    : { model: value, lane: "auto" };
}

/** 当前 lane = 日志投影：最后一条 model_changed 说了算，没有就是 auto。
    和"当前型号"同一个取法（main/agent.ts），两边算的是同一件事 */
export function laneOf(events: readonly { type: string; lane?: ModelLane }[]): ModelLane {
  const last = events.filter((e) => e.type === "model_changed").at(-1);
  return last?.lane ?? "auto";
}
