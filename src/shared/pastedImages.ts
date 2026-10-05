// 输入框里粘贴的图（#1645）：手机原生模块 otto-paste 把剪贴板 / 键盘「Paste from Screenshots」交来的图存成临时 PNG，
// 经 onPaste 报给 JS。这里验那条事件：只收本机临时文件（file://），字段齐、数是正的；多于一条消息能带的张数就截掉。
// 纯函数，手机端 import 同一份。
import { MEDIA_MAX_PER_MESSAGE } from "./chatMedia.js";

export interface PastedImage {
  uri: string;
  width: number;
  height: number;
  bytes: number;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function pastedImagesOf(raw: unknown): PastedImage[] {
  if (raw === null || typeof raw !== "object") return [];
  const list = (raw as { images?: unknown }).images;
  if (!Array.isArray(list)) return [];
  const out: PastedImage[] = [];
  for (const x of list) {
    if (x === null || typeof x !== "object") continue;
    const { uri, width, height, bytes } = x as Record<string, unknown>;
    if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
    if (!positive(width) || !positive(height) || !positive(bytes)) continue;
    out.push({ uri, width, height, bytes });
    if (out.length === MEDIA_MAX_PER_MESSAGE) break;
  }
  return out;
}
