// 会话搜索(⌘K) —— 用 assistant-ui 的 thread-search element。
//
// 为什么新长一个:侧栏是"按工程分堆的全部会话",堆多了之后找一个具体的会话
// 只能靠翻。搜索是另一条路——记得说过什么,就找得到它在哪。
//
// 侧栏没被换掉:element 的 ThreadList 是一串平铺的标题,而本仓的侧栏还挂着
// 工程分组、删除入口、后台会话的"运行中/等审批"提示 —— 换过去是拿掉三件事
// 换一个更薄的列表。搜索面板则是本仓压根没有的东西,element 几乎整块能用。
//
// 排序不重排:进来的 sessions 已经是"最近动过的工程在上、组内按时间倒序"
// (sessionGroups.ts),element 的分组顺序跟着数组走,所以直接摊平就是对的顺序。

import { useEffect, useMemo, useState } from "react";
import { ThreadSearch } from "@/components/elements/thread-search.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { groupSessionsByWorkspace } from "../sessionGroups.js";
import { useChat } from "../store.js";

/** ⌘K / ⌃K 打开。⌘B 是侧栏、⌃` 是终端,K 是这一带没被占的那个 */
export function useSessionSearchHotkey(): void {
  const setOpen = useChat((s) => s.setSessionSearchOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setOpen(!useChat.getState().sessionSearchOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

export function SessionSearchDialog() {
  const open = useChat((s) => s.sessionSearchOpen);
  const setOpen = useChat((s) => s.setSessionSearchOpen);
  const sessions = useChat((s) => s.sessions);
  const resume = useChat((s) => s.resume);
  const [query, setQuery] = useState("");
  // 高亮的那条(方向键在动它),与"打开哪条"是两件事 —— 见 thread-search 里的本仓改动
  const [activeId, setActiveId] = useState("");

  // 每次打开都从空查询开始、高亮落回当前会话:上一次搜的词跟这一次要找的东西没关系
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveId(useChat.getState().sessionId ?? "");
    }
  }, [open]);

  const threads = useMemo(
    () =>
      groupSessionsByWorkspace(sessions).flatMap((g) =>
        g.sessions.map((s) => ({
          id: s.sessionId,
          // 标题的兜底与侧栏一致:还没发话的会话退回工程名
          title: s.title ?? g.label,
          // 没有"最后一句话"这个投影(列表接口只给条数和时间),
          // 就报条数和日期——比空着强,也不假装有摘要
          preview: `${new Date(s.lastTs).toLocaleDateString()} · ${s.events} 条`,
          group: g.label,
          pinned: false,
        })),
      ),
    [sessions],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* 面板自己就是一张卡(paper + 圆角),Dialog 的外壳去掉边框/内边距,
          免得两层卡片套在一起 */}
      <DialogContent className="max-w-[480px] border-0 bg-transparent p-0 shadow-none">
        <DialogHeader className="sr-only">
          <DialogTitle>搜索会话</DialogTitle>
        </DialogHeader>
        <ThreadSearch
          threads={threads}
          query={query}
          activeId={activeId}
          onQueryChange={setQuery}
          onSelect={setActiveId}
          onOpen={(id) => {
            setOpen(false);
            void resume(id);
          }}
          placeholder="搜索会话"
          emptyLabel={query === "" ? "还没有会话" : `没有会话匹配「${query}」`}
          className="max-h-[60vh] max-w-none overflow-y-auto"
        />
      </DialogContent>
    </Dialog>
  );
}
