// InstructionsNoticeBanner — 「发现项目指令文件但工作区未信任」的横幅（issue #353）。
//
// 贴在输入框上方（SendErrorBanner 同一摞）：这是开工前要做的决定，不是消息流
// 的一部分。列出发现了哪几份（provenance 先给人看，再由人决定信不信）；
// 「信任并加载」= 跨会话持久 + 当场注入（project_instructions 事件流回时间线），
// 「本次忽略」= 只收横幅，下次在该工作区新建会话会再问。

import { ScrollText, X } from "lucide-react";
import { useChat } from "../store.js";
import { Button } from "@/components/ui/button.js";

export function InstructionsNoticeBanner() {
  const notice = useChat((s) => s.instructionsNoticeBySession[s.sessionId]);
  const trust = useChat((s) => s.trustWorkspace);
  const dismiss = useChat((s) => s.dismissInstructionsNotice);

  if (!notice) return null;

  return (
    <div className="mb-2 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/[0.06] px-3 py-2">
      <ScrollText className="mt-[2px] size-3.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium">发现项目指令文件，但这个工作区还没被信任——未注入</div>
        <div className="mt-[2px] text-muted-foreground">
          {notice.files.map((f) => f.split("/").pop()).join("、")}（
          <span className="font-mono">{notice.workspace}</span>）。
          陌生仓库的指令文件可能包含误导性内容，信任后才会进入模型上下文。
        </div>
        <div className="mt-[6px] flex gap-2">
          <Button size="sm" className="h-6 px-2 text-xs" onClick={() => void trust(notice.sessionId)}>
            信任并加载
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => dismiss(notice.sessionId)}
          >
            本次忽略
          </Button>
        </div>
      </div>
      <button
        type="button"
        aria-label="关闭"
        className="shrink-0 rounded p-[2px] text-foreground/40 hover:bg-foreground/[0.06]"
        onClick={() => dismiss(notice.sessionId)}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
