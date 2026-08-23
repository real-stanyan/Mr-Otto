// 子会话的紧凑转录:派活卡点开后,在卡片里滚着看的那一列。
//
// 不是完整的 thread(那要把 assistant-ui runtime 绑到子会话上,整屏切过去),
// 是从子日志投影出的一串"行":用户说了什么 / 模型回了什么 / 调了哪把工具、
// 成没成。够看清子 agent 做了什么,又不离开父会话。纯函数,vitest 直接跑。

import type { SessionEvent } from "../../../session/events.js";
import { buildToolIndex } from "./toolIndex.js";
import { toolSummary } from "../../../shared/toolSummary.js";

export type TranscriptRow =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      name: string;
      verb: string;
      target: string;
      status: "ok" | "error" | "denied" | "running";
      /** 出错/被拒时的那句话(首行) */
      note?: string;
    };

export function subagentTranscript(events: readonly SessionEvent[]): TranscriptRow[] {
  const index = buildToolIndex([...events]);
  const rows: TranscriptRow[] = [];
  for (const e of events) {
    if (e.type === "user_message") {
      rows.push({ kind: "user", text: e.content });
    } else if (e.type === "assistant_message") {
      if (e.content.trim() !== "") rows.push({ kind: "assistant", text: e.content });
      for (const call of e.toolCalls ?? []) {
        const r = index.results.get(call.id);
        const s = toolSummary(call);
        const row: TranscriptRow = {
          kind: "tool",
          name: call.name,
          verb: s.verb,
          target: s.target,
          status: r?.status ?? "running",
        };
        if (r && r.status !== "ok") row.note = r.output.split("\n")[0] ?? "";
        rows.push(row);
      }
    }
  }
  return rows;
}
