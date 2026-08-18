// 从上游响应里刨出 usage —— 记账的唯一依据。
//
// 为什么不信客户端上报的用量:客户端是用户的机器,让它自报用了多少 token
// 等于让人自己填账单。用量只认 DeepSeek 在响应里给的数。
//
// 流式(SSE)的麻烦在于:字节要边收边原样转给客户端(不能等收完再转,那就没有流了),
// 而 usage 只在**终块**里(include_usage)。所以这里是个"嗅探器":
// 喂什么原样放行,同时顺手把 usage 抠出来。

import type { TokenUsage } from "./pricing.js";

export interface SniffedUsage extends TokenUsage {
  /** 上游自报的型号(可能与请求的不同,比如别名解析),按它计价 */
  model: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** OpenAI 方言的 usage 形状:{prompt_tokens, completion_tokens} */
export function readUsage(payload: unknown): TokenUsage | null {
  if (!isRecord(payload)) return null;
  const u = payload.usage;
  if (!isRecord(u)) return null;
  if (typeof u.prompt_tokens !== "number" && typeof u.completion_tokens !== "number") return null;
  return { promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens) };
}

export function readModel(payload: unknown): string {
  return isRecord(payload) && typeof payload.model === "string" ? payload.model : "";
}

/** 非流式:整个 body 就是一个 JSON */
export function sniffJson(body: string): SniffedUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const usage = readUsage(parsed);
  return usage ? { ...usage, model: readModel(parsed) } : null;
}

export interface UsageSniffer {
  /** 喂一段响应字节。返回值无意义——字节该怎么转发怎么转发,这里只是旁路偷看 */
  feed(chunk: Uint8Array): void;
  /** 流结束后拿结果。上游没给 usage 时为 null */
  result(): SniffedUsage | null;
}

/**
 * SSE 嗅探器。跨 chunk 的半行会被留在缓冲里等下一段,
 * 不然一个 usage 块正好被切成两半就漏账了。
 */
export function createUsageSniffer(): UsageSniffer {
  const decoder = new TextDecoder();
  let buffer = "";
  let found: SniffedUsage | null = null;
  let model = "";

  const takeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "" || data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // 半个 JSON / 非 JSON 心跳:跳过,不炸整条流
    }
    // 型号在首块就有,usage 在终块才有——分别记,别互相等
    const m = readModel(parsed);
    if (m) model = m;
    const usage = readUsage(parsed);
    // 终块之后若还有块,以最后一个带 usage 的为准
    if (usage) found = { ...usage, model };
  };

  return {
    feed(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        takeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    },
    result() {
      // 流可能不以换行收尾,残余也得看一眼
      if (buffer) {
        takeLine(buffer);
        buffer = "";
      }
      // model 可能在 usage 之后才认出来(极少见),补一刀
      if (found && !found.model && model) found = { ...found, model };
      return found;
    },
  };
}
