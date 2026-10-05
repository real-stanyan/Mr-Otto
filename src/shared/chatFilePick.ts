// 手机上挑一份文件发进聊天（#1683）的纯判据：挑出来的那一份收不收、收的话名字与格式是什么；文件卡上那枚角标画什么。
// 收发两头的形状（ChatMediaItem / PreparedMedia / 白名单 / 20MB）都在 chatMedia.ts，这里只管「文件选择器给的那一份 →
// PreparedMedia」这一步——它依赖的全是系统给的、不可信的三格（名字、大小、mimeType），判据放进 vitest 才钉得住。
//
// 纯文件：不许 import node builtin / electron —— 手机端（Expo/RN）直接 import 这一份。
import {
  DOCX_MIME, FILE_MAX_BYTES, PPTX_MIME, XLSX_MIME, cleanFileName, docMimeForName, extForMime, isDocMime,
  type DocMime, type PreparedMedia,
} from "./chatMedia.js";

export const FILE_PROBLEM = {
  unsupported: "这种文件发不了（支持 PDF、Word、Excel、PPT、文本）",
  tooBig: "文件超过 20MB，发不了",
  unreadable: "读不出这个文件（空文件，或者已经不在了），发不了",
} as const;

/** 文件选择器给的一份（expo-document-picker 的 DocumentPickerAsset 那几格）。bytes 缺席 = 系统没给，调用方先自己量一次 */
export interface PickedDoc {
  name: string;
  uri: string;
  bytes: number | undefined;
  mimeType?: string | undefined;
}

export type PickedDocOutcome = { ok: true; item: PreparedMedia } | { ok: false; problem: string };

/**
 * 挑出来的一份收不收。**格式先按扩展名认**、认不出再看系统给的 mimeType：iOS 对认不出的扩展名报
 * `application/octet-stream`，安卓对 .md 也常是它；反过来系统给的 mimeType 偶尔带参数或大小写不一（`text/plain; charset=utf-8`），
 * 先剥掉再比。名字过 cleanFileName（剥路径、去控制字符、截长保扩展名）；剥完是空的按格式起一个。
 * 大小判在格式之后：一份 30MB 的 zip 该听到「这种文件发不了」，不是「超过 20MB」。
 */
export function preparePickedDoc(a: PickedDoc): PickedDocOutcome {
  const name = cleanFileName(a.name);
  const sys = (a.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const mime: DocMime | null = (name !== null ? docMimeForName(name) : null) ?? (isDocMime(sys) ? sys : null);
  if (mime === null) return { ok: false, problem: FILE_PROBLEM.unsupported };
  if (a.bytes === undefined || !(a.bytes > 0)) return { ok: false, problem: FILE_PROBLEM.unreadable };
  if (a.bytes > FILE_MAX_BYTES) return { ok: false, problem: FILE_PROBLEM.tooBig };
  return {
    ok: true,
    item: { kind: "file", uri: a.uri, mediaType: mime, bytes: a.bytes, width: 0, height: 0, name: name ?? `file.${extForMime(mime) ?? "bin"}` },
  };
}

/** 文件卡上那枚角标：哪一族（定颜色）+ 写什么字（扩展名大写）。认不出的格式按文本那一族画（灰） */
export type FileFamily = "pdf" | "word" | "excel" | "ppt" | "text";

export function fileBadgeOf(mediaType: string): { family: FileFamily; label: string } {
  const ext = (extForMime(mediaType) ?? "file").toUpperCase();
  if (mediaType === "application/pdf") return { family: "pdf", label: ext };
  if (mediaType === DOCX_MIME) return { family: "word", label: ext };
  if (mediaType === XLSX_MIME) return { family: "excel", label: ext };
  if (mediaType === PPTX_MIME) return { family: "ppt", label: ext };
  return { family: "text", label: ext };
}
