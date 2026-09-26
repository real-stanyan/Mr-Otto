// AddAgentPopover —— 群头部那颗「添加智能体」（#1280 A4，ADR-0297）。
//
// 自带触发钮，整块由头部当一个槽位接进去（同 `voiceSlot` 的办法）：Radix 的
// Popover 要求触发器长在自己里面，而头部是个纯展示组件——把开合状态拆到两边去，
// 就得在头部多一格它用不上的状态。
//
// 三条判据：
// ① **只列不在群里的**：已经在群里的那几只列出来，勾与不勾都说不出意思（要移人
//    去群设置，那是另一件事——这颗钮只加不减）。
// ② **回调收到的是变动之后的完整名单**（现有 ∪ 勾的），不是勾的那几只：`chat_update`
//    要的是名单不是「加了谁」，只发勾的等于把群里原来的人全踢了。顺序**跟名册走**
//    （同 `narrowRoster`），勾选先后不该决定「名单第一只」是谁。
// ③ **满了就按不动**，并说清为什么：勾得上第七只的话，那颗「拉进来」按下去必然
//    拿到一句服务端拒绝——此刻它看着是好的，这就是 #722 那颗撒谎的勾。

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { AgentFace } from "./AgentFace.js";
import { agentFaceSlot } from "../../../shared/agentAvatar.js";
import { addChoice, rosterOrder } from "../../../shared/groupEdit.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

export function AddAgentPopover({ ws, current, onConfirm }: {
  ws: WorkspaceSnapshot;
  /** 这个群此刻的名单（已与现存名册求过交集，见 CloudSessionMain） */
  current: readonly string[];
  /** 收变动之后的**完整**名单 */
  onConfirm: (agentIds: string[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // 满员、或者名册里一只都不剩——两种情形下这颗钮都没有事可做，但话不一样：
  // 满员是「这个群装不下了」，没人可加是「你只有这几只」（判据在 shared/groupEdit.ts，与手机群设置同一份）
  const { candidates, room, reason } = addChoice(ws, current);

  const confirm = async (): Promise<void> => {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    const next = rosterOrder(ws, [...current, ...picked]);
    await onConfirm(next);
    setBusy(false);
    setPicked([]);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        // 关了就把草稿丢掉：下次打开时上次勾了一半的选择不该还在（同建群弹窗
        // 把 key 挂在 preset 上的理由）
        if (!v) setPicked([]);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          disabled={reason !== null}
          {...(reason === null ? { title: "往这个群里添加智能体" } : { title: reason })}
        >
          <UserPlus className="size-[13px]" aria-hidden />
          添加智能体
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="max-h-[40vh] overflow-y-auto">
          {candidates.map((a) => {
            const on = picked.includes(a.agentId);
            // 已经勾满剩余名额时，没勾的那几只按不动；勾上的照样取消得了
            const locked = busy || (!on && picked.length >= room);
            return (
              <label
                key={a.agentId}
                className={`flex items-center gap-2 rounded-md px-1.5 py-[5px] select-none ${
                  locked ? "cursor-default opacity-45" : "cursor-pointer hover:bg-foreground/[0.04] active:bg-foreground/[0.07]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked}
                  onChange={() => setPicked((p) => (on ? p.filter((x) => x !== a.agentId) : [...p, a.agentId]))}
                  className="size-[13px] shrink-0 accent-[var(--brand)]"
                  aria-label={a.name}
                />
                <AgentFace slot={agentFaceSlot(ws, a.agentId)} size={20} className="rounded-[5px]" />
                <span className="min-w-0 truncate text-[12px]">{a.name}</span>
              </label>
            );
          })}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border/60 pt-1.5">
          <span className="text-[11px] text-muted-foreground">还能加 {room} 只</span>
          <Button
            size="xs"
            className="press-scale transition-opacity duration-150 ease-out"
            disabled={picked.length === 0 || busy}
            onClick={() => void confirm()}
          >
            拉进来
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
