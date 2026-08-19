// StagedChips — 待发送附件的 chips 行。两个 composer(新会话 / 会话中)共用一份:
// 暂存区是全局状态(store.staged),在哪个 composer 里加的都是同一批东西。

import { useChat } from "../store.js";

export function StagedChips({ className = "" }: { className?: string }) {
  const staged = useChat((s) => s.staged);
  const attachError = useChat((s) => s.attachError);
  const removeStaged = useChat((s) => s.removeStaged);
  if (staged.length === 0 && !attachError) return null;
  return (
    <div className={`flex flex-wrap gap-[6px] items-center ${className}`}>
      {staged.map((a, i) => (
        <span
          className="inline-flex items-center gap-1 bg-foreground/[0.06] rounded-md px-[6px] py-[3px] text-xs text-muted-foreground transition-[opacity,transform] duration-150 ease-[var(--ease-strong)] starting:opacity-0 starting:translate-y-[2px]"
          key={i}
        >
          {a.kind === "image" ? (
            <img className="w-9 h-9 object-cover rounded-sm block" src={a.previewDataUrl} alt={a.ref.name ?? "图片"} />
          ) : (
            <span>
              {a.name}({(a.bytes / 1024).toFixed(0)}KB)
            </span>
          )}
          <button
            type="button"
            className="bg-transparent text-inherit opacity-60 text-[13px] px-[2px] hover:opacity-100"
            title="移除"
            onClick={() => removeStaged(i)}
          >
            ×
          </button>
        </span>
      ))}
      {attachError && <span className="text-err text-xs">{attachError}</span>}
    </div>
  );
}
