// 聊天设置抽屉里的「导出 log」（#1446）：把这条聊天的全部原始事件落成 jsonl。
//
// 只能导出**此刻开着的那条云会话**——渲染层手上只有它的事件（store.cloudSession），
// 没开过的聊天没有日志可导，也不为导出另开一条连接（那会把正在看的会话挤掉，
// 客户端同一时刻只连一条）。所以抽屉传一个 `matches` 说「开着的这条是不是我这条聊天」，
// 不是就禁用并说清去哪儿开。
//
// 聊天走尾巴模式（ADR-0300），进房只有最新一页：导出前先沿用同一个翻页动作把更早的翻齐
// （shared/chatLogExport 的 collectFullLog），没翻齐就问人，不悄悄交一份缺头的日志。
// 落盘走既有的 downloadText + buildCloudLogExport（#1117），渲染层不碰 fs。

import { useCallback, useRef, useState } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { useChat, type CloudSessionState } from "../store.js";
import {
  collectFullLog,
  EXPORT_SWITCHED,
  pagerDeps,
  partialExportText,
  runChatExport,
} from "../../../shared/chatLogExport.js";
import { buildCloudLogExport } from "./cloudExport.js";
import { downloadText } from "./downloadText.js";

export const EXPORT_HINT = "导出这条聊天的全部原始事件（jsonl），含系统提示词";
export const EXPORT_NOT_OPEN = "先打开这条聊天再导出";

export function useExportChatLog(matches: (cs: CloudSessionState) => boolean): {
  /** 按钮上该写的字：忙时「已读 N 条…」，否则「导出 log」 */
  label: string;
  busy: boolean;
  /** 不能点的原因（没开着这条聊天 / 还没连上）；null = 能点 */
  disabledReason: string | null;
  /** 上一次导出没成的原因（会话切走了）；下一次 run 清掉 */
  error: string | null;
  run: () => void;
} {
  const confirm = useConfirm();
  // 只订阅「我这条是不是开着且 ready」这一个布尔：events 每来一条就变，订整个 cloudSession 会让抽屉跟着重渲
  const openId = useChat((s) => {
    const cs = s.cloudSession;
    return cs !== null && cs.state === "ready" && matches(cs) ? cs.sessionId : null;
  });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 同步闸：setState 要到下一次渲染才生效，连点两下能挤进两次导出
  const running = useRef(false);

  const run = useCallback(() => {
    if (openId === null || running.current) return;
    running.current = true;
    setError(null);
    setProgress(useChat.getState().cloudSession?.events.length ?? 0);
    const sessionId = openId;
    const same = (): CloudSessionState | null => {
      const cs = useChat.getState().cloudSession;
      return cs !== null && cs.sessionId === sessionId ? cs : null;
    };
    void (async () => {
      try {
        const outcome = await runChatExport({
          gapNote: () => same()?.gapNote ?? null,
          collect: () =>
            collectFullLog(
              pagerDeps({
                // 翻页期间人切走了别的会话：再翻就是在别人的会话上翻，当失败收口
                loadOlderPage: async () =>
                  same() === null
                    ? { ok: false, message: "聊天已经切换" }
                    : await useChat.getState().loadOlderCloudEvents(),
                storeHasOlder: () => same()?.hasOlder ?? false,
                count: () => same()?.events.length ?? 0,
                onProgress: setProgress,
              }),
            ),
          // useConfirm 只有两个出口：确认 = 就导出这些；取消 / Esc / 点遮罩 = 不导出（停下，不是重试——
          // 持续失败时「关掉弹窗 = 再来一轮」会循环）。重试 = 再点一次这一行，它从已读到的接着翻
          askPartial: async (r) =>
            (await confirm({
              title: partialExportText(r.count, r.message, r.gap),
              description: "可以就用已经读到的这些导出；不导出的话，再点一次「导出 log」会从已读到的接着翻。",
              confirmLabel: "就导出这些",
              cancelLabel: "不导出",
            }))
              ? "export"
              : "cancel",
        });
        if (outcome === "cancel") return;
        const cs = same();
        if (cs === null) {
          setError(EXPORT_SWITCHED);
          return;
        }
        const file = buildCloudLogExport({ sessionId, events: cs.events, exportedTs: Date.now() });
        downloadText(file.filename, file.mime, file.text);
      } finally {
        running.current = false;
        setProgress(null);
      }
    })();
  }, [openId, confirm]);

  return {
    label: progress === null ? "导出 log" : `已读 ${progress} 条…`,
    busy: progress !== null,
    disabledReason: openId === null ? EXPORT_NOT_OPEN : null,
    error,
    run,
  };
}
