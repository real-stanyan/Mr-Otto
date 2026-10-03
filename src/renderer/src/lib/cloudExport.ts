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
import { cloudLogFilename, eventsJsonl } from "../../../shared/chatLogExport.js";

// 文件名 / 序列化已搬进 shared（#1446，手机导出共用），这里原样再导出，既有 import 点不动
export { cloudLogFilename };

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
