// EmojiPicker —— 输入框左下那颗「表情」（#1386 桌面微信式布局）。
//
// 只是往输入框里插字，不是贴图（手机那一份同一张表，`src/shared/emoji.ts`）。三条手感：
// · 点一格**不关面板**：连着插几个是常态（微信也这样），点外面 / Esc 才收；
// · 格子用 mousedown + preventDefault：用 click 的话输入框会先失焦，插进去之后光标落在一个没焦点的框上；
// · 面板从那颗钮长出来（Radix 的 transform-origin），进出场走 app.css 里 popover-content 那一段。

import { Smile } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/lib/utils.js";
import { EMOJI } from "../../../shared/emoji.js";

export function EmojiPicker({
  onPick,
  disabled = false,
  className,
}: {
  onPick: (emoji: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title="表情"
          aria-label="表情"
          className={cn(
            "grid size-8 place-items-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150",
            "hover:bg-foreground/[0.05] hover:text-foreground active:scale-[0.94] disabled:pointer-events-none disabled:opacity-30",
            open && "bg-foreground/[0.05] text-foreground",
            className,
          )}
        >
          <Smile className="size-[18px]" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        // 焦点留在输入框：面板是它的附属，开合都不该把光标抢走
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="w-[312px] p-2"
      >
        <div className="grid grid-cols-8 gap-0.5" role="listbox" aria-label="表情">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => onPick(e)}
              className="grid h-9 place-items-center rounded-md text-[20px] leading-none transition-[background-color,transform] duration-100 hover:bg-foreground/[0.06] active:scale-[0.9]"
            >
              {e}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
