// VoicePickerPopover —— 「拉谁进语音」那个弹层（#1163）。
//
// 两个入口共用一份：输入框左簇那颗语音钮（还没有通话时弹它，钮写「开始语音」，默认
// 全勾——微信群语音默认就是全选）与通话栏上的「加人」（已有通话时预勾当前名单，钮写
// 「更新名单」）。提交的是**整份名单**不是增量（`call` 帧的语义就是「此刻该在通话里的」），
// 服务端复核每个 id、广播 `voice_call_changed`——弹层关掉的判据是回执 ok，通话栏画不画
// 看的是随后落下来的那条事件，不看「我刚点了」。
//
// 一只都不勾时钮禁用：「结束通话」是通话栏上另一颗钮（危险动作单独一处、要二次确认），
// 不让「把名单清空」悄悄等价于结束。

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { agentAvatarSrc } from "../lib/agentAvatar.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { CloudAck } from "../../../shared/shellBridge.js";

export function VoicePickerPopover({
  ws,
  current,
  ready,
  onSubmit,
  onStarted,
  children,
}: {
  ws: WorkspaceSnapshot;
  /** 此刻通话里的 id；null = 还没有通话 */
  current: readonly string[] | null;
  ready: boolean;
  onSubmit: (ids: string[]) => Promise<CloudAck>;
  /** 从无到有开了一场（回执 ok）之后：发起的人自动加入（本机开始听） */
  onStarted?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agents = ws.agents;

  const onOpenChange = (next: boolean): void => {
    if (next) {
      // 每次打开重新种：名单可能变过（别人拉了人 / 建了 agent）
      setSelected(new Set(current ?? agents.map((a) => a.agentId)));
      setError(null);
    }
    setOpen(next);
  };
  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    // 按名单顺序发（服务端按 created_at 升序给的那份）：通话栏的头像顺序才稳
    const r = await onSubmit(agents.map((a) => a.agentId).filter((id) => selected.has(id)));
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    if (current === null) onStarted?.();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[260px] p-2">
        <p className="px-1 pb-1 text-[11px] text-muted-foreground">{current === null ? "拉谁进语音通话" : "通话名单"}</p>
        <div className="flex flex-col gap-0.5" role="group" aria-label="通话成员">
          {agents.map((a) => {
            const on = selected.has(a.agentId);
            return (
              <button
                key={a.agentId}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(a.agentId)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-foreground/[0.06]",
                  !on && "text-muted-foreground"
                )}
              >
                <Avatar className="size-5">
                  <AvatarImage src={agentAvatarSrc(ws, a.agentId)} alt="" />
                  <AvatarFallback className="text-[9px]">{a.name.slice(0, 1)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <Check className={cn("size-3.5", on ? "opacity-100" : "opacity-0")} aria-hidden />
              </button>
            );
          })}
        </div>
        {error && <p className="px-1 pt-1 text-[11px] text-err">{error}</p>}
        <div className="flex justify-end pt-2">
          <Button size="xs" disabled={!ready || busy || selected.size === 0} onClick={() => void submit()}>
            {current === null ? "开始语音" : "更新名单"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
