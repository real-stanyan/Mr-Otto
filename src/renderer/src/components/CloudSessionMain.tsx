// CloudSessionMain —— 云会话在主区的那一屏（issue #919）。
//
// 之前云会话开在右侧抽屉里（WorkspacePage 内切换渲染）。搬进主区是「和本地会话
// 一致」的另一半：本地会话点侧栏一行就在主区打开，云会话既然也列在侧栏里，就该
// 落在同一块地皮上。离开的方式也因此一致——点侧栏里别的一行（newSession/resume
// 都会先 closeCloudSession），不再有一颗返回键。
//
// 这一层只做三件事：把工作区快照喂给 CloudSessionPage、补发开局卡上那句话、
// 在快照还没到时说一句人话。CloudSessionPage 本身一个字没搬——它已经是"整块
// 内容一起滚"的堆叠流，换个更宽的容器照样成立。

import { useEffect } from "react";
import { useChat } from "../store.js";
import { CloudSessionPage } from "./CloudSessionPage.js";

export function CloudSessionMain() {
  const cs = useChat((s) => s.cloudSession);
  const ws = useChat((s) => s.workspaceGroups.find((g) => g.id === s.cloudSession?.workspaceId) ?? null);
  const selfUid = useChat((s) => s.account.id);
  const pending = useChat((s) => s.cloudPendingFirstMessage);
  const take = useChat((s) => s.takeCloudPendingFirstMessage);
  const seedDraft = useChat((s) => s.seedCloudDraft);
  const cloudSay = useChat((s) => s.cloudSay);
  const refreshGroups = useChat((s) => s.refreshWorkspaceGroups);

  const state = cs?.state ?? null;
  const sessionId = cs?.sessionId ?? null;

  // 进云会话时刷一次快照：agent 名单是别的成员也能改的，而 workspaceGroups
  // 没有推送通道（只在本地改动后重拉）——不刷的话别人新建的那只 @ 不到
  useEffect(() => {
    if (cs?.sessionId) void refreshGroups();
  }, [cs?.sessionId, refreshGroups]);
  // 开局卡上写的那句话，等到连接 ready 才发得出去（主进程的 say() 要求
  // status === "ready"，见 cloudSessionClient 的 requireReady）。
  // **先取后发**：这个 effect 会因为状态变化重跑，take() 把它从 store 里摘掉
  // 之后再 await，才不会发两遍
  //
  // **发失败不吞掉原文**（issue #957 C-I6）：cloudSay 回 false 时把原文摆回
  // 输入框（seedCloudDraft → CloudSessionPage 挂载时取走填进 draft）。开局卡
  // 这时早已卸载，不摆回去那段文字在任何地方都不再存在——用户只看到一行
  // 错误，然后得重打一遍；而 composer 那条入口的纪律正相反（「草稿在发送成功
  // 之后才清」），摆回去就是让它从此归那条纪律管。
  // **旧协议（≤5）里 say 没有回执**——限速/被踢那类拒绝走 error 帧（随后到达，
  // 那时 say() 早已回过 true），不在这条 ok:false 路上，所以这一层只接得住
  // "帧压根没发出去"那一半。协议 6 起的 `say_result` 是根治（ADR-0227 决策 2/6：
  // cloudSessionClient 的 pendingSay 等它，限速/不在籍/内部失败都从这条 ok:false
  // 路回来），这块种草稿的兜底**作为双保险保留**——回执帧本身也可能在传输中丢，
  // 而那时唯一还剩的救济就是这里（同 ADR-0227 已知代价里"第二批兜底原样保留"）
  useEffect(() => {
    if (pending === null || state !== "ready" || sessionId === null) return;
    const text = take();
    if (text === null) return;
    void (async () => {
      // 开局卡那句不 @ 也由名单第一只接（老语义：mentions 缺席）
      const ok = await cloudSay(text);
      if (!ok) seedDraft(sessionId, text);
    })();
  }, [pending, state, sessionId, take, cloudSay, seedDraft]);

  if (cs === null) return null;
  if (ws === null) {
    // 工作区快照还没拉回来（冷启动时序）——不画半张空页，也不假装出错
    return (
      <div className="flex-1 min-w-0 h-full flex items-center justify-center text-[13px] text-muted-foreground">
        正在读取工作区…
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 h-full overflow-y-auto scrollbar-stable">
      {/* 与本地会话同一条居中量尺（会话正文不该铺满一整块宽屏）。
          不传 onBack —— 出口是侧栏，同本地会话 */}
      <div className="mx-auto w-[min(760px,92%)] py-4">
        <CloudSessionPage ws={ws} selfUid={selfUid} />
      </div>
    </div>
  );
}
