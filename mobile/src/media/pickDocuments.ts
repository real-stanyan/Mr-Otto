// 从「文件」里挑文档发进聊天（#1683）：PDF、Word、Excel、PPT、文本。收不收的判据在 src/shared/chatFilePick.ts（进 vitest），
// 这里只接系统的文件选择器（expo-document-picker）。
//
// **它是原生模块，老原生包里没有**：热更新到一台老包上，JS 有了、原生那一半没有。expo-document-picker 的入口一 import 就
// requireNativeModule——在老包上直接抛，整个聊天页起不来。所以：
// · 有没有它先用 requireOptionalNativeModule 问（同 otto-speech 的做法，老包回 null），没有就不画「文件」那一格；
// · 模块本身到要挑的那一刻才 import（动态 import），老包上那一行永远不会跑到。
import { requireOptionalNativeModule } from "expo";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import { DOC_MIME_TYPES, type PreparedMedia } from "../../../src/shared/chatMedia.js";
import { preparePickedDoc } from "../../../src/shared/chatFilePick.js";

/** 这个原生包里有没有文件选择器（#1683 之前出的包没有：要重新出包，热更新补不上） */
export const documentPickerAvailable: boolean = requireOptionalNativeModule("ExpoDocumentPicker") !== null;

/** 给选择器的过滤。iOS 按 UTType 过滤，.md 属于 public.plain-text，text/plain 就带上了；
    安卓的文件管理器常把 .md 报成 text/x-markdown 或 octet-stream——不放进来它就是灰的点不了，放进来由 preparePickedDoc 再判一次 */
const PICK_TYPES: string[] = Platform.OS === "android"
  ? [...DOC_MIME_TYPES, "text/x-markdown", "application/octet-stream"]
  : [...DOC_MIME_TYPES];

function sizeOf(uri: string): number | undefined {
  try {
    return new File(uri).size;
  } catch {
    return undefined;
  }
}

/** 打开系统的文件选择器（可多选）。取消回空的两格（不是错）；收不下的那几份各说一句「名字：原因」，收下的照发 */
export async function pickDocuments(): Promise<{ ready: PreparedMedia[]; problems: string[] }> {
  if (!documentPickerAvailable) throw new Error("这个版本还不能发文件，更新 App 之后再试");
  const DocumentPicker = await import("expo-document-picker");
  const r = await DocumentPicker.getDocumentAsync({ type: PICK_TYPES, copyToCacheDirectory: true, multiple: true });
  if (r.canceled) return { ready: [], problems: [] };
  const ready: PreparedMedia[] = [];
  const problems: string[] = [];
  for (const a of r.assets) {
    const out = preparePickedDoc({ name: a.name, uri: a.uri, bytes: a.size ?? sizeOf(a.uri), mimeType: a.mimeType });
    if (out.ok) ready.push(out.item);
    else problems.push(`${a.name}：${out.problem}`);
  }
  return { ready, problems };
}
