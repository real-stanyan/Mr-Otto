// 后台任务的「一直有人盯着」那一层（issue #578）。
//
// 面板搬进右侧槽位之后出现一个新问题：面板关着的时候没人在轮询，也就没人知道
// 又有任务开跑了——而自动开面板恰恰要在那一刻发生。所以轮询和「该不该开面板」
// 从面板组件里搬出来，挂在 App 上常驻；面板只负责画。
//
// 存进 store 的只有 liveBgIds（日志推不出的那一件事，见 shared/backgroundRuns.ts
// 的开头），行本身仍然是 events 的投影——两个读者各自 useMemo，不存第二份。

import { useEffect, useMemo, useRef } from "react";
import { useChat } from "../store.js";
import {
  projectBackgroundRuns,
  hasUndeliveredBackgroundTasks,
  type BackgroundRun,
} from "../../../shared/backgroundRuns.js";
import { panelKeyOf } from "./sidePanel.js";

/** live 集合的重取间隔。它只回答一件事——「started 没配上 completed 的那些，
    进程还活着吗」——而这个答案只在 app 重启那一刻会变，不必跟着秒表刷 */
const LIVE_POLL_MS = 5_000;

/** 当前会话该画哪几行。events + live 名单的纯投影，两个调用方共用 */
export function useBackgroundRuns(): BackgroundRun[] {
  const events = useChat((s) => s.events);
  const liveBgIds = useChat((s) => s.liveBgIds);
  return useMemo(
    () => projectBackgroundRuns(events, new Set(liveBgIds)),
    [events, liveBgIds]
  );
}

/** 当前会话每个后台任务的输出尾巴（issue #772）：taskId ⇒ 尾巴。
    面板画终端要的就是它。空对象是个常量——每次现造一个会让选择器每帧都变 */
export function useBackgroundOutputs(): Readonly<Record<string, string>> {
  const sessionId = useChat((s) => s.sessionId);
  return useChat((s) => (sessionId ? (s.bgOutputBySession[sessionId] ?? NO_OUTPUT) : NO_OUTPUT));
}

const NO_OUTPUT: Readonly<Record<string, string>> = {};

/** 常驻在 App 上的那一份：轮询 live 名单 + 决定要不要自己把面板掀开。
    整个应用只该挂一次（挂两次就是两趟轮询）。 */
export function useBackgroundWatch(): void {
  const sessionId = useChat((s) => s.sessionId);
  const events = useChat((s) => s.events);
  const runs = useBackgroundRuns();

  // 没有候选就一趟 IPC 都不发——绝大多数时间一个后台任务都没有，
  // 不该为了空名单常驻一个轮询
  const hasCandidates = useMemo(() => hasUndeliveredBackgroundTasks(events), [events]);

  useEffect(() => {
    if (!sessionId || !hasCandidates) {
      useChat.getState().setLiveBg(sessionId, []);
      return;
    }
    let alive = true;
    const pull = async () => {
      const live = await window.otter.liveBackgroundTasks(sessionId);
      // 会话切走后回来的那趟结果不能往新会话身上贴
      if (alive) useChat.getState().setLiveBg(sessionId, live);
    };
    void pull();
    const timer = setInterval(() => void pull(), LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId, hasCandidates, events.length]);

  // 「刚从没有变成有」的判据存这儿。带上 sessionId：切进一个本来就有任务在跑的
  // 会话不算「刚开始跑」，不该把面板掀开——那个会话上次开着什么，enterChat 已经
  // 按 panelBySession 还原过了
  const prev = useRef<{ sessionId: string | null; count: number }>({ sessionId: null, count: 0 });

  useEffect(() => {
    const before = prev.current;
    prev.current = { sessionId, count: runs.length };
    if (before.sessionId !== sessionId) return; // 换会话:只播种，不动面板

    const st = useChat.getState();
    // 0 → 有：把面板掀开。**只在槽位空着的时候**——用户正看着终端/文件/Git 图
    // 的时候把他手上的东西换掉，比漏报还讨厌
    if (before.count === 0 && runs.length > 0 && panelKeyOf(st) === null) {
      st.openBgPanel();
      return;
    }
    // 有 → 0：面板里一行都不剩了，自己关上。空面板占着半个屏幕不是信息，是垃圾
    if (before.count > 0 && runs.length === 0 && st.bgPanelOpen) st.closeBgPanel();
  }, [sessionId, runs.length]);
}
