// 云会话日志导出（#1117）：把这条云会话的全部事件落成一份 jsonl 拿出去分析。
//
// 数据源是 store.cloudSession.events —— backlog 全量（afterSeq:-1）+ 直播事件
// 渲染层本来就全拿得到，导出因此是纯本地动作：不打网络、不动协议、不动 runtime。
//
// 只出 jsonl 一种格式：它是唯一无损的那一份（能重放、能重算任何投影），
// 「导出所有 log 用于分析优化」要的正是它。结构化 json / 通读稿 markdown 是本地
// 轨迹视图那三格式的分工（replay/trajectoryExport.ts 文件头），云会话不复制
// 那一套——trajectory 投影吃的是本地会话的事件形状，云会话的 chat_message /
// agent_relay 等类型它没有对应的行。
//
// 序列化本身复用 trajectoryExport 的 eventsJsonl：「一行一条原始事件」只有一份
// 实现，两边分家那天不会有任何报错，只是导出内容悄悄不一样。

import type { SessionEvent } from "../../../session/events.js";
import { eventsJsonl } from "../replay/trajectoryExport.js";

/** 文件名里的时间戳：20260908-223012（本地时区，与 trajectoryExport 同一把尺） */
function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** `otto-cloud-3f9a1c-20260908-223012.jsonl`。带 cloud 前缀是为了落在下载目录里
    一眼分得清本地轨迹导出（otto-trajectory-*）——两者内容形状不同，混着喂给
    分析脚本会得到一堆解析错误 */
export function cloudLogFilename(sessionId: string, exportedTs: number): string {
  const id = sessionId.slice(0, 8) || "session";
  return `otto-cloud-${id}-${stamp(exportedTs)}.jsonl`;
}

export interface CloudLogFile {
  filename: string;
  mime: string;
  text: string;
}

/** 装出待落盘的那份文件。events 原样全量序列化——不过滤、不排序
    （store 那份本来就按 seq 去重升序，见 store.ts 的 onCloudSessionEvent） */
export function buildCloudLogExport(input: {
  sessionId: string;
  events: SessionEvent[];
  exportedTs: number;
}): CloudLogFile {
  return {
    filename: cloudLogFilename(input.sessionId, input.exportedTs),
    // 存的是原始日志，不是给浏览器解析的 JSON 文档（同 trajectoryExport 的 jsonl）
    mime: "application/x-ndjson",
    text: eventsJsonl(input.events),
  };
}
