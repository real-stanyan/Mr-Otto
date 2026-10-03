// 聊天信息页的「导出聊天记录」（#1446）：把这条聊天的全部原始事件写成 jsonl 文件交给系统分享单。
//
// 判据和翻页编排全在 shared/chatLogExport（两端共用）；这里只有手机自己的三件事：
// · 只有**此刻开着的那条**聊天读得到事件（chatStore 同一时刻只开一条，信息页是从打开的聊天页进来的）。
//   对不上 / 还没连上就说清去哪儿，不为导出另开一条连接把正在看的会话挤掉
// · 翻页走 chatStore 的 loadOlderPage（同聊天页那个哨兵用的动作）
// · 落盘：缓存目录里一个临时文件（系统空间紧时自己会清）。SDK 57 的 expo-file-system 是 File / Paths 那套

import { File, Paths } from "expo-file-system";
import {
  cloudLogFilename,
  collectFullLog,
  eventsJsonl,
  openSessionMatches,
  pagerDeps,
  runChatExport,
  type ExportTarget,
  type PartialChoice,
} from "../../../src/shared/chatLogExport.js";
import { currentChatSession, loadOlderPage, type ChatSession } from "../cloud/chatStore.js";

export type { ExportTarget };
export const EXPORT_NOT_READY = "先回到聊天页等它连上再导出";

export type ExportResult = { ok: true; uri: string; count: number } | { ok: false; message: string };

export async function exportChatLog(
  target: ExportTarget,
  io: {
    onProgress(count: number): void;
    /** 没翻齐时问人。resolve 要等弹窗退场之后（见调用方：iOS 在退场中的 Modal 上叠分享单会悄悄不出来） */
    askPartial(r: { count: number; message: string }): Promise<PartialChoice>;
  },
): Promise<ExportResult> {
  const first = currentChatSession();
  if (first === null || !openSessionMatches(target, first)) return { ok: false, message: EXPORT_NOT_READY };
  const sessionId = first.sessionId;
  const same = (): ChatSession | null => {
    const s = currentChatSession();
    return s !== null && s.sessionId === sessionId ? s : null;
  };
  io.onProgress(first.events.length);
  try {
    await runChatExport({
      collect: () =>
        collectFullLog(
          pagerDeps({
            // 翻页期间人退出了这条聊天：再翻就是在别的会话上翻，当失败收口
            loadOlderPage: async () => (same() === null ? { ok: false, message: "已经离开这条聊天" } : await loadOlderPage()),
            storeHasOlder: () => same()?.hasOlder ?? false,
            count: () => same()?.events.length ?? 0,
            onProgress: io.onProgress,
          }),
        ),
      askPartial: io.askPartial,
    });
    const s = same();
    if (s === null) return { ok: false, message: EXPORT_NOT_READY };
    // store 里按 seq 去重升序（insertCloudEvent），现读一份，翻页期间还在长
    const file = new File(Paths.cache, cloudLogFilename(sessionId, Date.now()));
    file.create({ overwrite: true });
    file.write(eventsJsonl(s.events));
    return { ok: true, uri: file.uri, count: s.events.length };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
