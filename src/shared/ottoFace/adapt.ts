// ottoFace/adapt —— 仓里已有的状态 → 脸上的表情（#1345，ADR-0316）。
//
// 分出来的理由是**保鲜期**：映射留在组件的 JSX 里就没有断言能钉住它，而这一族判断
// 全是安静错的（一张脸停在别的表情上，不报错也不塌）。
//
// 今天只有一条：私聊头部那张脸。名册那一墙 `plain` 不经过这里（那不是一次映射，
// 是「我们查不到」这个事实本身，#1282）；通话那几格的映射在 `VoiceCallOverlay`
// 的 `TILE_FACE` —— 它吃的是 `CallTile["state"]`，而那是个渲染层自己的枚举。

import type { OpenTurn } from "../turnLedger.js";
import type { FaceState } from "./states.js";

/**
 * 私聊头部那张脸此刻是什么表情。
 *
 * · 一条都不欠 → `plain`。**不是 `idle`** —— 「没有开着的 turn」只说明它这会儿没在
 *   答我，说不了「它闲着」（它可能正在别的群里跑，#1282 之前这台机器查不到）。
 * · 排队中 → `queued`，**唯一完全不动的那一档**（ADR-0250：它一个 token 都还没跑）。
 * · 在跑、而且正文已经在往下掉 → `solving`（嘴在动）。
 * · 在跑、还一个字都没有 → `working`（皱眉 + 快呼吸）。
 *
 * 同一只排了两句话时**取 seq 最小那条**：`turnLedger` 认不出「那条动静属于哪一轮」，
 * 于是两行都读成 running，而真正在跑的只有最早那一条（同 `stopButtonRows` 的判据）。
 */
export function dmFaceState(
  pending: readonly OpenTurn[],
  streaming: Readonly<Record<string, string>>,
  agentId: string
): FaceState {
  let mine: OpenTurn | null = null;
  for (const t of pending) {
    if (t.agentId !== agentId) continue;
    if (mine === null || t.seq < mine.seq) mine = t;
  }
  if (mine === null) return "plain";
  if (mine.state === "queued") return "queued";
  return (streaming[agentId] ?? "") === "" ? "working" : "solving";
}
