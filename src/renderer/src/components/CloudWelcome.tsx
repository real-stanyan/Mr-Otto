// CloudWelcome —— 在工作区里开新会话的开局卡（issue #919）。
//
// 维护者要的是「工作区创建会话方式应该和用户本地会话一致」。本地那条路是：侧栏
// 工程组头一颗 ＋ → 主区一张 composer → 写完第一句、发出去才真的建会话。这一屏
// 是它在云那边的对应物，位置（主区正中）、外壳（ComposerBar）、回车即发、
// 空文本发不出去——都逐处对齐 App.tsx 的 Welcome。
//
// **少掉的控件不是漏做**：文件夹、型号、thinking 挡位在云会话里都不是「这一条
// 会话」的属性，而是**工作区**的属性（仓库在 config 帧里由 owner 配，模型 key
// 跟着工作区走见 ADR-0202，云会话本来就没有型号选单）。把它们摆上来会得到三个
// 点了不生效的控件——那比少三个控件糟得多。免审批开关同理：云会话的审批走
// approvalRouter 路由到发起人/owner，不是本机 bypass 那套。
//
// 发出去之后这句话不会立刻上路：主进程的 say() 要求连接已 ready
// （cloudSessionClient 的 requireReady），而建会话 + 进房结束时 runtime 的
// welcome 还在路上。所以 store 把它排进 cloudPendingFirstMessage，由主区那块
// 在 ready 那一刻补发（见 store.ts 该字段的注释）。

import { useState } from "react";
import { ComposerBar, ComposerSend } from "@/components/elements/composer.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Button } from "@/components/ui/button.js";
import { useChat } from "../store.js";

export function CloudWelcome({ workspaceId }: { workspaceId: string }) {
  const name = useChat((s) => s.workspaceGroups.find((g) => g.id === workspaceId)?.name ?? "工作区");
  const error = useChat((s) => s.workspaceGroupsError);
  const createFromDraft = useChat((s) => s.createCloudSessionFromDraft);
  const cancel = useChat((s) => s.cancelCloudDraft);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();

  const launch = async (): Promise<void> => {
    if (!trimmed || busy) return;
    setBusy(true);
    await createFromDraft(workspaceId, trimmed);
    // 不 setBusy(false)：成功的话这个组件已经被主区换掉了；失败的话 store 把
    // cloudDraftWorkspaceId 清了、这一屏同样不在了，错误落在 workspaceGroupsError
    // 上由别处显示。留着 busy 只是防同一次点击里的重入
  };

  return (
    <div className="relative flex-1 min-w-0 h-full flex flex-col items-center justify-center gap-4">
      <div className="flex w-[min(640px,90%)] flex-col items-center gap-1">
        <p className="text-[19px] font-[600] tracking-[-0.01em]">在「{name}」里开一条会话</p>
        {/* 云会话和本地会话最要紧的那点不同，说在开始之前：它不在这台机器上跑 */}
        <p className="text-[12px] text-muted-foreground">
          跑在云端，你关掉 app 它也接着跑；工作区里的人都看得见，也都能插话。
        </p>
      </div>
      <ComposerBar className="focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 w-[min(640px,90%)] text-left transition-colors duration-[120ms]">
        <Textarea
          className="border-none shadow-none resize-none bg-transparent dark:bg-transparent text-foreground text-sm leading-[1.45] min-h-[52px] max-h-[200px] px-3 py-2 focus-visible:ring-0 placeholder:text-foreground/35"
          autoFocus
          rows={2}
          placeholder="要它做什么？不 @ 谁的话由管理员接。回车发送"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void launch();
            }
          }}
        />
        <div className="flex items-center gap-2">
          {/* 出口：开局卡不是死胡同。本地那一屏不需要这颗（侧栏永远在旁边、
              随便点一条会话就走了），这一屏也一样能那么走——但这里是「我刚点了
              ＋，反悔」的最短路径，一颗字钮不占地方 */}
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={cancel}>
            取消
          </Button>
          <span className="flex-1" />
          <ComposerSend
            streaming={false}
            idle={!trimmed || busy}
            disabled={!trimmed || busy}
            className="shrink-0 disabled:pointer-events-none"
            title={trimmed ? "开始会话" : "先写一句话"}
            aria-label="开始会话"
            onClick={() => void launch()}
          />
        </div>
      </ComposerBar>
      {error && <p className="w-[min(640px,90%)] text-[12px] text-err break-words">{error}</p>}
    </div>
  );
}
