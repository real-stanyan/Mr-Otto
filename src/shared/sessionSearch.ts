// session_search 的纯数据形状 + 解析器。放 shared：渲染进程只许 import src/shared/*，
// 不许 import src/tools/*（工具层是主进程的东西）——UI 要认这份结果的形状，
// 就必须能从这里拿，而不是越界戳工具实现（同 memoryStore.ts 的先例）。

export type SessionSearchMode = "discovery" | "scroll" | "read" | "browse";

export interface SessionSearchResult {
  mode: SessionSearchMode;
  query?: string;
  /** discovery 专属：按 session 去重后的命中列表 */
  chunks?: {
    id: string;
    sessionId: string;
    seq: number;
    source: string;
    locator: string;
    text: string;
    score: number;
  }[];
  /** read 专属：整段会话的元数据 */
  document?: {
    sessionId: string;
    title: string;
    pages: number;
    anchors: { page: number; label: string }[];
  };
}

export const SESSION_SEARCH_RESULT_MARK = "<!--session_search:";

/** 从工具输出末行抠出机器可读的 JSON 尾巴。抠不出/解析不了 = null（同
    parseMemoryResult 的先例：UI 拿到 null 就退回纯文本渲染，不崩） */
export function parseSessionSearchResult(output: string): SessionSearchResult | null {
  const i = output.lastIndexOf(SESSION_SEARCH_RESULT_MARK);
  if (i < 0) return null;
  const end = output.lastIndexOf("-->");
  if (end < i) return null;
  try {
    return JSON.parse(output.slice(i + SESSION_SEARCH_RESULT_MARK.length, end)) as SessionSearchResult;
  } catch {
    return null;
  }
}
