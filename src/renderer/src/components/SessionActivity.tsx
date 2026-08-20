// 会话热力图 —— 新会话那一屏底部的一张小卡:这半年你在这儿开过多少会话。
//
// 为什么放在新会话屏:那一屏的语境是"要开始点什么",而"上次是什么时候、多久没碰了"
// 正是这个语境里唯一有用的历史。放进会话中反而是噪音——正在干活的人不看统计。
//
// 选了工程文件夹就只算这个工程的:同一台机器上开着好几个工程,混在一起的那张图
// 说不出"这个工程最近热不热"。

import { useMemo } from "react";

import { ActivityGraph } from "@/components/elements/activity-graph.js";
import { sessionActivity } from "@/lib/sessionActivity.js";
import { useChat } from "../store.js";

export function SessionActivity({
  workspace,
  className,
}: {
  /** 选中的工程文件夹;null = 还没选,算全部 */
  workspace: string | null;
  className?: string;
}) {
  const sessions = useChat((s) => s.sessions);
  const scoped = useMemo(
    () => (workspace === null ? sessions : sessions.filter((s) => s.workspace === workspace)),
    [sessions, workspace],
  );
  // now 每次渲染取一次就够:这张图的粒度是"天",一次渲染里的毫秒差不会换格子。
  // 依赖数组里放 scoped 而不是 Date.now(),否则每帧都是新窗口
  const window = useMemo(() => sessionActivity(scoped, Date.now()), [scoped]);

  // 一个会话都没有就不画:一整片空格子在说"你什么都没干过",
  // 而真相通常是"这台机器刚装好"
  if (window.total === 0) return null;

  return (
    <ActivityGraph
      data={window.data}
      start={window.start}
      end={window.end}
      title={workspace === null ? "会话记录" : "这个工程的会话"}
      total={`${window.total} 个`}
      className={className}
    />
  );
}
